#!/usr/bin/env node
/**
 * Download the offline fixtures the terrain/buildings variants need (the bench
 * blocks the network). Idempotent: existing files are kept.
 *
 *   npm run bench:fixtures
 *
 * - bench/fixtures/terrarium/{z}/{x}/{y}.png — AWS Open Data Terrarium
 *   elevation tiles, z0–TERRAIN_MAXZOOM over TERRAIN_BBOX.
 * - bench/fixtures/protomaps/{z}/{x}/{y}.mvt — whole OSM vector tiles
 *   (decompressed) read by HTTP range from a Protomaps daily build,
 *   z0–BUILDINGS_MAXZOOM over CITY_BBOX. Licence: ODbL, © OpenStreetMap contributors.
 *
 * Both areas are around the bench's own centre (Montréal), never a receiver.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PMTiles } from "pmtiles";
import { tilesInBbox } from "../src/bench/tiles.ts";
import { TERRAIN_BBOX, TERRAIN_MAXZOOM, CITY_BBOX, BUILDINGS_MAXZOOM } from "../src/bench/maplibre-style.ts";

const OUT = join(resolve(dirname(fileURLToPath(import.meta.url))), "fixtures");
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const BUILDS = "https://build-metadata.protomaps.dev/builds.json";

const exists = (p) => stat(p).then(() => true, () => false);

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function save(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function terrain() {
  const tiles = tilesInBbox(TERRAIN_BBOX, 0, TERRAIN_MAXZOOM);
  let got = 0, bytes = 0;
  await pool(tiles, 8, async ({ z, x, y }) => {
    const path = join(OUT, "terrarium", `${z}`, `${x}`, `${y}.png`);
    if (await exists(path)) return;
    const r = await fetch(`${TERRARIUM}/${z}/${x}/${y}.png`);
    if (!r.ok) throw new Error(`terrarium ${z}/${x}/${y}: HTTP ${r.status}`);
    const b = new Uint8Array(await r.arrayBuffer());
    await save(path, b);
    got++; bytes += b.byteLength;
  });
  console.log(`terrarium: ${tiles.length} tiles (${got} new, ${(bytes / 1e6).toFixed(1)} MB)`);
}

async function buildings() {
  const builds = await (await fetch(BUILDS)).json();
  const key = builds.at(-1).key;
  const pm = new PMTiles(`https://build.protomaps.com/${key}`);
  const tiles = tilesInBbox(CITY_BBOX, 0, BUILDINGS_MAXZOOM);
  let got = 0, bytes = 0, empty = 0;
  await pool(tiles, 8, async ({ z, x, y }) => {
    const path = join(OUT, "protomaps", `${z}`, `${x}`, `${y}.mvt`);
    if (await exists(path)) return;
    const t = await pm.getZxy(z, x, y);
    if (!t) { empty++; return; }
    const b = new Uint8Array(t.data);
    await save(path, b);
    got++; bytes += b.byteLength;
  });
  await save(join(OUT, "protomaps", "SOURCE.txt"), `${key}\nODbL, © OpenStreetMap contributors\n`);
  console.log(`protomaps ${key}: ${tiles.length} tiles (${got} new, ${empty} empty, ${(bytes / 1e6).toFixed(1)} MB)`);
}

await terrain();
await buildings();
