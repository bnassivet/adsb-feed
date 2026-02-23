import type { AircraftTrack, PositionRecord } from "@/lib/types";

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
