/**
 * Converts Arrow IPC bytes (from batch trajectory query) into AircraftTrack[].
 *
 * The IPC stream contains rows from multiple flights, identified by a
 * `flight_id` column added on the Rust side. Rows arrive sorted by
 * (flight_id, timestamp_ms), so we can partition with a single scan.
 */
import { tableFromIPC } from "apache-arrow";
import { ColumnarPositions } from "./types";
import type { AircraftTrack, FlightSummary, PositionRecord, RawSbsRecord } from "./types";

/**
 * Parse Arrow IPC bytes into AircraftTrack[], one per flight_id.
 *
 * @param bytes - IPC stream as ArrayBuffer (binary via tauri::ipc::Response)
 * @param flights - FlightSummary list to attach callsigns to tracks
 * @returns One AircraftTrack per flight, with track_id set to flight_id
 */
export function arrowToTracks(
  bytes: ArrayBuffer,
  flights: FlightSummary[],
): AircraftTrack[] {
  if (bytes.byteLength === 0) return [];

  const table = tableFromIPC(new Uint8Array(bytes));
  const numRows = table.numRows;
  if (numRows === 0) return [];

  // Build flight lookup for callsign enrichment
  const flightMap = new Map<string, FlightSummary>();
  for (const f of flights) {
    flightMap.set(f.flight_id, f);
  }

  // String/boolean columns still need .get(i) — no typed array representation
  const hexCol = table.getChild("hex_ident")!;
  const callsignCol = table.getChild("callsign")!;
  const gsCol = table.getChild("ground_speed")!;
  const trackCol = table.getChild("track")!;
  const vrCol = table.getChild("vertical_rate")!;
  const squawkCol = table.getChild("squawk")!;
  const iogCol = table.getChild("is_on_ground")!;
  const tsCol = table.getChild("timestamp_ms")!;
  const fidCol = table.getChild("flight_id")!;

  // Bulk extract numeric columns as Float64Arrays — 6x faster than per-row .get(i)
  const latCol = table.getChild("latitude")!;
  const lonCol = table.getChild("longitude")!;
  const altCol = table.getChild("altitude")!;

  const allLat = latCol.toArray() as Float64Array;
  const allLng = lonCol.toArray() as Float64Array;
  const allAlt = altCol.toArray() as Float64Array;

  // Patch null altitudes: .toArray() puts 0 for nulls; convert to NaN using validity bitmap
  patchNullsToNaN(altCol, allAlt);

  // Partition rows by flight_id (rows arrive sorted by flight_id, timestamp_ms)
  const tracks: AircraftTrack[] = [];
  let segStart = 0;

  for (let i = 1; i <= numRows; i++) {
    const curFid = i < numRows ? (fidCol.get(i) as string) : null;
    const prevFid = fidCol.get(segStart) as string;

    if (i === numRows || curFid !== prevFid) {
      // Slice typed arrays for this flight segment — .slice() creates owned copies
      // so the Arrow table can be GC'd independently
      const positions = new ColumnarPositions(
        allLat.slice(segStart, i),
        allLng.slice(segStart, i),
        allAlt.slice(segStart, i),
      );

      const lastIdx = i - 1;
      const flight = flightMap.get(prevFid);
      const lastAlt = allAlt[lastIdx];

      const track: AircraftTrack = {
        hex_ident: hexCol.get(lastIdx) as string,
        callsign: flight?.callsign ?? (callsignCol.get(lastIdx) as string | null),
        altitude: Number.isNaN(lastAlt) ? null : lastAlt,
        ground_speed: gsCol.get(lastIdx) as number | null,
        track: trackCol.get(lastIdx) as number | null,
        latitude: allLat[lastIdx],
        longitude: allLng[lastIdx],
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

/**
 * Patch null values in an Arrow Float64 column to NaN in the output typed array.
 * Arrow's .toArray() puts 0 where the validity bitmap says null — we convert those to NaN
 * so ColumnarPositions can use NaN as the null sentinel.
 */
function patchNullsToNaN(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  col: any,
  arr: Float64Array,
): void {
  // Walk Arrow's chunked data — each chunk has its own validity bitmap
  for (const chunk of col.data) {
    const nullCount = chunk.nullCount;
    if (nullCount === 0) continue;

    const offset = chunk.offset;
    const length = chunk.length;
    const nullBitmap = chunk.nullBitmap; // Uint8Array validity bitmap

    if (!nullBitmap) {
      // No bitmap means all-null chunk
      arr.fill(NaN, offset, offset + length);
      continue;
    }

    for (let j = 0; j < length; j++) {
      // Bit is 0 = null, 1 = valid (Arrow convention)
      if (!(nullBitmap[j >> 3] & (1 << (j & 7)))) {
        arr[offset + j] = NaN;
      }
    }
  }
}

/** Parse Arrow IPC bytes into FlightSummary[]. */
export function arrowToFlightSummaries(bytes: ArrayBuffer): FlightSummary[] {
  if (bytes.byteLength === 0) return [];

  const table = tableFromIPC(new Uint8Array(bytes));
  const numRows = table.numRows;
  if (numRows === 0) return [];

  // String columns — must use .get(i)
  const hexCol = table.getChild("hex_ident")!;
  const fidCol = table.getChild("flight_id")!;
  const csCol = table.getChild("callsign")!;

  // Numeric columns — bulk extract as typed arrays
  const fnumCol = table.getChild("flight_num")!;
  const pcCol = table.getChild("position_count")!;
  const fsCol = table.getChild("first_seen_ms")!;
  const lsCol = table.getChild("last_seen_ms")!;
  const minAltCol = table.getChild("min_altitude")!;
  const maxAltCol = table.getChild("max_altitude")!;

  const fnumArr = fnumCol.toArray();   // Int32Array
  const pcArr = pcCol.toArray();       // BigInt64Array
  const fsArr = fsCol.toArray();       // BigInt64Array
  const lsArr = lsCol.toArray();       // BigInt64Array
  const minAltArr = minAltCol.toArray() as Float64Array;
  const maxAltArr = maxAltCol.toArray() as Float64Array;

  // Patch null altitudes to NaN
  patchNullsToNaN(minAltCol, minAltArr);
  patchNullsToNaN(maxAltCol, maxAltArr);

  const results: FlightSummary[] = [];
  for (let i = 0; i < numRows; i++) {
    const minAlt = minAltArr[i];
    const maxAlt = maxAltArr[i];
    results.push({
      hex_ident: hexCol.get(i) as string,
      flight_num: fnumArr[i],
      flight_id: fidCol.get(i) as string,
      callsign: csCol.get(i) as string | null,
      position_count: Number(pcArr[i]),
      first_seen_ms: Number(fsArr[i]),
      last_seen_ms: Number(lsArr[i]),
      min_altitude: Number.isNaN(minAlt) ? null : minAlt,
      max_altitude: Number.isNaN(maxAlt) ? null : maxAlt,
    });
  }
  return results;
}

/** Parse Arrow IPC bytes into PositionRecord[]. */
export function arrowToPositionRecords(bytes: ArrayBuffer): PositionRecord[] {
  if (bytes.byteLength === 0) return [];

  const table = tableFromIPC(new Uint8Array(bytes));
  const numRows = table.numRows;
  if (numRows === 0) return [];

  // String/boolean columns
  const hexCol = table.getChild("hex_ident")!;
  const csCol = table.getChild("callsign")!;
  const sqCol = table.getChild("squawk")!;
  const iogCol = table.getChild("is_on_ground")!;

  // Numeric columns — bulk extract
  const latArr = table.getChild("latitude")!.toArray() as Float64Array;
  const lonArr = table.getChild("longitude")!.toArray() as Float64Array;
  const altCol = table.getChild("altitude")!;
  const gsCol = table.getChild("ground_speed")!;
  const trkCol = table.getChild("track")!;
  const vrCol = table.getChild("vertical_rate")!;
  const tsCol = table.getChild("timestamp_ms")!;

  const altArr = altCol.toArray() as Float64Array;
  const gsArr = gsCol.toArray() as Float64Array;
  const trkArr = trkCol.toArray() as Float64Array;
  const vrArr = vrCol.toArray() as Float64Array;
  const tsArr = tsCol.toArray();  // BigInt64Array

  // Patch nulls to NaN for nullable float columns
  patchNullsToNaN(altCol, altArr);
  patchNullsToNaN(gsCol, gsArr);
  patchNullsToNaN(trkCol, trkArr);
  patchNullsToNaN(vrCol, vrArr);

  const results: PositionRecord[] = [];
  for (let i = 0; i < numRows; i++) {
    const alt = altArr[i];
    const gs = gsArr[i];
    const trk = trkArr[i];
    const vr = vrArr[i];
    results.push({
      hex_ident: hexCol.get(i) as string,
      callsign: csCol.get(i) as string | null,
      latitude: latArr[i],
      longitude: lonArr[i],
      altitude: Number.isNaN(alt) ? null : alt,
      ground_speed: Number.isNaN(gs) ? null : gs,
      track: Number.isNaN(trk) ? null : trk,
      vertical_rate: Number.isNaN(vr) ? null : vr,
      squawk: sqCol.get(i) as string | null,
      is_on_ground: iogCol.get(i) as boolean | null,
      timestamp_ms: Number(tsArr[i]),
    });
  }
  return results;
}

/** Parse Arrow IPC bytes into RawSbsRecord[]. */
export function arrowToRawSbsRecords(bytes: ArrayBuffer): RawSbsRecord[] {
  if (bytes.byteLength === 0) return [];

  const table = tableFromIPC(new Uint8Array(bytes));
  const numRows = table.numRows;
  if (numRows === 0) return [];

  // String columns
  const hexCol = table.getChild("hex_ident")!;
  const mtCol = table.getChild("msg_type")!;
  const rmCol = table.getChild("raw_message")!;
  const siCol = table.getChild("source_id")!;

  // Numeric columns — bulk extract
  const ttCol = table.getChild("transmission_type")!;
  const tsCol = table.getChild("timestamp_ms")!;

  const ttArr = ttCol.toArray() as Int32Array;
  const tsArr = tsCol.toArray();  // BigInt64Array

  // Patch null transmission_type to NaN-like sentinel
  // Int32Array can't hold NaN, so we check validity bitmap directly
  const ttNulls = new Uint8Array(numRows);
  for (const chunk of ttCol.data) {
    const nullBitmap = chunk.nullBitmap;
    if (chunk.nullCount === 0 || !nullBitmap) {
      if (chunk.nullCount > 0) ttNulls.fill(1, chunk.offset, chunk.offset + chunk.length);
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      if (!(nullBitmap[j >> 3] & (1 << (j & 7)))) {
        ttNulls[chunk.offset + j] = 1;
      }
    }
  }

  const results: RawSbsRecord[] = [];
  for (let i = 0; i < numRows; i++) {
    results.push({
      hex_ident: hexCol.get(i) as string,
      msg_type: (mtCol.get(i) as string) ?? "",
      transmission_type: ttNulls[i] ? null : ttArr[i],
      timestamp: "", // not stored in DB, matches existing JSON behavior
      timestamp_ms: Number(tsArr[i]),
      raw_message: rmCol.get(i) as string,
      source_id: (siCol.get(i) as string) ?? "",
    });
  }
  return results;
}
