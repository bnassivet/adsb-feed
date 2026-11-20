#!/usr/bin/env node
/**
 * Phase 1 checks for MapLibre + deck.gl (docs/MAP_ENGINES.md,
 * docs/plans/2026-11-19-map-engine-phase1-bench.md). Pass/fail, not timings:
 *
 * 1. Occlusion: on /bench/occlusion, does terrain or a building hide an
 *    aircraft whose line of sight it blocks, while a twin at the same altitude
 *    with a clear line stays visible? Expected: yes interleaved, no overlaid.
 * 2. Compatibility: deck.gl 9.4 reads `map.transform`, which MapLibre 6 moved.
 *    The same page runs with and without the `exposeTransform` shim; a case
 *    "draws" if showing the visible aircraft changes pixels.
 *
 *   npm run bench:checks                       # build, then both engines
 *   npm run bench:checks -- --no-build --engines webkit
 *
 * Screenshots of every case go to bench/results/checks-<time>/ for a human look.
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { webkit, chromium } from "@playwright/test";
import { RESULTS, FIXTURES, build, serve, chromiumArgs, prepareContext, withTimeout } from "./server.mjs";

function parseArgs(argv) {
  const o = { engines: ["webkit", "chromium"], build: true, gpu: "hardware", timeout: 90_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engines") o.engines = argv[++i].split(",");
    else if (a === "--no-build") o.build = false;
    else if (a === "--gpu") o.gpu = argv[++i];
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Every case: the occlusion scenes with the shim, and the compatibility matrix without it. */
const CASES = [
  ...["terrain", "buildings"].flatMap((scene) => ["interleaved", "overlaid"].map((mode) => ({ scene, mode, shim: true }))),
  ...["flat", "terrain"].flatMap((scene) => ["interleaved", "overlaid"].map((mode) => ({ scene, mode, shim: false }))),
  ...["interleaved", "overlaid"].map((mode) => ({ scene: "flat", mode, shim: true })),
];

/** A drawn aircraft (radius 10 px) changes ~300 px; below this deck did not draw it. */
const DRAWN_PX = 50;
/** Hidden when showing it changes at most this share of what the visible twin changes. */
const HIDDEN_RATIO = 0.1;

async function runCase(browser, base, engine, c, dir, timeout) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareContext(ctx);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  const name = `${engine}-${c.scene}-${c.mode}-${c.shim ? "shim" : "noshim"}`;
  const out = { engine, ...c };
  try {
    await page.goto(`${base}/bench/occlusion/?scene=${c.scene}&mode=${c.mode}&shim=${c.shim ? 1 : 0}`);
    await withTimeout(page.waitForFunction(() => window.__probe || window.__probeError, null, { timeout }), timeout, "probe ready");
    const err = await page.evaluate(() => window.__probeError);
    if (err) throw new Error(err);
    out.info = await page.evaluate(() => window.__probe.info);
    const shots = {};
    for (const which of ["none", "hidden", "visible"]) {
      await page.evaluate((w) => window.__probe.show(w), which);
      const png = await page.screenshot();
      shots[which] = png.toString("base64");
      await writeFile(join(dir, `${name}-${which}.png`), png);
    }
    const diff = (a, b) => page.evaluate(([x, y]) => window.__probe.diff(x, y), [shots[a], shots[b]]);
    out.visiblePx = await diff("none", "visible");
    out.hiddenPx = await diff("none", "hidden");
    out.drawn = out.visiblePx >= DRAWN_PX;
    out.hidden = out.drawn && out.hiddenPx <= HIDDEN_RATIO * out.visiblePx;
  } catch (e) {
    out.error = String(e?.message ?? e).split("\n")[0];
  } finally {
    out.pageErrors = await page.evaluate(() => window.__probeErrors ?? []).catch(() => []);
    out.consoleErrors = consoleErrors.slice(0, 3);
    await ctx.close().catch(() => {});
  }
  return out;
}

/** What each case should show, if the probe found its pair. */
function expectation(r) {
  if (r.scene === "flat") return { drawn: true };
  return { drawn: true, hidden: r.mode === "interleaved" };
}

function verdict(r) {
  if (r.error) return `ERROR: ${r.error}`;
  if (!r.info?.probes) return `NO PROBE (${r.info?.note})`;
  const e = expectation(r);
  const ok = r.drawn === e.drawn && (e.hidden === undefined || r.hidden === e.hidden);
  return ok ? "pass" : "FAIL";
}

const opts = parseArgs(process.argv.slice(2));
if (!(await stat(FIXTURES).catch(() => null))) {
  console.error("bench/fixtures/ is missing: run `npm run bench:fixtures` first.");
  process.exit(1);
}
if (opts.build) build();
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(RESULTS, `checks-${stamp}`);
await mkdir(dir, { recursive: true });

const all = [];
for (const engine of opts.engines) {
  const browser = await { webkit, chromium }[engine].launch({ headless: false, args: engine === "chromium" ? chromiumArgs(opts.gpu) : [] });
  console.log(`\n== ${engine} ${browser.version()}`);
  for (const c of CASES) {
    const r = await runCase(browser, base, engine, c, dir, opts.timeout);
    r.verdict = verdict(r);
    all.push(r);
    const errs = r.pageErrors.length ? ` · page errors: ${r.pageErrors.slice(0, 2).join(" | ")}` : "";
    console.log(`${c.scene.padEnd(9)} ${c.mode.padEnd(11)} ${(c.shim ? "shim" : "no shim").padEnd(7)} visible ${String(r.visiblePx ?? "–").padStart(5)} px · hidden ${String(r.hiddenPx ?? "–").padStart(5)} px · ${r.verdict}${errs}`);
  }
  await browser.close();
}
server.close();

const md = [
  `# MapLibre + deck.gl checks — ${stamp}`,
  "",
  `GPU mode: ${opts.gpu}. Expected: every case draws; terrain/buildings hide the blocked aircraft when interleaved and not when overlaid.`,
  "",
  "| Engine | Scene | Mode | Shim | Visible px | Hidden px | Margins (m, hidden / visible) | Verdict | Page errors |",
  "|---|---|---|---|---:|---:|---|---|---|",
  ...all.map((r) => {
    const p = r.info?.probes;
    const m = p && Number.isFinite(p.hiddenMarginM) ? `${p.hiddenMarginM.toFixed(0)} / +${p.visibleMarginM.toFixed(0)}` : "–";
    return `| ${r.engine} | ${r.scene} | ${r.mode} | ${r.shim ? "yes" : "no"} | ${r.visiblePx ?? "–"} | ${r.hiddenPx ?? "–"} | ${m} | ${r.verdict} | ${(r.pageErrors ?? []).slice(0, 1).join("").slice(0, 120)} |`;
  }),
].join("\n");
await writeFile(join(dir, "checks.json"), JSON.stringify(all, null, 2));
await writeFile(join(dir, "checks.md"), md);
console.log(`\n${md}\n\nWrote ${dir}/`);
process.exit(all.some((r) => r.verdict !== "pass" && !(r.shim === false)) ? 1 : 0);
