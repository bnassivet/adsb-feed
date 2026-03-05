import type { AircraftTrack } from "./types";

export type SortKey =
  | "callsign"
  | "hex_ident"
  | "altitude"
  | "ground_speed"
  | "squawk"
  | "last_seen"
  | "message_count";

/** Sort a track list by the given key and direction. Nulls sort last. */
export function sortTracks(
  list: AircraftTrack[],
  sortKey: SortKey,
  sortAsc: boolean,
): AircraftTrack[] {
  return [...list].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp =
      typeof av === "string"
        ? av.localeCompare(bv as string)
        : (av as number) - (bv as number);
    return sortAsc ? cmp : -cmp;
  });
}
