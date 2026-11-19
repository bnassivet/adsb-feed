/**
 * Points → one flat Web Mercator coordinate array per 1000 ft altitude bin, so
 * OpenLayers can draw N points with ~50 `MultiPoint` features instead of N
 * `Point` features. Same idea as the canvas variant (src/lib/canvas-dots.ts):
 * the per-point objects, not the drawing, were the cost.
 */
import { toMercator, type Flat } from "./flatten";

/** Bin label for positions with no altitude. */
export const NULL_ALT_BIN = -1;
const BIN_FT = 1000;

export interface AltBin {
  /** Bin floor in feet, or NULL_ALT_BIN. */
  alt: number;
  /** Interleaved x, y in EPSG:3857 — OpenLayers' flat coordinate layout. */
  coords: Float64Array;
}

function binOf(alt: number): number {
  return Number.isNaN(alt) ? NULL_ALT_BIN : Math.floor(alt / BIN_FT) * BIN_FT;
}

export function binByAltitude(f: Flat): AltBin[] {
  // Counting pass, then fill: two linear scans, no per-point allocation.
  const counts = new Map<number, number>();
  for (let i = 0; i < f.count; i++) {
    const b = binOf(f.alt[i]);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const bins = new Map<number, { arr: Float64Array; o: number }>();
  for (const [b, n] of counts) bins.set(b, { arr: new Float64Array(n * 2), o: 0 });
  for (let i = 0; i < f.count; i++) {
    const bin = bins.get(binOf(f.alt[i]))!;
    const [x, y] = toMercator(f.lng[i], f.lat[i]);
    bin.arr[bin.o++] = x;
    bin.arr[bin.o++] = y;
  }
  return [...bins].sort(([a], [b]) => a - b).map(([alt, { arr }]) => ({ alt, coords: arr }));
}
