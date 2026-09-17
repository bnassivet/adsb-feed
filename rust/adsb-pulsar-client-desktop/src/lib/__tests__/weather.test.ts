import { describe, expect, it } from "vitest";
import {
  availableLevels,
  barbParts,
  describeRecordedValidity,
  describeValidity,
  isOffHour,
  snapshotOffsetMs,
  fieldsAt,
  gridPoints,
  hpaToFlightLevel,
  interpolateWind,
  interpolateWindAtLevel,
  isStale,
  levelLabel,
  pressureAltitudeToHpa,
  resolveWeatherLevel,
  STALE_AFTER_MS,
  windAtPoint,
  windComponents,
  windReport,
  type WeatherSnapshot,
  type WindFields,
} from "../weather";

/** 2 x 2 grid over (46..47, -3..-2): uniform fields per level. */
function uniform(dir: number, speed: number, n = 4): WindFields {
  return { wind_dir_deg: Array(n).fill(dir), wind_speed_kt: Array(n).fill(speed) };
}

function snapshot(overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    version: 1,
    source: "open-meteo",
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    model: "best_match",
    fetched_at_ms: 0,
    valid_time_ms: 0,
    grid: { lat0: 46, lon0: -3, dlat: 1, dlon: 1, nlat: 2, nlon: 2 },
    surface: { ...uniform(270, 10), mslp_hpa: [1013, 1013, 1013, 1013] },
    levels: { "850": uniform(270, 20), "250": uniform(250, 100) },
    ...overrides,
  };
}

