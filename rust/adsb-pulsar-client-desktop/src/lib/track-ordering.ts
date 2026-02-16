import type { AircraftTrack } from "./types";

/**
 * Returns a new array with the selected track moved to the last position,
 * so it renders on top of other markers/polylines in Leaflet.
 */
export function orderTracksWithSelectedLast(
  tracks: AircraftTrack[],
  selectedHexIdent: string | null,
): AircraftTrack[] {
  if (!selectedHexIdent) return tracks;
  const idx = tracks.findIndex((t) => t.hex_ident === selectedHexIdent);
  if (idx === -1) return tracks;
  const result = [...tracks];
  const [selected] = result.splice(idx, 1);
  result.push(selected);
  return result;
}
