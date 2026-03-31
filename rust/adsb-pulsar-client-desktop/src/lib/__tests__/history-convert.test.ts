import { describe, it, expect } from "vitest";
import type { PositionRecord } from "@/lib/types";
import { recordsToTrack, recordsToTracks, recordsToFlightTracks } from "@/lib/history-convert";

function makeRecord(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    hex_ident: "ABCDEF",
    callsign: "TEST01",
    latitude: 48.0,
    longitude: 2.0,
    altitude: 10000,
    ground_speed: 250,
    track: 90,
    vertical_rate: 0,
    squawk: "7700",
    is_on_ground: false,
    timestamp_ms: 1_000_000,
    ...overrides,
  };
}

describe("recordsToTrack", () => {
  it("converts a single record to an AircraftTrack", () => {
    const record = makeRecord({ timestamp_ms: 1_000_000 });
    const track = recordsToTrack([record]);
    expect(track.hex_ident).toBe("ABCDEF");
    expect(track.callsign).toBe("TEST01");
    expect(track.latitude).toBe(48.0);
    expect(track.longitude).toBe(2.0);
    expect(track.altitude).toBe(10000);
    expect(track.first_seen).toBe(1_000_000);
    expect(track.last_seen).toBe(1_000_000);
    expect(track.message_count).toBe(1);
    expect(track.positions).toEqual([[48.0, 2.0, 10000]]);
  });

  it("sorts records by timestamp_ms before building positions", () => {
    const r1 = makeRecord({ timestamp_ms: 2_000, latitude: 48.2 });
    const r2 = makeRecord({ timestamp_ms: 1_000, latitude: 48.1 });
    const r3 = makeRecord({ timestamp_ms: 3_000, latitude: 48.3 });
    // Pass in unsorted order
    const track = recordsToTrack([r1, r2, r3]);
    expect(track.first_seen).toBe(1_000);
    expect(track.last_seen).toBe(3_000);
    expect(track.positions).toEqual([
      [48.1, expect.any(Number), expect.anything()],
      [48.2, expect.any(Number), expect.anything()],
      [48.3, expect.any(Number), expect.anything()],
    ]);
  });

  it("uses last (latest) record for scalar fields", () => {
    const r1 = makeRecord({ timestamp_ms: 1_000, altitude: 5000, callsign: "OLD" });
    const r2 = makeRecord({ timestamp_ms: 2_000, altitude: 10000, callsign: "NEW" });
    const track = recordsToTrack([r1, r2]);
    expect(track.altitude).toBe(10000);
    expect(track.callsign).toBe("NEW");
  });

  it("sets message_count to the number of records", () => {
    const records = [
      makeRecord({ timestamp_ms: 1_000 }),
      makeRecord({ timestamp_ms: 2_000 }),
      makeRecord({ timestamp_ms: 3_000 }),
    ];
    const track = recordsToTrack(records);
    expect(track.message_count).toBe(3);
  });

  it("handles null altitude in positions", () => {
    const record = makeRecord({ altitude: null });
    const track = recordsToTrack([record]);
    expect((track.positions as [number, number, number | null][])[0][2]).toBeNull();
  });

  it("uses last record callsign (callers override with richer data)", () => {
    const records = [
      makeRecord({ timestamp_ms: 1_000, callsign: "FLT100" }),
      makeRecord({ timestamp_ms: 2_000, callsign: null }),
    ];
    const track = recordsToTrack(records);
    expect(track.callsign).toBeNull();
  });

  it("generates ISO timestamp string from last timestamp_ms", () => {
    const record = makeRecord({ timestamp_ms: 0 });
    const track = recordsToTrack([record]);
    expect(track.timestamp).toBe(new Date(0).toISOString());
  });
});

