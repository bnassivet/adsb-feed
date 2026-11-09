#!/usr/bin/env node
/**
 * Map render benchmark driver: current Leaflet vs Leaflet+deck.gl vs MapLibre GL
 * vs OpenLayers WebGL. See docs/plans/2026-11-08-map-render-benchmark.md.
 *
 *   npm run bench                                   # full matrix (long)
 *   npm run bench -- --sizes 10000 --reps 1         # smoke run
 *   npm run bench -- --no-build --engines webkit    # reuse the last build
 *
 * Options: --engines webkit,chromium  --sizes 10000,50000,200000,1000000
 *          --styles dots,line  --scenarios initial,panzoom,live
 *          --variants leaflet,canvas,deckgl,maplibre,openlayers  --reps 5
 *          --timeout 60000  --headless  --no-build
 *
 * Runs HEADED by default: headless Chromium renders WebGL in software
 * (SwiftShader), which would make every GPU variant look slow.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { webkit, chromium } from "@playwright/test";
import { aggregate, toMarkdown, VARIANTS } from "../src/bench/stats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, ".next-bench");
const RESULTS = join(ROOT, "bench", "results");
const MAPLIBRE_DIST = join(ROOT, "node_modules", "maplibre-gl", "dist");

// ---------------------------------------------------------------- options
function parseArgs(argv) {
  const o = {
    engines: ["webkit", "chromium"],
    sizes: [10_000, 50_000, 200_000, 1_000_000],
    styles: ["dots", "line"],
    scenarios: ["initial", "panzoom", "live"],
    variants: [...VARIANTS],
    reps: 5,
    timeout: 60_000,
    headless: false,
    build: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const list = () => argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    if (a === "--engines") o.engines = list();
    else if (a === "--sizes") o.sizes = list().map(Number);
    else if (a === "--styles") o.styles = list();
    else if (a === "--scenarios") o.scenarios = list();
    else if (a === "--variants") o.variants = list();
    else if (a === "--reps") o.reps = Number(argv[++i]);
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--headless") o.headless = true;
    else if (a === "--no-build") o.build = false;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------- build + serve
function build() {
  console.log("Building bench pages (BENCH=1, dist .next-bench)…");
  const r = spawnSync("npx", ["next", "build", "--webpack"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, BENCH: "1", NEXT_DIST_DIR: ".next-bench" },
  });
  if (r.status !== 0) throw new Error("bench build failed");
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

function serve() {
  const server = createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    // MapLibre's worker is a separate file webpack does not emit; serve it from
    // node_modules rather than putting it in public/ (which would ship).
    const root = p.startsWith("/vendor/maplibre/") ? MAPLIBRE_DIST : DIST;
    let file = join(root, root === DIST ? p : p.slice("/vendor/maplibre/".length));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// ---------------------------------------------------------------- one run
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);

const CENTER = { x: 640, y: 400 };

/** Identical input for every variant: four drags, then +2 / -2 zoom levels by double-click. */
async function gesture(page) {
  for (const [dx, dy] of [[300, 0], [0, 200], [-300, 0], [0, -200]]) {
    await page.mouse.move(CENTER.x, CENTER.y);
    await page.mouse.down();
    for (let s = 1; s <= 30; s++) {
      await page.mouse.move(CENTER.x + (dx * s) / 30, CENTER.y + (dy * s) / 30);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
  for (const shift of [false, false, true, true]) {
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.dblclick(CENTER.x, CENTER.y);
    if (shift) await page.keyboard.up("Shift");
    await page.waitForTimeout(700);
  }
}

/**
 * Idle refresh rate just before measuring. A sleeping display or an occluded
 * window throttles requestAnimationFrame for EVERY variant alike (seen: 60 Hz
 * collapsing to ~1 Hz ten minutes into a run), which would pass for a result.
 */
function idleRefreshHz() {
  return new Promise((ok) => {
    const ts = [];
    const tick = (t) => (ts.push(t) < 31 ? requestAnimationFrame(tick) : ok(30_000 / (ts[30] - ts[0])));
    requestAnimationFrame(tick);
  });
}

async function runOne(browser, base, engine, variant, cfg) {
  const { size, style, scenario, rep, timeout } = cfg;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  const mk = (sc, metrics, error) => ({
    variant, engine, size, style, scenario: sc, rep, dnf: !metrics, metrics: metrics ?? {}, ...(error ? { error } : {}),
  });
  const out = [];
  let gpu = null;
  let pageErrors = null;
  let idleHz = null;
  try {
    const pageScenario = scenario === "live" ? "live" : scenario;
    await page.goto(`${base}/bench/${variant}/?size=${size}&style=${style}&scenario=${pageScenario}&seed=${rep + 1}`);
    await withTimeout(page.waitForFunction(() => window.__bench || window.__benchError, null, { timeout }), timeout, "ready");
    const err = await page.evaluate(() => window.__benchError);
    if (err) throw new Error(err);
    gpu = await page.evaluate(() => window.__bench.gpu);
    idleHz = await page.evaluate(idleRefreshHz);

    if (scenario === "live") {
      out.push(mk("live", await withTimeout(page.evaluate(() => window.__bench.live()), timeout, "live")));
    } else {
      const initial = await withTimeout(page.evaluate(() => window.__bench.initial()), timeout, "initial");
      if (scenario === "initial") {
        out.push(mk("initial", initial));
        const heap = await page.evaluate(() => window.__bench.heapMB());
        if (heap !== null) out.push(mk("memory", { heapMB: heap }));
      } else {
        await page.evaluate(() => window.__bench.takeSettles());
        await page.evaluate(() => window.__bench.startFrames());
        await withTimeout(gesture(page), timeout, "gesture");
        const frames = await page.evaluate(() => window.__bench.stopFrames());
        await page.waitForTimeout(300);
        const settles = await page.evaluate(() => window.__bench.takeSettles());
        out.push(mk("panzoom", frames), mk("settle", settles));
      }
    }
    pageErrors = await page.evaluate(() => window.__benchPageErrors ?? null);
  } catch (e) {
    const msg = String(e?.message ?? e).split("\n")[0];
    const scs = scenario === "panzoom" ? ["panzoom", "settle"] : [scenario];
    for (const sc of scs) if (!out.some((r) => r.scenario === sc)) out.push(mk(sc, null, msg));
  } finally {
    await ctx.close().catch(() => {});
  }
  if (consoleErrors.length) out.forEach((r) => (r.consoleErrors = consoleErrors.slice(0, 3)));
  if (pageErrors?.length) out.forEach((r) => (r.pageErrors = pageErrors.slice(0, 3)));
  if (idleHz !== null) out.forEach((r) => (r.idleHz = Math.round(idleHz)));
  return { results: out, gpu };
}

// ---------------------------------------------------------------- main
const opts = parseArgs(process.argv.slice(2));
if (opts.build) build();
// Keep the display awake for the whole run (macOS sleeps it after N minutes,
// which throttles rAF in every browser window).
if (os.platform() === "darwin") spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" }).unref();
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const engines = { webkit, chromium };
const all = [];
const gpus = {};
const started = new Date();

for (const engineName of opts.engines) {
  const browser = await engines[engineName].launch({
    headless: opts.headless,
    args: engineName === "chromium"
      ? ["--js-flags=--expose-gc", "--enable-precise-memory-info", "--ignore-gpu-blocklist", "--enable-gpu", "--window-position=0,0"]
      : [],
  });
  console.log(`\n== ${engineName} ${browser.version()}`);
  for (const scenario of opts.scenarios) {
    for (const style of opts.styles) {
      // live is a fixed workload (500 aircraft), not scaled by size.
      for (const size of scenario === "live" ? [0] : opts.sizes) {
        for (let rep = 0; rep < opts.reps; rep++) {
          // Rotate the order every repetition so no variant always runs first (warm caches, thermals).
          const order = opts.variants.map((_, i) => opts.variants[(i + rep) % opts.variants.length]);
          for (const variant of order) {
            const { results, gpu } = await runOne(browser, base, engineName, variant, {
              size: size || 25_000, style, scenario, rep, timeout: opts.timeout,
            });
            if (gpu) gpus[engineName] = gpu;
            all.push(...results);
            const r = results[0];
            const hz = r.idleHz != null && r.idleHz < 45 ? ` ⚠ idle ${r.idleHz} Hz (throttled?)` : "";
            const summary = r.dnf ? `DNF (${r.error})` : Object.entries(r.metrics).slice(0, 3).map(([k, v]) => `${k}=${Number(v).toFixed(1)}`).join(" ");
            console.log(`${scenario.padEnd(8)} ${style.padEnd(5)} ${String(size || 25_000).padStart(8)} rep${rep} ${variant.padEnd(11)} ${summary}${hz}`);
          }
        }
      }
    }
  }
  await browser.close();
}
server.close();

const rows = aggregate(all);
const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const meta = {
  started: started.toISOString(),
  finished: new Date().toISOString(),
  options: opts,
  host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30) },
  gpu: gpus,
};
await mkdir(RESULTS, { recursive: true });
await writeFile(join(RESULTS, `${stamp}.json`), JSON.stringify({ meta, results: all, aggregate: rows }, null, 2));
const md = [
  `# Map render benchmark — ${meta.started}`,
  "",
  `Host: ${meta.host.cpu}, ${meta.host.cores} cores, ${meta.host.memGB} GB · GPU: ${Object.entries(gpus).map(([e, g]) => `${e}: ${g}`).join("; ")}`,
  `Reps: ${opts.reps} (median shown) · ⚠n = n repetitions did not finish`,
  "",
  toMarkdown(rows),
].join("\n");
await writeFile(join(RESULTS, `${stamp}.md`), md);
console.log(`\n${md}\nWrote bench/results/${stamp}.{json,md}`);
