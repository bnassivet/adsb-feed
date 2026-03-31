import type { Positions } from "./types";
import { isColumnar } from "./types";

/** Map viewport bounds. */
export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * Grid-based pixel subsampling — returns indices of visually distinct positions.
 *
 * At a given zoom level, positions that map to the same screen pixel are
 * deduplicated (only the first is kept). Positions outside the viewport bounds
 * are skipped entirely.
 *
 * O(n) algorithm — single pass with Set<number> lookup per position.
 * Returns indices into the original positions array.
 */
export function subsamplePositions(
  positions: Positions,
  zoom: number,
  bounds: MapBounds,
): number[] {
  const len = positions.length;
  if (len === 0) return [];

  // Pixels per degree at this zoom level (Mercator tile math)
  const scale = Math.pow(2, zoom + 8);
  const seen = new Set<number>();
  const indices: number[] = [];

  const col = isColumnar(positions);
  const latArr = col ? positions.lat : null;
  const lngArr = col ? positions.lng : null;

  for (let i = 0; i < len; i++) {
    const lat = col ? latArr![i] : (positions as [number, number, number | null][])[i][0];
    const lng = col ? lngArr![i] : (positions as [number, number, number | null][])[i][1];

    // Skip out-of-bounds
    if (lat < bounds.south || lat > bounds.north || lng < bounds.west || lng > bounds.east) continue;

    // Grid key: combine pixel x,y into single integer
    // Using bitwise XOR with shift to create a unique-enough key
    const px = Math.floor(lng * scale) | 0;
    const py = Math.floor(lat * scale) | 0;
    // Cantor pairing function — collision-free for 32-bit ints
    const key = ((px + py) * (px + py + 1)) / 2 + py;

    if (seen.has(key)) continue;
    seen.add(key);
    indices.push(i);
  }

  return indices;
}
