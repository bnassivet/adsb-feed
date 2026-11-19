/**
 * Slippy-map (Web Mercator XYZ) tile maths for the bench's offline fixtures.
 * Pure, so the fixture script (Node) and the variants (browser) agree on which
 * tiles exist.
 */

/** [west, south, east, north] in degrees — the order MapLibre's `bounds` uses. */
export type Bbox = readonly [number, number, number, number];

export interface Tile {
  z: number;
  x: number;
  y: number;
}

const MAX_LAT = 85.0511287798;

export function lngLatToTile(lng: number, lat: number, z: number): Tile {
  const n = 2 ** z;
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const rad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
  return { z, x: clamp(x), y: clamp(y) };
}

/** Every tile touching `bbox`, from `minZoom` to `maxZoom` inclusive. */
export function tilesInBbox(bbox: Bbox, minZoom: number, maxZoom: number): Tile[] {
  const [w, s, e, n] = bbox;
  const out: Tile[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const nw = lngLatToTile(w, n, z);
    const se = lngLatToTile(e, s, z);
    for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({ z, x, y });
  }
  return out;
}
