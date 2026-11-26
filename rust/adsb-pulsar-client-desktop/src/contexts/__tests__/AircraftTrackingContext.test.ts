import { describe, it, expect } from "vitest";
import { appendPosition, mergePositionInto, trackKey } from "../AircraftTrackingContext";
import type { AircraftTrack, AircraftPosition } from "@/lib/types";

function makeTrack(overrides: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "A1B2C3",
    callsign: "TEST123",
    altitude: 35000,
    ground_speed: 450,
    track: 90,
    latitude: 45.5,
    longitude: -73.5,
    vertical_rate: 0,
    squawk: "1234",
    is_on_ground: false,
    timestamp: "2024-01-15 10:30:00",
    positions: [],
    first_seen: Date.now(),
    last_seen: Date.now(),
    message_count: 0,
    ...overrides,
  };
}

describe("appendPosition", () => {
  it("stores [lat, lng, altitude] tuple", () => {
    const track = makeTrack();
    appendPosition(track, 45.5, -73.5, 35000);
    expect(track.positions).toEqual([[45.5, -73.5, 35000]]);
  });

  it("stores [lat, lng, null] when altitude is null", () => {
    const track = makeTrack();
    appendPosition(track, 45.5, -73.5, null);
    expect(track.positions).toEqual([[45.5, -73.5, null]]);
  });

  it("caps positions at MAX_POSITIONS (100_000)", () => {
    const track = makeTrack();
    const MAX = 100_000;
    const OVER = 5;
    for (let i = 0; i < MAX + OVER; i++) {
      appendPosition(track, 45.0 + i * 0.0001, -73.0, 30000 + i);
    }
    expect(track.positions.length).toBe(MAX);
    // Oldest positions were shifted out — first position should be the (OVER+1)th added
    expect((track.positions as [number, number, number | null][])[0][0]).toBeCloseTo(45.0 + OVER * 0.0001);
  });
});

function makePosition(hex: string, overrides: Partial<AircraftPosition> = {}): AircraftPosition {
  return {
    hex_ident: hex,
    callsign: null,
    altitude: null,
    ground_speed: null,
    track: null,
    latitude: null,
    longitude: null,
    vertical_rate: null,
    squawk: null,
    is_on_ground: null,
    timestamp: "2024-01-15 10:30:00",
    message_count: 1,
    ...overrides,
  };
}

describe("mergePositionInto — message_count", () => {
  it("accumulates message_count from incoming position", () => {
    const track = makeTrack({ message_count: 10 });
    mergePositionInto(track, makePosition("A1B2C3", { message_count: 5 }), Date.now());
    expect(track.message_count).toBe(15);
  });

  it("accumulates across multiple merges", () => {
    const track = makeTrack({ message_count: 0 });
    mergePositionInto(track, makePosition("A1B2C3", { message_count: 3 }), Date.now());
    mergePositionInto(track, makePosition("A1B2C3", { message_count: 7 }), Date.now());
    expect(track.message_count).toBe(10);
  });
});

describe("trackKey", () => {
  it("returns track_id when set", () => {
    const track = makeTrack({ track_id: "A1B2C3_1" });
    expect(trackKey(track)).toBe("A1B2C3_1");
  });

  it("returns hex_ident when track_id is undefined", () => {
    const track = makeTrack();
    expect(trackKey(track)).toBe("A1B2C3");
  });

  it("allows multiple tracks with same hex_ident but different track_id to coexist in Map", () => {
    const map = new Map<string, AircraftTrack>();
    const track1 = makeTrack({ track_id: "A1B2C3_0", callsign: "FLT1" });
    const track2 = makeTrack({ track_id: "A1B2C3_1", callsign: "FLT2" });
    map.set(trackKey(track1), track1);
    map.set(trackKey(track2), track2);
    expect(map.size).toBe(2);
    expect(map.get("A1B2C3_0")?.callsign).toBe("FLT1");
    expect(map.get("A1B2C3_1")?.callsign).toBe("FLT2");
  });

  it("tracks without track_id collapse to same key in Map", () => {
    const map = new Map<string, AircraftTrack>();
    const track1 = makeTrack({ callsign: "FLT1" });
    const track2 = makeTrack({ callsign: "FLT2" });
    map.set(trackKey(track1), track1);
    map.set(trackKey(track2), track2);
    expect(map.size).toBe(1); // same hex_ident = same key
    expect(map.get("A1B2C3")?.callsign).toBe("FLT2"); // last write wins
  });
});

describe("position_times (per-position timestamps)", () => {
  it("appendPosition records the time beside the position", () => {
    const track = makeTrack({ position_times: [] });
    appendPosition(track, 45.5, -73.5, 35000, 1_000);
    appendPosition(track, 45.6, -73.6, 35100, 2_000);
    expect(track.position_times).toEqual([1_000, 2_000]);
  });

  it("drops the oldest time with the oldest position at the cap", () => {
    const track = makeTrack({ position_times: [] });
    const MAX = 100_000;
    for (let i = 0; i < MAX + 3; i++) appendPosition(track, 45, -73, 30000, i);
    expect(track.position_times).toHaveLength(MAX);
    expect(track.position_times![0]).toBe(3);
  });

  it("does not start a times array a track never had (it would be out of step)", () => {
    const track = makeTrack({ positions: [[45, -73, 30000]] });
    appendPosition(track, 45.1, -73.1, 30000, 1_000);
    expect(track.position_times).toBeUndefined();
  });

  it("mergePositionInto stamps the position with its message's generated time, not the flush", () => {
    const track = makeTrack({ position_times: [] });
    mergePositionInto(track, makePosition("A1B2C3", { latitude: 47, longitude: -2, position_time_ms: 6_123 }), 7_000);
    mergePositionInto(track, makePosition("A1B2C3", { latitude: null, longitude: null }), 8_000);
    expect(track.position_times).toEqual([6_123]);
  });

  it("records NaN, not the flush time, for a position that came without one", () => {
    const track = makeTrack({ position_times: [] });
    mergePositionInto(track, makePosition("A1B2C3", { latitude: 47, longitude: -2 }), 7_000);
    expect(track.position_times).toHaveLength(1);
    expect(Number.isNaN(track.position_times![0])).toBe(true);
  });
});

describe("mergePositionInto — last_position_ms", () => {
  // The OpenSky gap rule measures how long a track has gone without a POSITION.
  // last_seen moves on every message (callsign, speed...), so it cannot.
  it("is stamped by a message carrying a position", () => {
    const track = makeTrack();
    mergePositionInto(track, makePosition("A1B2C3", { latitude: 47, longitude: -2 }), 1_000);
    expect(track.last_position_ms).toBe(1_000);
  });

  it("is left alone by a message without one", () => {
    const track = makeTrack({ last_position_ms: 1_000 });
    mergePositionInto(track, makePosition("A1B2C3", { latitude: null, longitude: null }), 5_000);
    expect(track.last_position_ms).toBe(1_000);
    expect(track.last_seen).toBe(5_000);
  });
});
