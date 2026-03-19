import type { AircraftTrack, PositionRecord } from "@/lib/types";

/**
 * Groups PositionRecord rows by hex_ident, then splits each group into
 * separate flights when consecutive positions are separated by > gapMs.
 * Each resulting AircraftTrack gets a track_id of "{hex_ident}_{flightNum}".
 */
export function recordsToFlightTracks(
  records: PositionRecord[],
  gapMs: number = 3_600_000,
): AircraftTrack[] {
  const groups = new Map<string, PositionRecord[]>();
  for (const r of records) {
    const arr = groups.get(r.hex_ident);
    if (arr) arr.push(r);
    else groups.set(r.hex_ident, [r]);
  }

  const tracks: AircraftTrack[] = [];
  for (const [hexIdent, recs] of groups) {
    const sorted = [...recs].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    let flightNum = 0;
    let flightStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      if (i === sorted.length || sorted[i].timestamp_ms - sorted[i - 1].timestamp_ms > gapMs) {
        const flightRecords = sorted.slice(flightStart, i);
        const track = recordsToTrack(flightRecords);
        track.track_id = `${hexIdent}_${flightNum}`;
        tracks.push(track);
        flightNum++;
        flightStart = i;
      }
    }
  }
  return tracks;
}

/**
 * Groups PositionRecord rows by hex_ident and converts each group into
 * an AircraftTrack. Used to bulk-convert DuckDB query results into tracks.
 */
export function recordsToTracks(records: PositionRecord[]): AircraftTrack[] {
  const groups = new Map<string, PositionRecord[]>();
  for (const r of records) {
    const arr = groups.get(r.hex_ident);
    if (arr) arr.push(r);
    else groups.set(r.hex_ident, [r]);
  }
  return Array.from(groups.values()).map(recordsToTrack);
}

/**
 * Converts DuckDB PositionRecord rows for a single aircraft into an AircraftTrack
 * suitable for injection into the existing imported-track pipeline.
 *
 * Records are sorted by timestamp_ms. The latest record's scalar fields
 * (altitude, callsign, etc.) become the track's current state.
 */
export function recordsToTrack(records: PositionRecord[]): AircraftTrack {
  const sorted = [...records].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const last = sorted[sorted.length - 1];
  return {
    hex_ident: last.hex_ident,
    callsign: last.callsign,
    altitude: last.altitude,
    ground_speed: last.ground_speed,
    track: last.track,
    latitude: last.latitude,
    longitude: last.longitude,
    vertical_rate: last.vertical_rate,
    squawk: last.squawk,
    is_on_ground: last.is_on_ground,
    timestamp: new Date(last.timestamp_ms).toISOString(),
    positions: sorted.map(
      (r) => [r.latitude, r.longitude, r.altitude] as [number, number, number | null]
    ),
    first_seen: sorted[0].timestamp_ms,
    last_seen: last.timestamp_ms,
    message_count: sorted.length,
  };
}
