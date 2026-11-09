/**
 * Pure half of a typed-array canvas dot renderer: the alternative to
 * `DotsLayer`'s one-`L.CircleMarker`-per-point approach, which the map bench
 * (docs/MAP_BENCH.md) showed costs ~1 GB and multi-second rebuilds at 1M points.
 *
 * Positions are projected ONCE, at load, into zoom-0 world pixels; drawing at
 * zoom z is then `x * 2^z - pixelOrigin` — no per-frame projection, no objects.
 * Points are counting-sorted into altitude bins so the draw loop issues one
 * `fill()` per colour, not one per point.
 */

/** Altitude bin width. Colour bands are 12,500 ft wide, so 1000 ft bins are visually exact. */
export const ALT_BIN_FT = 1000;
const MAX_BIN = 50_000 / ALT_BIN_FT;
/** Bin id for unknown altitude; always sorted last. */
export const NULL_BIN = -1;

const TILE = 256;
const MAX_LAT = 85.0511287798;

/** EPSG:3857 at Leaflet zoom 0: [0, 256) in both axes, y down. */
export function worldPx(lat: number, lng: number): [number, number] {
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const s = Math.sin((la * Math.PI) / 180);
  const x = TILE * (0.5 + lng / 360);
  const y = TILE * (0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI);
  return [x, y];
}

export interface DotBuckets {
  count: number;
  /** Zoom-0 world pixels, grouped by bin. Float64: Float32 loses sub-pixel precision past zoom ~15. */
  x: Float64Array;
  y: Float64Array;
  /** Bin i occupies [starts[i], starts[i+1]). */
  starts: Uint32Array;
  /** Altitude bin of each bucket (`alt / ALT_BIN_FT`, or NULL_BIN); empty bins omitted. */
  bins: number[];
}

const binOf = (alt: number) =>
  Number.isNaN(alt) ? MAX_BIN + 1 : Math.max(0, Math.min(MAX_BIN, Math.floor(alt / ALT_BIN_FT)));

/** O(n) counting sort by altitude bin; input order kept within a bin. */
export function buildDotBuckets(lat: Float64Array, lng: Float64Array, alt: Float64Array): DotBuckets {
  const n = lat.length;
  const slots = MAX_BIN + 2; // + the null slot
  const counts = new Uint32Array(slots);
  const key = new Uint8Array(n);
  for (let i = 0; i < n; i++) counts[(key[i] = binOf(alt[i]))]++;

  const offset = new Uint32Array(slots);
  const bins: number[] = [];
  const starts: number[] = [0];
  let o = 0;
  for (let k = 0; k < slots; k++) {
    offset[k] = o;
    if (counts[k] === 0) continue;
    o += counts[k];
    bins.push(k === MAX_BIN + 1 ? NULL_BIN : k);
    starts.push(o);
  }

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = offset[key[i]]++;
    [x[j], y[j]] = worldPx(lat[i], lng[i]);
  }
  return { count: n, x, y, starts: Uint32Array.from(starts), bins };
}
