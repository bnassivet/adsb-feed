import { describe, it, expect } from "vitest";
import {
  tableToIPC,
  makeTable,
  vectorFromArray,
  Float64,
  Int32,
  Utf8,
  Bool,
  Int64,
} from "apache-arrow";
import { arrowToTracks, arrowToFlightSummaries, arrowToPositionRecords, arrowToRawSbsRecords } from "../arrow-utils";
import { ColumnarPositions, isColumnar } from "../types";
import type { FlightSummary } from "../types";

/**
 * Helper: builds an Arrow IPC buffer matching the schema produced by
 * `get_trajectories_batch_arrow_sync` in storage.rs.
 *
 * Columns: hex_ident, callsign, latitude, longitude, altitude,
 * ground_speed, track, vertical_rate, squawk, is_on_ground,
 * timestamp_ms, flight_id
 */
function buildIPC(
  rows: {
    hex_ident: string;
    callsign: string | null;
    latitude: number;
    longitude: number;
    altitude: number | null;
    ground_speed: number | null;
    track: number | null;
    vertical_rate: number | null;
    squawk: string | null;
    is_on_ground: boolean | null;
    timestamp_ms: bigint;
    flight_id: string;
  }[],
): ArrayBuffer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- makeTable generics don't match Vector types
  const table = makeTable({
    hex_ident: vectorFromArray(rows.map((r) => r.hex_ident), new Utf8()),
    callsign: vectorFromArray(rows.map((r) => r.callsign), new Utf8()),
    latitude: vectorFromArray(rows.map((r) => r.latitude), new Float64()),
    longitude: vectorFromArray(rows.map((r) => r.longitude), new Float64()),
    altitude: vectorFromArray(rows.map((r) => r.altitude), new Float64()),
    ground_speed: vectorFromArray(rows.map((r) => r.ground_speed), new Float64()),
    track: vectorFromArray(rows.map((r) => r.track), new Float64()),
    vertical_rate: vectorFromArray(rows.map((r) => r.vertical_rate), new Float64()),
    squawk: vectorFromArray(rows.map((r) => r.squawk), new Utf8()),
    is_on_ground: vectorFromArray(rows.map((r) => r.is_on_ground), new Bool()),
    timestamp_ms: vectorFromArray(rows.map((r) => r.timestamp_ms), new Int64()),
    flight_id: vectorFromArray(rows.map((r) => r.flight_id), new Utf8()),
  } as any);

  const ipcBytes = tableToIPC(table, "stream");
  return toArrayBuffer(ipcBytes);
}

