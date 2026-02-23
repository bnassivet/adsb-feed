import { describe, it, expect } from "vitest";
import type { PositionRecord } from "@/lib/types";
import { recordsToTrack } from "@/lib/history-convert";

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
    expect(track.positions[0][2]).toBeNull();
  });

  it("generates ISO timestamp string from last timestamp_ms", () => {
    const record = makeRecord({ timestamp_ms: 0 });
    const track = recordsToTrack([record]);
    expect(track.timestamp).toBe(new Date(0).toISOString());
  });
});
