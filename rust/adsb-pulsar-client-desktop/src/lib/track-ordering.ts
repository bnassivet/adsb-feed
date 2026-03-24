import type { AircraftTrack } from "./types";
import { trackKey } from "./types";

/**
 * Returns a new array with selected tracks moved to the end (last = top layer in Leaflet),
 * preserving relative order within each group.
 */
export function orderTracksWithSelectedLast(
  tracks: AircraftTrack[],
  selectedHexIdents: Set<string>,
): AircraftTrack[] {
  if (selectedHexIdents.size === 0) return tracks;
  const nonSelected: AircraftTrack[] = [];
  const selected: AircraftTrack[] = [];
  for (const t of tracks) {
    if (selectedHexIdents.has(trackKey(t))) {
      selected.push(t);
    } else {
      nonSelected.push(t);
    }
  }
  if (selected.length === 0) return tracks;
  return [...nonSelected, ...selected];
}
