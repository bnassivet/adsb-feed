import { describe, it, expect } from "vitest";
import { matchesFilters } from "../useAircraftTracks";
import type { AircraftTrack, Filters } from "@/lib/types";
import { DEFAULT_FILTERS } from "@/lib/types";

function makeTrack(overrides: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "A1B2C3",
    callsign: "AIR123",
    altitude: 35000,
    ground_speed: 450,
    track: 90,
    latitude: 45.5,
    longitude: -73.5,
    vertical_rate: 0,
    squawk: "1234",
    is_on_ground: false,
    timestamp: "2024-01-15 10:30:00",
    positions: [[45.5, -73.5, 35000]],
    first_seen: Date.now(),
    last_seen: Date.now(),
    message_count: 0,
    ...overrides,
  };
}

describe("matchesFilters", () => {
  it("passes all tracks with default filters", () => {
    const track = makeTrack();
    expect(matchesFilters(track, DEFAULT_FILTERS)).toBe(true);
  });

  it("filters by callsign substring", () => {
    const track = makeTrack({ callsign: "AIR123" });
    const filters: Filters = { ...DEFAULT_FILTERS, callsign: "AIR" };
    expect(matchesFilters(track, filters)).toBe(true);
  });

  it("matches hex_ident when callsign filter used", () => {
    const track = makeTrack({ hex_ident: "A1B2C3", callsign: null });
    const filters: Filters = { ...DEFAULT_FILTERS, callsign: "A1B2" };
    expect(matchesFilters(track, filters)).toBe(true);
  });

  it("callsign filter is case insensitive", () => {
    const track = makeTrack({ callsign: "AIR123" });
    const filters: Filters = { ...DEFAULT_FILTERS, callsign: "air" };
    expect(matchesFilters(track, filters)).toBe(true);
  });

  it("filters by altitude range", () => {
    const track = makeTrack({ altitude: 35000 });
    const pass: Filters = { ...DEFAULT_FILTERS, altitudeMin: 30000, altitudeMax: 40000 };
    const fail: Filters = { ...DEFAULT_FILTERS, altitudeMin: 36000, altitudeMax: 40000 };
    expect(matchesFilters(track, pass)).toBe(true);
    expect(matchesFilters(track, fail)).toBe(false);
  });

  it("null altitude passes altitude filter", () => {
    const track = makeTrack({ altitude: null });
    const filters: Filters = { ...DEFAULT_FILTERS, altitudeMin: 10000, altitudeMax: 40000 };
    expect(matchesFilters(track, filters)).toBe(true);
  });

  it("filters by speed range", () => {
    const track = makeTrack({ ground_speed: 350 });
    const pass: Filters = { ...DEFAULT_FILTERS, speedMin: 300, speedMax: 400 };
    const fail: Filters = { ...DEFAULT_FILTERS, speedMin: 400, speedMax: 500 };
    expect(matchesFilters(track, pass)).toBe(true);
    expect(matchesFilters(track, fail)).toBe(false);
  });
});
