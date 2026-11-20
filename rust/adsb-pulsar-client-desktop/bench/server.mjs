/**
 * What the bench drivers share: the BENCH=1 build, the static server (with an
 * optional network profile on fixture tiles), and the browser context every
 * page runs in. Used by run.mjs (measurements) and checks.mjs (occlusion and
 * deck.gl/MapLibre compatibility).
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Link, parseNet } from "../src/bench/net.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = join(ROOT, ".next-bench");
export const RESULTS = join(ROOT, "bench", "results");
export const FIXTURES = join(ROOT, "bench", "fixtures");
// Runtime files the libraries fetch themselves and webpack does not emit. Served
// from node_modules rather than public/ (which would ship).
const VENDOR = {
  "/vendor/maplibre/": join(ROOT, "node_modules", "maplibre-gl", "dist"),
  "/vendor/cesium/": join(ROOT, "node_modules", "cesium", "Build", "Cesium"),
  // Offline terrain and building tiles (`npm run bench:fixtures`).
  "/fixtures/": FIXTURES,
};

export function build() {
  console.log("Building bench pages (BENCH=1, dist .next-bench)…");
  const r = spawnSync("npx", ["next", "build", "--webpack"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, BENCH: "1", NEXT_DIST_DIR: ".next-bench" },
  });
  if (r.status !== 0) throw new Error("bench build failed");
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".ktx2": "image/ktx2", ".mvt": "application/vnd.mapbox-vector-tile" };

/**
 * The network profile fixture tiles are served with. Callers switch it with
 * `setNet(name)` and start each run on an idle link with `resetLink()`.
 */
export const net = { name: "local", profile: parseNet("local"), link: new Link(null) };
export function setNet(name) {
  Object.assign(net, { name, profile: parseNet(name) });
  resetLink();
}
export function resetLink() {
  net.link = new Link(net.profile.mbps);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function serve() {
  const server = createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const prefix = Object.keys(VENDOR).find((k) => p.startsWith(k));
    const root = prefix ? VENDOR[prefix] : DIST;
    let file = join(root, prefix ? p.slice(prefix.length) : p);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      if (prefix === "/fixtures/") {
        // Latency first, then queue on the one shared link (src/bench/net.ts).
        await sleep(net.profile.latencyMs);
        await sleep(net.link.reserve(performance.now(), body.length) - performance.now());
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/** Chromium flags; `software` renders WebGL on the CPU (SwiftShader). */
export function chromiumArgs(gpu = "hardware") {
  return [
    "--js-flags=--expose-gc", "--enable-precise-memory-info", "--window-position=0,0",
    ...(gpu === "software"
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
      : ["--ignore-gpu-blocklist", "--enable-gpu"]),
  ];
}

/** Block the network and stub Tauri, so a bench page measures only itself. */
export async function prepareContext(ctx) {
  // No basemap tiles or agent calls: block every non-loopback http(s) request.
  // Deliberately NOT a catch-all "**/*" route: in WebKit, routing everything
  // also intercepts blob: worker scripts, and OpenLayers' WebGL buffer worker
  // then never starts -- the map renders empty and `rendercomplete` never fires.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
  // The root layout's providers call Tauri. Outside Tauri, give them an invoke
  // that never settles so they stay idle instead of throwing or polling.
  await ctx.addInitScript(() => {
    let id = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++id,
      unregisterCallback: () => {},
      invoke: () => new Promise(() => {}),
      convertFileSrc: (p) => p,
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
}

export const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
