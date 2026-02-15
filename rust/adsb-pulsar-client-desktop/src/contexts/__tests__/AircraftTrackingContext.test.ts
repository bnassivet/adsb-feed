import { describe, it, expect } from "vitest";
import { appendPosition } from "../AircraftTrackingContext";
import type { AircraftTrack } from "@/lib/types";

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
    last_seen: Date.now(),
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

  it("caps positions at MAX_POSITIONS (100)", () => {
    const track = makeTrack();
    for (let i = 0; i < 105; i++) {
      appendPosition(track, 45.0 + i * 0.01, -73.0, 30000 + i * 100);
    }
    expect(track.positions.length).toBe(100);
    // First position should be the 6th one added (indices 5-104)
    expect(track.positions[0]).toEqual([45.05, -73.0, 30500]);
  });
});
