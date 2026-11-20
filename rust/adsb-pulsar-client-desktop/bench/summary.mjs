#!/usr/bin/env node
/**
 * Print every aggregated metric of a bench result, one line per row, where the
 * Markdown report shows only each scenario's primary metric.
 *
 *   npm run bench:summary                       # newest bench/results/*.json
 *   npm run bench:summary -- bench/results/2026-11-19T20-23-34.json
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RESULTS } from "./server.mjs";

let file = process.argv[2];
if (!file) {
  const all = (await readdir(RESULTS)).filter((f) => /^\d.*\.json$/.test(f)).sort();
  file = join(RESULTS, all.at(-1));
}
const { meta, aggregate } = JSON.parse(await readFile(file, "utf8"));
console.log(`${file}\n${JSON.stringify(meta.options)}\n`);
const fmt = (v) => (v === null || v === undefined ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(1));
for (const r of aggregate) {
  const m = Object.entries(r.metrics).map(([k, v]) => `${k}=${fmt(v)}`).join(" ");
  console.log(`${r.engine.padEnd(8)} ${r.scenario.padEnd(8)} ${r.style.padEnd(5)} ${String(r.size).padStart(7)} ${r.variant.padEnd(26)} ${r.net.padEnd(9)} ${m}${r.dnfCount ? ` ⚠${r.dnfCount}` : ""}`);
}
