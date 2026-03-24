/**
 * Converts Arrow IPC bytes (from batch trajectory query) into AircraftTrack[].
 *
 * The IPC stream contains rows from multiple flights, identified by a
 * `flight_id` column added on the Rust side. Rows arrive sorted by
 * (flight_id, timestamp_ms), so we can partition with a single scan.
 */
import { tableFromIPC } from "apache-arrow";
import type { AircraftTrack, FlightSummary, PositionRecord, RawSbsRecord } from "./types";

/**
 * Parse Arrow IPC bytes into AircraftTrack[], one per flight_id.
 *
 * @param bytes - IPC stream bytes (Tauri serializes Vec<u8> as number[])
 * @param flights - FlightSummary list to attach callsigns to tracks
 * @returns One AircraftTrack per flight, with track_id set to flight_id
 */
export function arrowToTracks(
  bytes: number[],
  flights: FlightSummary[],
): AircraftTrack[] {
  if (bytes.length === 0) return [];

  const table = tableFromIPC(new Uint8Array(bytes));
  const numRows = table.numRows;
  if (numRows === 0) return [];

  // Build flight lookup for callsign enrichment
  const flightMap = new Map<string, FlightSummary>();
  for (const f of flights) {
    flightMap.set(f.flight_id, f);
  }

  // Get typed column vectors — columnar access avoids per-row object creation
  const hexCol = table.getChild("hex_ident")!;
  const callsignCol = table.getChild("callsign")!;
  const latCol = table.getChild("latitude")!;
  const lonCol = table.getChild("longitude")!;
  const altCol = table.getChild("altitude")!;
  const gsCol = table.getChild("ground_speed")!;
  const trackCol = table.getChild("track")!;
  const vrCol = table.getChild("vertical_rate")!;
  const squawkCol = table.getChild("squawk")!;
  const iogCol = table.getChild("is_on_ground")!;
  const tsCol = table.getChild("timestamp_ms")!;
  const fidCol = table.getChild("flight_id")!;

  // Partition rows by flight_id (rows arrive sorted by flight_id, timestamp_ms)
  const tracks: AircraftTrack[] = [];
  let segStart = 0;

  for (let i = 1; i <= numRows; i++) {
    const curFid = i < numRows ? (fidCol.get(i) as string) : null;
    const prevFid = fidCol.get(segStart) as string;

    if (i === numRows || curFid !== prevFid) {
      // Build track for segment [segStart, i)
      const lastIdx = i - 1;
      const positions: [number, number, number | null][] = [];
      for (let j = segStart; j < i; j++) {
        positions.push([
          latCol.get(j) as number,
          lonCol.get(j) as number,
          altCol.get(j) as number | null,
        ]);
      }

      const flight = flightMap.get(prevFid);

      const track: AircraftTrack = {
        hex_ident: hexCol.get(lastIdx) as string,
        callsign: flight?.callsign ?? (callsignCol.get(lastIdx) as string | null),
        altitude: altCol.get(lastIdx) as number | null,
        ground_speed: gsCol.get(lastIdx) as number | null,
        track: trackCol.get(lastIdx) as number | null,
        latitude: latCol.get(lastIdx) as number | null,
        longitude: lonCol.get(lastIdx) as number | null,
        vertical_rate: vrCol.get(lastIdx) as number | null,
        squawk: squawkCol.get(lastIdx) as string | null,
        is_on_ground: iogCol.get(lastIdx) as boolean | null,
        timestamp: new Date(Number(tsCol.get(lastIdx))).toISOString(),
        positions,
        first_seen: Number(tsCol.get(segStart)),
        last_seen: Number(tsCol.get(lastIdx)),
        message_count: i - segStart,
        track_id: prevFid,
      };

      tracks.push(track);
      segStart = i;
    }
  }

  return tracks;
}

