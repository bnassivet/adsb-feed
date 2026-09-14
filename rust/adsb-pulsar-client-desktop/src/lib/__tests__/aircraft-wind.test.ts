import { describe, expect, it } from "vitest";
import { aircraftWind } from "../aircraft-wind";
import type { AircraftTrack } from "../types";
import type { WeatherSnapshot, WindFields } from "../weather";

function uniform(dir: number, speed: number): WindFields {
  return { wind_dir_deg: [dir, dir, dir, dir], wind_speed_kt: [speed, speed, speed, speed] };
}

/** 2 x 2 grid over (46..47, -3..-2): 270°/20 kt at 850 hPa, 250°/100 kt at 250 hPa. */
const snapshot: WeatherSnapshot = {
  version: 1,
  source: "open-meteo",
  attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
  model: "best_match",
  fetched_at_ms: 0,
  valid_time_ms: 0,
  grid: { lat0: 46, lon0: -3, dlat: 1, dlon: 1, nlat: 2, nlon: 2 },
  surface: { ...uniform(270, 10), mslp_hpa: [1013, 1013, 1013, 1013] },
  levels: { "850": uniform(270, 20), "250": uniform(250, 100) },
};

function track(overrides: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "3C6444",
    callsign: "DLH4AB",
    altitude: 34_000,
    ground_speed: 480,
    track: 250,
    latitude: 46.5,
    longitude: -2.5,
    vertical_rate: 0,
    squawk: "1000",
    is_on_ground: false,
    timestamp: "",
    positions: [],
    first_seen: 0,
    last_seen: 0,
    message_count: 1,
    ...overrides,
  };
}

describe("aircraftWind", () => {
  it("is the level wind, all headwind, for an aircraft flying into it", () => {
    const w = aircraftWind(snapshot, track());
    expect(w).not.toBeNull();
    expect(w!.dirDeg).toBeCloseTo(250, 0);
    expect(w!.speedKt).toBeCloseTo(100, 0);
    expect(w!.headwindKt).toBeCloseTo(100, 0);
    expect(w!.crosswindKt).toBeCloseTo(0, 0);
  });

  it("is a tailwind for an aircraft flying downwind", () => {
    expect(aircraftWind(snapshot, track({ track: 70 }))!.headwindKt).toBeCloseTo(-100, 0);
  });

  it("is null with no snapshot", () => {
    expect(aircraftWind(null, track())).toBeNull();
  });

  it("is null without a position", () => {
    expect(aircraftWind(snapshot, track({ latitude: null }))).toBeNull();
    expect(aircraftWind(snapshot, track({ longitude: null }))).toBeNull();
  });

  it("is null without an altitude or a track", () => {
    expect(aircraftWind(snapshot, track({ altitude: null }))).toBeNull();
    expect(aircraftWind(snapshot, track({ track: null }))).toBeNull();
  });

  it("is null on the ground", () => {
    expect(aircraftWind(snapshot, track({ is_on_ground: true, altitude: 0 }))).toBeNull();
  });

  it("is null outside the grid", () => {
    expect(aircraftWind(snapshot, track({ latitude: 55 }))).toBeNull();
  });

  it("is null far above the levels the snapshot covers", () => {
    expect(aircraftWind(snapshot, track({ altitude: 55_000 }))).toBeNull();
  });
});
