/** Flat points → deck.gl binary position attribute, optionally with altitude as z (metres). */
import type { Flat } from "./flatten";
import { FEET_TO_M } from "./cesium-geo";

export interface DeckPositions {
  value: Float32Array;
  size: 2 | 3;
}

export function deckPositions(f: Flat, withAltitude: boolean): DeckPositions {
  const size = withAltitude ? 3 : 2;
  const value = new Float32Array(f.count * size);
  for (let i = 0; i < f.count; i++) {
    value[size * i] = f.lng[i];
    value[size * i + 1] = f.lat[i];
    if (withAltitude) value[size * i + 2] = Number.isNaN(f.alt[i]) ? 0 : f.alt[i] * FEET_TO_M;
  }
  return { value, size };
}