/** Smallest angle between two bearings. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe("pressureAltitudeToHpa", () => {
  it("is 1013.25 hPa at a pressure altitude of zero", () => {
    expect(pressureAltitudeToHpa(0)).toBeCloseTo(1013.25, 2);
  });

  it("follows the ISA power law below the tropopause", () => {
    expect(pressureAltitudeToHpa(5_000)).toBeCloseTo(843.1, 0);
    expect(pressureAltitudeToHpa(18_000)).toBeCloseTo(506.0, 0);
    expect(pressureAltitudeToHpa(34_000)).toBeCloseTo(250.0, 0);
  });

  it("decays exponentially above the tropopause", () => {
    // The power law alone is ~3 hPa off by FL450.
    expect(pressureAltitudeToHpa(39_000)).toBeCloseTo(196.8, 0);
    expect(pressureAltitudeToHpa(45_000)).toBeCloseTo(147.5, 0);
  });
});

describe("hpaToFlightLevel", () => {
  it("maps the default levels to their usual flight levels", () => {
    expect(hpaToFlightLevel(850)).toBe(50);
    expect(hpaToFlightLevel(700)).toBe(100);
    expect(hpaToFlightLevel(500)).toBe(180);
    expect(hpaToFlightLevel(300)).toBe(300);
    expect(hpaToFlightLevel(250)).toBe(340);
    expect(hpaToFlightLevel(200)).toBe(390);
  });
});

describe("levels", () => {
  it("lists levels from the lowest altitude up, whatever the key order", () => {
    expect(availableLevels(snapshot())).toEqual([850, 250]);
  });

  it("labels the surface and pressure levels", () => {
    expect(levelLabel("surface")).toBe("SFC");
    expect(levelLabel(250)).toBe("FL340 · 250 hPa");
  });

  it("returns the surface fields and a present level, null for an absent one", () => {
    const snap = snapshot();
    expect(fieldsAt(snap, "surface")?.wind_speed_kt[0]).toBe(10);
    expect(fieldsAt(snap, 250)?.wind_speed_kt[0]).toBe(100);
    expect(fieldsAt(snap, 500)).toBeNull();
  });
});

describe("gridPoints", () => {
  it("enumerates row-major from the south-west corner", () => {
    const pts = gridPoints(snapshot());
    expect(pts).toHaveLength(4);
    expect(pts[0]).toEqual({ lat: 46, lon: -3, index: 0 });
    expect(pts[1]).toEqual({ lat: 46, lon: -2, index: 1 });
    expect(pts[2]).toEqual({ lat: 47, lon: -3, index: 2 });
  });

  it("wraps longitudes across the antimeridian", () => {
    const snap = snapshot({ grid: { lat0: 0, lon0: 179, dlat: 1, dlon: 1, nlat: 1, nlon: 3 } });
    expect(gridPoints(snap).map((p) => p.lon)).toEqual([179, -180, -179]);
  });
});

describe("windAtPoint", () => {
  it("reads one point", () => {
    expect(windAtPoint(uniform(270, 25), 1)).toEqual({ dirDeg: 270, speedKt: 25 });
  });

  it("is null where either value is missing", () => {
    const fields: WindFields = { wind_dir_deg: [null], wind_speed_kt: [12] };
    expect(windAtPoint(fields, 0)).toBeNull();
  });
});

describe("interpolateWindAtLevel", () => {
  it("returns the field value inside a uniform grid", () => {
    const w = interpolateWindAtLevel(snapshot(), 250, 46.5, -2.5);
    expect(w?.speedKt).toBeCloseTo(100, 6);
    expect(w?.dirDeg).toBeCloseTo(250, 6);
  });

  it("is null outside the grid", () => {
    expect(interpolateWindAtLevel(snapshot(), 250, 50, -2.5)).toBeNull();
    expect(interpolateWindAtLevel(snapshot(), 250, 46.5, 10)).toBeNull();
  });

  it("interpolates across north as vectors, not as numbers", () => {
    // Southern row from 350°, northern row from 010°. Halfway is north,
    // not the 180° a numeric average would give.
    const snap = snapshot({
      levels: {
        "500": { wind_dir_deg: [350, 350, 10, 10], wind_speed_kt: [20, 20, 20, 20] },
      },
    });
    const w = interpolateWindAtLevel(snap, 500, 46.5, -2.5);
    expect(w).not.toBeNull();
    expect(angleBetween(w!.dirDeg, 0)).toBeLessThan(0.5);
    expect(w!.speedKt).toBeCloseTo(20 * Math.cos((10 * Math.PI) / 180), 1);
  });

  it("is null when a surrounding corner is missing", () => {
    const snap = snapshot({
      levels: { "250": { wind_dir_deg: [250, null, 250, 250], wind_speed_kt: [100, 100, 100, 100] } },
    });
    expect(interpolateWindAtLevel(snap, 250, 46.5, -2.5)).toBeNull();
  });

  it("finds points in a grid that crosses the antimeridian", () => {
    const snap = snapshot({
      grid: { lat0: 0, lon0: 179, dlat: 1, dlon: 1, nlat: 2, nlon: 3 },
      levels: { "250": uniform(90, 40, 6) },
    });
    expect(interpolateWindAtLevel(snap, 250, 0.5, -179.5)?.speedKt).toBeCloseTo(40, 6);
  });
});

describe("interpolateWind", () => {
  it("uses the level wind when the aircraft sits on the level", () => {
    const w = interpolateWind(snapshot(), 46.5, -2.5, 34_000);
    expect(w?.speedKt).toBeCloseTo(100, 0);
    expect(w?.dirDeg).toBeCloseTo(250, 0);
  });

  it("interpolates between the bracketing levels", () => {
    // ~20,240 ft is the ln(p) midpoint of 850 and 250 hPa.
    const w = interpolateWind(snapshot(), 46.5, -2.5, 20_240);
    expect(w).not.toBeNull();
    expect(w!.speedKt).toBeGreaterThan(20);
    expect(w!.speedKt).toBeLessThan(100);
    expect(w!.dirDeg).toBeGreaterThanOrEqual(250);
    expect(w!.dirDeg).toBeLessThanOrEqual(270);
  });

  it("treats the surface as the level below the lowest pressure level", () => {
    const w = interpolateWind(snapshot(), 46.5, -2.5, 2_000);
    expect(w!.dirDeg).toBeCloseTo(270, 6);
    expect(w!.speedKt).toBeGreaterThan(10);
    expect(w!.speedKt).toBeLessThan(20);
  });

  it("holds the top level's wind a little above it", () => {
    // FL410 is ~179 hPa: above the 250 hPa top level, within the hold band.
    const w = interpolateWind(snapshot(), 46.5, -2.5, 41_000);
    expect(w?.speedKt).toBeCloseTo(100, 6);
  });

  it("is null far above the top level", () => {
    expect(interpolateWind(snapshot(), 46.5, -2.5, 50_000)).toBeNull();
  });

  it("is null outside the grid", () => {
    expect(interpolateWind(snapshot(), 60, -2.5, 34_000)).toBeNull();
  });
});

describe("windComponents", () => {
  it("is all headwind straight into the wind", () => {
    const c = windComponents({ dirDeg: 270, speedKt: 100 }, 270);
    expect(c.headwindKt).toBeCloseTo(100, 6);
    expect(c.crosswindKt).toBeCloseTo(0, 6);
  });

  it("is a negative headwind (a tailwind) downwind", () => {
    expect(windComponents({ dirDeg: 270, speedKt: 100 }, 90).headwindKt).toBeCloseTo(-100, 6);
  });

  it("is a positive crosswind when the wind comes from the right", () => {
    // Westbound, wind from the north: north is on the right.
    const c = windComponents({ dirDeg: 360, speedKt: 40 }, 270);
    expect(c.crosswindKt).toBeCloseTo(40, 6);
    expect(c.headwindKt).toBeCloseTo(0, 6);
  });
});

describe("barbParts", () => {
  it("is calm under 5 kt", () => {
    expect(barbParts(2)).toEqual({ pennants: 0, full: 0, half: 0, calm: true });
  });

  it("draws a half barb for 5 kt", () => {
    expect(barbParts(5)).toEqual({ pennants: 0, full: 0, half: 1, calm: false });
  });

  it("combines pennants, full and half barbs", () => {
    expect(barbParts(65)).toEqual({ pennants: 1, full: 1, half: 1, calm: false });
  });

  it("rounds to the nearest 5 kt", () => {
    expect(barbParts(123)).toEqual({ pennants: 2, full: 2, half: 1, calm: false });
  });

  it("treats a non-finite speed as calm", () => {
    expect(barbParts(Number.NaN).calm).toBe(true);
  });
});

describe("isStale", () => {
  it("is fresh within the window and stale beyond it", () => {
    const snap = snapshot({ valid_time_ms: 1_000 });
    expect(isStale(snap, 1_000 + STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(snap, 1_000 + STALE_AFTER_MS + 1)).toBe(true);
  });

  it("is not stale when the valid time is still ahead (a short forecast)", () => {
    expect(isStale(snapshot({ valid_time_ms: 10_000 }), 0)).toBe(false);
  });
});

describe("describeValidity", () => {
  const MIN = 60_000;

  it("says now within the minute", () => {
    expect(describeValidity(0, 20_000)).toBe("valid now");
  });

  it("counts minutes in the past and the future", () => {
    expect(describeValidity(0, 35 * MIN)).toBe("valid 35 min ago");
    expect(describeValidity(28 * MIN, 0)).toBe("valid in 28 min");
    expect(describeValidity(0, 89 * MIN)).toBe("valid 89 min ago");
  });

  it("switches to hours past an hour and a half", () => {
    expect(describeValidity(0, 90 * MIN)).toBe("valid 2 h ago");
    expect(describeValidity(0, 4 * 60 * MIN)).toBe("valid 4 h ago");
  });
});

describe("resolveWeatherLevel", () => {
  const levels = [850, 250];

  it("accepts the surface under its usual names", () => {
    expect(resolveWeatherLevel("surface", levels)).toEqual({ level: "surface" });
    expect(resolveWeatherLevel(" SFC ", levels)).toEqual({ level: "surface" });
  });

  it("accepts a pressure level with or without its unit", () => {
    expect(resolveWeatherLevel("250", levels)).toEqual({ level: 250 });
    expect(resolveWeatherLevel("250hPa", levels)).toEqual({ level: 250 });
    expect(resolveWeatherLevel("850 hpa", levels)).toEqual({ level: 850 });
  });

  it("maps a flight level to the nearest level the snapshot carries", () => {
    expect(resolveWeatherLevel("FL340", levels)).toEqual({ level: 250 });
    expect(resolveWeatherLevel("fl 100", levels)).toEqual({ level: 850 });
  });

  it("refuses a pressure level the snapshot does not carry, naming the options", () => {
    const result = resolveWeatherLevel("500", levels);
    expect("error" in result && result.error).toMatch(/SFC/);
    expect("error" in result && result.error).toMatch(/FL340 · 250 hPa/);
  });

  it("refuses input it cannot read, and a flight level with no levels to map to", () => {
    expect(resolveWeatherLevel("banana", levels)).toHaveProperty("error");
    expect(resolveWeatherLevel("FL340", [])).toHaveProperty("error");
  });
});

describe("windReport", () => {
  const NOW = 30 * 60_000;

  it("reports the wind on a level, rounded, with its validity", () => {
    expect(windReport(snapshot(), { lat: 46.5, lon: -2.5, level: 250 }, NOW)).toEqual({
      fromDeg: 250,
      speedKt: 100,
      level: "FL340 · 250 hPa",
      validity: "valid 30 min ago",
      stale: false,
    });
  });

  it("uses the altitude over the level when both are given", () => {
    const report = windReport(snapshot(), { lat: 46.5, lon: -2.5, level: 250, altitudeFt: 0 }, NOW);
    expect(report).toMatchObject({ fromDeg: 270, speedKt: 10, altitudeFt: 0, pressureHpa: 1013 });
    expect(report).not.toHaveProperty("level");
  });

  it("defaults to the surface", () => {
    expect(windReport(snapshot(), { lat: 46.5, lon: -2.5 }, NOW)).toMatchObject({ level: "SFC", speedKt: 10 });
  });

  it("adds head and crosswind components for a track", () => {
    const into = windReport(snapshot(), { lat: 46.5, lon: -2.5, level: 850, trackDeg: 270 }, NOW);
    expect(into).toMatchObject({ headwindKt: 20, crosswindKt: 0 });
    const away = windReport(snapshot(), { lat: 46.5, lon: -2.5, level: 850, trackDeg: 90 }, NOW);
    expect(away).toMatchObject({ headwindKt: -20, crosswindKt: 0 });
  });

  it("flags a stale snapshot", () => {
    expect(windReport(snapshot(), { lat: 46.5, lon: -2.5 }, STALE_AFTER_MS + 1)).toMatchObject({ stale: true });
  });

  it("explains a position outside the grid or a level it does not carry", () => {
    expect(windReport(snapshot(), { lat: 10, lon: 10 }, NOW)).toHaveProperty("error");
    expect(windReport(snapshot(), { lat: 46.5, lon: -2.5, level: 500 }, NOW)).toHaveProperty("error");
  });
});

describe("a recorded hour against the time being viewed", () => {
  const AT = 1_789_412_400_000;
  const MIN = 60_000;

  it("measures a model hour after the viewed time as far as one before", () => {
    // The fork from isStale, stated as a test. `isStale` is SIGNED on purpose:
    // an hour slightly in the future is the short forecast the service picks,
    // not staleness. History asks a different question -- how far away is the
    // nearest recorded hour, in either direction.
    const before = snapshot({ valid_time_ms: AT - 40 * MIN });
    const after = snapshot({ valid_time_ms: AT + 40 * MIN });
    expect(snapshotOffsetMs(before, AT)).toBe(40 * MIN);
    expect(snapshotOffsetMs(after, AT)).toBe(40 * MIN);
    expect(isStale(after, AT)).toBe(false);
  });

  it("is off-hour only past the tolerance", () => {
    const near = snapshot({ valid_time_ms: AT - STALE_AFTER_MS + MIN });
    const far = snapshot({ valid_time_ms: AT - STALE_AFTER_MS - MIN });
    expect(isOffHour(near, AT)).toBe(false);
    expect(isOffHour(far, AT)).toBe(true);
  });

  it("describes the hour relative to the view, not to now", () => {
    // Deliberately not the word "valid": in this file that means "relative to
    // now", and two strings that read alike must not mean different things.
    expect(describeRecordedValidity(AT, AT)).toBe("model hour matches this view");
    expect(describeRecordedValidity(AT - 20 * MIN, AT)).toBe("model hour 20 min earlier");
    expect(describeRecordedValidity(AT + 40 * MIN, AT)).toBe("model hour 40 min later");
  });

  it("switches to hours for a wide gap, like describeValidity does", () => {
    expect(describeRecordedValidity(AT - 4 * 60 * MIN, AT)).toBe("model hour 4 h earlier");
  });
});