/** Parse Arrow IPC bytes into FlightSummary[]. */
export function arrowToFlightSummaries(bytes: number[]): FlightSummary[] {
  if (bytes.length === 0) return [];

  const table = tableFromIPC(new Uint8Array(bytes));
  const numRows = table.numRows;
  if (numRows === 0) return [];

  const hexCol = table.getChild("hex_ident")!;
  const fnumCol = table.getChild("flight_num")!;
  const fidCol = table.getChild("flight_id")!;
  const csCol = table.getChild("callsign")!;
  const pcCol = table.getChild("position_count")!;
  const fsCol = table.getChild("first_seen_ms")!;
  const lsCol = table.getChild("last_seen_ms")!;
  const minAltCol = table.getChild("min_altitude")!;
  const maxAltCol = table.getChild("max_altitude")!;

  const results: FlightSummary[] = [];
  for (let i = 0; i < numRows; i++) {
    results.push({
      hex_ident: hexCol.get(i) as string,
      flight_num: Number(fnumCol.get(i)),
      flight_id: fidCol.get(i) as string,
      callsign: csCol.get(i) as string | null,
      position_count: Number(pcCol.get(i)),
      first_seen_ms: Number(fsCol.get(i)),
      last_seen_ms: Number(lsCol.get(i)),
      min_altitude: minAltCol.get(i) as number | null,
      max_altitude: maxAltCol.get(i) as number | null,
    });
  }
  return results;
}

/** Parse Arrow IPC bytes into PositionRecord[]. */
export function arrowToPositionRecords(bytes: number[]): PositionRecord[] {
  if (bytes.length === 0) return [];

  const table = tableFromIPC(new Uint8Array(bytes));
  const numRows = table.numRows;
  if (numRows === 0) return [];

  const hexCol = table.getChild("hex_ident")!;
  const csCol = table.getChild("callsign")!;
  const latCol = table.getChild("latitude")!;
  const lonCol = table.getChild("longitude")!;
  const altCol = table.getChild("altitude")!;
  const gsCol = table.getChild("ground_speed")!;
  const trkCol = table.getChild("track")!;
  const vrCol = table.getChild("vertical_rate")!;
  const sqCol = table.getChild("squawk")!;
  const iogCol = table.getChild("is_on_ground")!;
  const tsCol = table.getChild("timestamp_ms")!;

  const results: PositionRecord[] = [];
  for (let i = 0; i < numRows; i++) {
    results.push({
      hex_ident: hexCol.get(i) as string,
      callsign: csCol.get(i) as string | null,
      latitude: latCol.get(i) as number,
      longitude: lonCol.get(i) as number,
      altitude: altCol.get(i) as number | null,
      ground_speed: gsCol.get(i) as number | null,
      track: trkCol.get(i) as number | null,
      vertical_rate: vrCol.get(i) as number | null,
      squawk: sqCol.get(i) as string | null,
      is_on_ground: iogCol.get(i) as boolean | null,
      timestamp_ms: Number(tsCol.get(i)),
    });
  }
  return results;
}

/** Parse Arrow IPC bytes into RawSbsRecord[]. */
export function arrowToRawSbsRecords(bytes: number[]): RawSbsRecord[] {
  if (bytes.length === 0) return [];

  const table = tableFromIPC(new Uint8Array(bytes));
  const numRows = table.numRows;
  if (numRows === 0) return [];

  const hexCol = table.getChild("hex_ident")!;
  const mtCol = table.getChild("msg_type")!;
  const ttCol = table.getChild("transmission_type")!;
  const tsCol = table.getChild("timestamp_ms")!;
  const rmCol = table.getChild("raw_message")!;
  const siCol = table.getChild("source_id")!;

  const results: RawSbsRecord[] = [];
  for (let i = 0; i < numRows; i++) {
    results.push({
      hex_ident: hexCol.get(i) as string,
      msg_type: (mtCol.get(i) as string) ?? "",
      transmission_type: ttCol.get(i) as number | null,
      timestamp: "", // not stored in DB, matches existing JSON behavior
      timestamp_ms: Number(tsCol.get(i)),
      raw_message: rmCol.get(i) as string,
      source_id: (siCol.get(i) as string) ?? "",
    });
  }
  return results;
}
