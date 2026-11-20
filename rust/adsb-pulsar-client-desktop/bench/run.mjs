#!/usr/bin/env node
/**
 * Map render benchmark driver: current Leaflet vs Leaflet+deck.gl vs MapLibre GL
 * vs OpenLayers WebGL (three ways) vs Cesium. See also docs/MAP_ENGINES.md. See docs/plans/2026-11-08-map-render-benchmark.md.
 *
 *   npm run bench                                   # full matrix (long)
 *   npm run bench -- --sizes 10000 --reps 1         # smoke run
 *   npm run bench -- --no-build --engines webkit    # reuse the last build
 *
 * Options: --engines webkit,chromium  --sizes 10000,50000,200000,1000000
 *          --styles dots,line  --scenarios initial,panzoom,live
 *          --variants leaflet,canvas,deckgl,maplibre,openlayers,
 *            openlayers-noindex,openlayers-binned,openlayers-deckgl,cesium,
 *            maplibre-deckgl,maplibre-deckgl-3d,maplibre-deckgl-3d-il,
 *            maplibre-deckgl-terrain,maplibre-deckgl-city,
 *            maplibre-deckgl-buildings  --reps 5
 *          --timeout 60000  --headless  --no-build
 *          --net local,broadband,dsl,mobile   (tile latency + bandwidth, src/bench/net.ts)
 *          --gpu hardware|software            (software = SwiftShader, Chromium only)
 *          --dpr 2                            (device pixel ratio: 2 = Retina)
 *          --cpu-throttle 4                   (CDP CPU slowdown, Chromium only)
 *
 * Phase 1 of docs/MAP_ENGINES.md (docs/plans/2026-11-19-map-engine-phase1-bench.md)
 * added --net, --gpu, --dpr and --cpu-throttle as proxies for a slower network
 * and a weaker machine. --net throttles /fixtures/ tiles only, so it changes
 * nothing for variants that load no tiles.
 *
 * The terrain, city and buildings variants read offline tiles from
 * bench/fixtures/ (`npm run bench:fixtures`, once).
 *
 * Runs HEADED by default: headless Chromium renders WebGL in software
 * (SwiftShader), which would make every GPU variant look slow.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { webkit, chromium } from "@playwright/test";
import { aggregate, toMarkdown, VARIANTS } from "../src/bench/stats.ts";
import { parseNet } from "../src/bench/net.ts";
import {
  RESULTS, FIXTURES, build, serve, net, setNet, resetLink, chromiumArgs, prepareContext, withTimeout,
} from "./server.mjs";

/** Variants that read /fixtures/; the run refuses to start without them. */
const NEEDS_FIXTURES = ["maplibre-deckgl-terrain", "maplibre-deckgl-city", "maplibre-deckgl-buildings"];

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
    nets: ["local"],
    gpu: "hardware",
    dpr: 1,
    cpuThrottle: 1,
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
    else if (a === "--net") o.nets = list();
    else if (a === "--gpu") o.gpu = argv[++i];
    else if (a === "--dpr") o.dpr = Number(argv[++i]);
    else if (a === "--cpu-throttle") o.cpuThrottle = Number(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  o.nets.forEach(parseNet); // fail before building, not halfway through
  if (!["hardware", "software"].includes(o.gpu)) throw new Error(`--gpu: hardware or software, not ${o.gpu}`);
  if ((o.gpu === "software" || o.cpuThrottle !== 1) && o.engines.some((e) => e !== "chromium")) {
    throw new Error("--gpu software and --cpu-throttle are Chromium only: add --engines chromium");
  }
  return o;
}

// ---------------------------------------------------------------- one run
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: cfg.dpr });
  resetLink(); // each run starts on an idle link
  await prepareContext(ctx);
  const page = await ctx.newPage();
  if (cfg.cpuThrottle !== 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cfg.cpuThrottle });
  }
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  const mk = (sc, metrics, error) => ({
    variant, engine, size, style, scenario: sc, rep, net: net.name, dnf: !metrics, metrics: metrics ?? {}, ...(error ? { error } : {}),
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
        // Tiles still in flight when the gesture ends (null: the variant loads none).
        const idleMs = await withTimeout(page.evaluate(() => window.__bench.idleMs()), timeout, "idle");
        await page.waitForTimeout(300);
        const settles = await page.evaluate(() => window.__bench.takeSettles());
        out.push(mk("panzoom", frames), mk("settle", idleMs === null ? settles : { ...settles, idleMs }));
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
if (opts.variants.some((v) => NEEDS_FIXTURES.includes(v)) && !(await stat(FIXTURES).catch(() => null))) {
  console.error("bench/fixtures/ is missing: run `npm run bench:fixtures` first (terrain and building tiles).");
  process.exit(1);
}
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
    args: engineName === "chromium" ? chromiumArgs(opts.gpu) : [],
  });
  console.log(`\n== ${engineName} ${browser.version()}`);
  for (const netName of opts.nets) {
  setNet(netName);
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
              dpr: opts.dpr, cpuThrottle: opts.cpuThrottle,
            });
            if (gpu) gpus[engineName] = gpu;
            all.push(...results);
            const r = results[0];
            const hz = r.idleHz != null && r.idleHz < 45 ? ` ⚠ idle ${r.idleHz} Hz (throttled?)` : "";
            const summary = r.dnf ? `DNF (${r.error})` : Object.entries(r.metrics).slice(0, 3).map(([k, v]) => `${k}=${Number(v).toFixed(1)}`).join(" ");
            console.log(`${netName.padEnd(9)} ${scenario.padEnd(8)} ${style.padEnd(5)} ${String(size || 25_000).padStart(8)} rep${rep} ${variant.padEnd(11)} ${summary}${hz}`);
          }
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
  `GPU mode: ${opts.gpu} · DPR ${opts.dpr} · CPU throttle ×${opts.cpuThrottle} · nets: ${opts.nets.join(", ")}`,
  "",
  toMarkdown(rows),
].join("\n");
await writeFile(join(RESULTS, `${stamp}.md`), md);
console.log(`\n${md}\nWrote bench/results/${stamp}.{json,md}`);