/** Convert Uint8Array to a clean ArrayBuffer (handles SharedArrayBuffer and offset views). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

const flight1: FlightSummary = {
  hex_ident: "A1B2C3",
  flight_num: 0,
  flight_id: "A1B2C3_0",
  callsign: "UAL123",
  position_count: 2,
  first_seen_ms: 1000,
  last_seen_ms: 2000,
  min_altitude: 30000,
  max_altitude: 35000,
};

const flight2: FlightSummary = {
  hex_ident: "D4E5F6",
  flight_num: 0,
  flight_id: "D4E5F6_0",
  callsign: "DAL456",
  position_count: 1,
  first_seen_ms: 3000,
  last_seen_ms: 3000,
  min_altitude: 20000,
  max_altitude: 20000,
};

function makeRow(
  hex_ident: string,
  flight_id: string,
  lat: number,
  lon: number,
  ts: number,
  alt: number | null = 35000,
) {
  return {
    hex_ident,
    callsign: null as string | null,
    latitude: lat,
    longitude: lon,
    altitude: alt,
    ground_speed: 450 as number | null,
    track: 90 as number | null,
    vertical_rate: 0 as number | null,
    squawk: null as string | null,
    is_on_ground: false as boolean | null,
    timestamp_ms: BigInt(ts),
    flight_id,
  };
}

describe("arrowToTracks", () => {
  it("returns empty array for empty bytes", () => {
    expect(arrowToTracks(new ArrayBuffer(0), [flight1])).toEqual([]);
  });

  it("converts single flight with 2 positions as ColumnarPositions", () => {
    const ipc = buildIPC([
      makeRow("A1B2C3", "A1B2C3_0", 45.5, -73.5, 1000),
      makeRow("A1B2C3", "A1B2C3_0", 45.6, -73.4, 2000),
    ]);

    const tracks = arrowToTracks(ipc, [flight1]);
    expect(tracks).toHaveLength(1);

    const t = tracks[0];
    expect(t.hex_ident).toBe("A1B2C3");
    expect(t.track_id).toBe("A1B2C3_0");
    expect(t.callsign).toBe("UAL123"); // from FlightSummary
    // Positions should be ColumnarPositions, not tuple array
    expect(isColumnar(t.positions)).toBe(true);
    expect(t.positions).toHaveLength(2);
    const pos = t.positions as ColumnarPositions;
    expect(pos.get(0)).toEqual([45.5, -73.5, 35000]);
    expect(pos.get(1)).toEqual([45.6, -73.4, 35000]);
    // Verify raw typed array access
    expect(pos.lat[0]).toBe(45.5);
    expect(pos.lng[1]).toBe(-73.4);
    expect(pos.alt[0]).toBe(35000);
    expect(t.first_seen).toBe(1000);
    expect(t.last_seen).toBe(2000);
    expect(t.message_count).toBe(2);
    // last position's scalar fields
    expect(t.latitude).toBe(45.6);
    expect(t.longitude).toBe(-73.4);
  });

  it("partitions multiple flights correctly with ColumnarPositions", () => {
    const ipc = buildIPC([
      // Flight A1B2C3_0 (2 positions)
      makeRow("A1B2C3", "A1B2C3_0", 45.5, -73.5, 1000),
      makeRow("A1B2C3", "A1B2C3_0", 45.6, -73.4, 2000),
      // Flight D4E5F6_0 (1 position)
      makeRow("D4E5F6", "D4E5F6_0", 40.7, -74.0, 3000, 20000),
    ]);

    const tracks = arrowToTracks(ipc, [flight1, flight2]);
    expect(tracks).toHaveLength(2);

    expect(tracks[0].track_id).toBe("A1B2C3_0");
    expect(isColumnar(tracks[0].positions)).toBe(true);
    expect(tracks[0].positions).toHaveLength(2);
    expect(tracks[0].callsign).toBe("UAL123");

    expect(tracks[1].track_id).toBe("D4E5F6_0");
    expect(isColumnar(tracks[1].positions)).toBe(true);
    expect(tracks[1].positions).toHaveLength(1);
    expect(tracks[1].callsign).toBe("DAL456");
    expect(tracks[1].altitude).toBe(20000);
    // Verify each flight has independent typed arrays (not shared)
    const pos0 = tracks[0].positions as ColumnarPositions;
    const pos1 = tracks[1].positions as ColumnarPositions;
    expect(pos0.lat[0]).toBe(45.5);
    expect(pos1.lat[0]).toBe(40.7);
  });

  it("uses Arrow callsign when FlightSummary callsign is null", () => {
    const flightNoCallsign: FlightSummary = {
      ...flight1,
      callsign: null,
    };

    const row = makeRow("A1B2C3", "A1B2C3_0", 45.5, -73.5, 1000);
    row.callsign = "ARROW_CS";
    const ipc = buildIPC([row]);

    const tracks = arrowToTracks(ipc, [flightNoCallsign]);
    expect(tracks[0].callsign).toBe("ARROW_CS");
  });

  it("handles null altitude as NaN in ColumnarPositions", () => {
    const ipc = buildIPC([
      makeRow("A1B2C3", "A1B2C3_0", 45.5, -73.5, 1000, null),
    ]);

    const tracks = arrowToTracks(ipc, [flight1]);
    const pos = tracks[0].positions as ColumnarPositions;
    // Raw alt array stores NaN for null
    expect(Number.isNaN(pos.alt[0])).toBe(true);
    // get() converts NaN back to null for backward compat
    expect(pos.get(0)[2]).toBeNull();
    expect(tracks[0].altitude).toBeNull();
  });

  it("sets timestamp as ISO string from last position", () => {
    const ipc = buildIPC([
      makeRow("A1B2C3", "A1B2C3_0", 45.5, -73.5, 1704067200000), // 2024-01-01T00:00:00.000Z
    ]);

    const tracks = arrowToTracks(ipc, [flight1]);
    expect(tracks[0].timestamp).toBe("2024-01-01T00:00:00.000Z");
  });
});

// --- arrowToFlightSummaries ---

function buildFlightIPC(
  rows: {
    hex_ident: string; flight_num: number; flight_id: string; callsign: string | null;
    position_count: bigint; first_seen_ms: bigint; last_seen_ms: bigint;
    min_altitude: number | null; max_altitude: number | null;
  }[],
): ArrayBuffer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = makeTable({
    hex_ident: vectorFromArray(rows.map(r => r.hex_ident), new Utf8()),
    flight_num: vectorFromArray(rows.map(r => r.flight_num), new Int32()),
    flight_id: vectorFromArray(rows.map(r => r.flight_id), new Utf8()),
    callsign: vectorFromArray(rows.map(r => r.callsign), new Utf8()),
    position_count: vectorFromArray(rows.map(r => r.position_count), new Int64()),
    first_seen_ms: vectorFromArray(rows.map(r => r.first_seen_ms), new Int64()),
    last_seen_ms: vectorFromArray(rows.map(r => r.last_seen_ms), new Int64()),
    min_altitude: vectorFromArray(rows.map(r => r.min_altitude), new Float64()),
    max_altitude: vectorFromArray(rows.map(r => r.max_altitude), new Float64()),
  } as any);
  return toArrayBuffer(tableToIPC(table, "stream"));
}

describe("arrowToFlightSummaries", () => {
  it("returns empty array for empty bytes", () => {
    expect(arrowToFlightSummaries(new ArrayBuffer(0))).toEqual([]);
  });

  it("converts flight summaries correctly", () => {
    const ipc = buildFlightIPC([
      {
        hex_ident: "A1B2C3", flight_num: 0, flight_id: "A1B2C3_0", callsign: "UAL123",
        position_count: BigInt(42), first_seen_ms: BigInt(1000), last_seen_ms: BigInt(2000),
        min_altitude: 30000, max_altitude: 35000,
      },
      {
        hex_ident: "D4E5F6", flight_num: 1, flight_id: "D4E5F6_1", callsign: null,
        position_count: BigInt(10), first_seen_ms: BigInt(3000), last_seen_ms: BigInt(4000),
        min_altitude: null, max_altitude: null,
      },
    ]);

    const summaries = arrowToFlightSummaries(ipc);
    expect(summaries).toHaveLength(2);

    expect(summaries[0].hex_ident).toBe("A1B2C3");
    expect(summaries[0].flight_id).toBe("A1B2C3_0");
    expect(summaries[0].callsign).toBe("UAL123");
    expect(summaries[0].position_count).toBe(42);
    expect(summaries[0].first_seen_ms).toBe(1000);
    expect(summaries[0].min_altitude).toBe(30000);

    expect(summaries[1].callsign).toBeNull();
    expect(summaries[1].min_altitude).toBeNull();
    expect(summaries[1].flight_num).toBe(1);
  });
});

// --- arrowToPositionRecords ---

describe("arrowToPositionRecords", () => {
  it("returns empty array for empty bytes", () => {
    expect(arrowToPositionRecords(new ArrayBuffer(0))).toEqual([]);
  });

  it("converts position records correctly", () => {
    const ipc = buildIPC([
      makeRow("A1B2C3", "unused", 45.5, -73.5, 1000, 35000),
    ]);

    const records = arrowToPositionRecords(ipc);
    expect(records).toHaveLength(1);
    expect(records[0].hex_ident).toBe("A1B2C3");
    expect(records[0].latitude).toBe(45.5);
    expect(records[0].longitude).toBe(-73.5);
    expect(records[0].altitude).toBe(35000);
    expect(records[0].timestamp_ms).toBe(1000);
    expect(records[0].ground_speed).toBe(450);
  });
});

// --- arrowToRawSbsRecords ---

function buildRawMsgIPC(
  rows: {
    hex_ident: string; msg_type: string; transmission_type: number | null;
    timestamp_ms: bigint; raw_message: string; source_id: string;
  }[],
): ArrayBuffer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = makeTable({
    hex_ident: vectorFromArray(rows.map(r => r.hex_ident), new Utf8()),
    msg_type: vectorFromArray(rows.map(r => r.msg_type), new Utf8()),
    transmission_type: vectorFromArray(rows.map(r => r.transmission_type), new Int32()),
    timestamp_ms: vectorFromArray(rows.map(r => r.timestamp_ms), new Int64()),
    raw_message: vectorFromArray(rows.map(r => r.raw_message), new Utf8()),
    source_id: vectorFromArray(rows.map(r => r.source_id), new Utf8()),
  } as any);
  return toArrayBuffer(tableToIPC(table, "stream"));
}

describe("arrowToRawSbsRecords", () => {
  it("returns empty array for empty bytes", () => {
    expect(arrowToRawSbsRecords(new ArrayBuffer(0))).toEqual([]);
  });

  it("converts raw SBS records correctly", () => {
    const ipc = buildRawMsgIPC([
      {
        hex_ident: "A1B2C3", msg_type: "MSG", transmission_type: 3,
        timestamp_ms: BigInt(1705312800000),
        raw_message: "MSG,3,1,1,A1B2C3,...", source_id: "test",
      },
    ]);

    const records = arrowToRawSbsRecords(ipc);
    expect(records).toHaveLength(1);
    expect(records[0].hex_ident).toBe("A1B2C3");
    expect(records[0].msg_type).toBe("MSG");
    expect(records[0].transmission_type).toBe(3);
    expect(records[0].timestamp_ms).toBe(1705312800000);
    expect(records[0].raw_message).toBe("MSG,3,1,1,A1B2C3,...");
    expect(records[0].timestamp).toBe(""); // not stored in DB
  });

  it("handles null transmission_type", () => {
    const ipc = buildRawMsgIPC([
      {
        hex_ident: "A1B2C3", msg_type: "MSG", transmission_type: null,
        timestamp_ms: BigInt(1000), raw_message: "test", source_id: "src",
      },
    ]);

    const records = arrowToRawSbsRecords(ipc);
    expect(records[0].transmission_type).toBeNull();
  });
});
