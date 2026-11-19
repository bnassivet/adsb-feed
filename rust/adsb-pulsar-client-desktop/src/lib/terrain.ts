/**
 * Ground height and sea depth at a point, from Rust (`src-tauri/src/terrain.rs`):
 * Terrarium elevation tiles for the ground, EMODnet for the depth. Used by
 * "What's here?" and by the selected aircraft's height above ground.
 */

export const M_TO_FT = 3.28084;

export interface Depth {
  avgM: number;
  minM: number | null;
  maxM: number | null;
}

export interface WhatIsHereResult {
  /** Metres; 0 at sea. */
  elevationM: number | null;
  elevationError: string | null;
  depth: Depth | null;
  depthError: string | null;
}

/** Feet above the surface: the ground, or the sea where the ground is at or below 0. */
export function heightAboveGroundFt(altitudeFt: number, groundM: number): number {
  return Math.round(altitudeFt - Math.max(groundM, 0) * M_TO_FT);
}

/** ~200 m cells: the ground under a moving aircraft is asked once per cell. */
const KEY_DEG = 0.002;
export const groundQueryKey = (lat: number, lng: number) =>
  `${Math.round(lat / KEY_DEG)},${Math.round(lng / KEY_DEG)}`;

/** The centre of a key's cell (within ~100 m of any point that gave the key). */
export function groundQueryPoint(key: string): { lat: number; lng: number } {
  const [i, j] = key.split(",").map(Number);
  return { lat: i * KEY_DEG, lng: j * KEY_DEG };
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const metres = (m: number) => Math.abs(m).toFixed(1);

/** Plain lines for the "What's here?" box. */
export function describeHere(r: WhatIsHereResult): string[] {
  const lines: string[] = [];
  if (r.elevationError) lines.push(`Ground height unavailable: ${r.elevationError}`);
  else if (r.elevationM != null && r.elevationM > 0) lines.push(`Ground ${int(r.elevationM)} m (${int(r.elevationM * M_TO_FT)} ft)`);
  if (r.depthError) lines.push(`Sea depth unavailable: ${r.depthError}`);
  else if (r.depth) {
    const { avgM, minM, maxM } = r.depth;
    // min is the deepest (most negative): shallow–deep reads naturally.
    const range = minM != null && maxM != null ? ` (${metres(maxM)}–${metres(minM)} m)` : "";
    lines.push(`Sea depth ${metres(avgM)} m${range}`);
  }
  if (lines.length === 0) lines.push("Sea level");
  return lines;
}