describe("recordsToTracks", () => {
  it("returns empty array for empty input", () => {
    expect(recordsToTracks([])).toEqual([]);
  });

  it("groups records by hex_ident into separate tracks", () => {
    const records = [
      makeRecord({ hex_ident: "AAA111", timestamp_ms: 1_000, latitude: 48.0 }),
      makeRecord({ hex_ident: "BBB222", timestamp_ms: 2_000, latitude: 49.0 }),
      makeRecord({ hex_ident: "AAA111", timestamp_ms: 3_000, latitude: 48.5 }),
    ];
    const tracks = recordsToTracks(records);
    expect(tracks).toHaveLength(2);

    const trackA = tracks.find((t) => t.hex_ident === "AAA111");
    const trackB = tracks.find((t) => t.hex_ident === "BBB222");
    expect(trackA).toBeDefined();
    expect(trackB).toBeDefined();
    expect(trackA!.positions).toHaveLength(2);
    expect(trackB!.positions).toHaveLength(1);
  });

  it("preserves correct time ordering within each group", () => {
    const records = [
      makeRecord({ hex_ident: "AAA111", timestamp_ms: 5_000, latitude: 48.5 }),
      makeRecord({ hex_ident: "AAA111", timestamp_ms: 1_000, latitude: 48.0 }),
    ];
    const tracks = recordsToTracks(records);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].first_seen).toBe(1_000);
    expect(tracks[0].last_seen).toBe(5_000);
    const pos = tracks[0].positions as [number, number, number | null][];
    expect(pos[0][0]).toBe(48.0); // earlier record first
    expect(pos[1][0]).toBe(48.5);
  });
});

describe("recordsToFlightTracks", () => {
  it("single flight — positions within gap produce 1 track", () => {
    const records = [
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 1000, latitude: 48.0 }),
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 2000, latitude: 48.1 }),
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 3000, latitude: 48.2 }),
    ];
    const tracks = recordsToFlightTracks(records);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].track_id).toBe("ABCDEF_0");
    expect(tracks[0].positions).toHaveLength(3);
  });

  it("gap splits — gap > threshold produces 2 tracks", () => {
    const records = [
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 1000, latitude: 48.0 }),
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 2000, latitude: 48.1 }),
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 3_603_000, latitude: 48.5 }),
    ];
    const tracks = recordsToFlightTracks(records);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].track_id).toBe("ABCDEF_0");
    expect(tracks[0].positions).toHaveLength(2);
    expect(tracks[1].track_id).toBe("ABCDEF_1");
    expect(tracks[1].positions).toHaveLength(1);
  });

  it("multiple aircraft — each hex_ident segmented independently", () => {
    const records = [
      makeRecord({ hex_ident: "AAA111", timestamp_ms: 1000, latitude: 48.0 }),
      makeRecord({ hex_ident: "BBB222", timestamp_ms: 1500, latitude: 49.0 }),
      makeRecord({ hex_ident: "AAA111", timestamp_ms: 2000, latitude: 48.1 }),
      makeRecord({ hex_ident: "BBB222", timestamp_ms: 2500, latitude: 49.1 }),
    ];
    const tracks = recordsToFlightTracks(records);
    expect(tracks.length).toBeGreaterThanOrEqual(2);
    const hexIdents = tracks.map((t) => t.hex_ident);
    expect(hexIdents).toContain("AAA111");
    expect(hexIdents).toContain("BBB222");
  });

  it("custom gap — smaller gap splits more", () => {
    const records = [
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 0, latitude: 48.0 }),
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 60_000, latitude: 48.1 }),
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 1_860_000, latitude: 48.5 }),
    ];
    // Default gap (1h) — all within 1h, so 1 track
    const defaultTracks = recordsToFlightTracks(records);
    expect(defaultTracks).toHaveLength(1);

    // Custom gap 15min (900_000ms) — 30min gap between 2nd and 3rd splits
    const customTracks = recordsToFlightTracks(records, 900_000);
    expect(customTracks).toHaveLength(2);
  });

  it("preserves callsign per flight segment", () => {
    const records = [
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 1000, callsign: "FLT1", latitude: 48.0 }),
      makeRecord({ hex_ident: "ABCDEF", timestamp_ms: 3_700_000, callsign: "FLT2", latitude: 49.0 }),
    ];
    const tracks = recordsToFlightTracks(records);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].callsign).toBe("FLT1");
    expect(tracks[1].callsign).toBe("FLT2");
  });
});
