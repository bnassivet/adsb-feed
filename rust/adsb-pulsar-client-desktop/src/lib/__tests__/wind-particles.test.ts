import { describe, expect, it } from "vitest";
import { interpolateWindAtLevel, type WeatherSnapshot, type WindFields } from "../weather";
import {
  createParticles,
  createWindField,
  degreesPerPixel,
  fieldBounds,
  intersectBounds,
  MAX_PARTICLES,
  MAX_STEP_S,
  MIN_PARTICLES,
  particleCount,
  projectMercator,
  sampleWind,
  speedBucket,
  stepParticles,
  type GeoBounds,
  type StepOptions,
} from "../wind-particles";

function uniform(dir: number, speed: number, n = 4): WindFields {
  return { wind_dir_deg: Array(n).fill(dir), wind_speed_kt: Array(n).fill(speed) };
}

/** 2 x 2 grid over (46..47, -3..-2). */
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
    levels: { "250": uniform(270, 100) },
    ...overrides,
  };
}

const BOUNDS: GeoBounds = { south: 46, west: -3, north: 47, east: -2 };

/** Deterministic stand-in for Math.random: cycles through the given values. */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const STEP: StepOptions = { dtS: 0.05, pxPerKtS: 0.1, degPerPx: 0.01 };

/** One particle at a chosen position, young enough not to age out. */
function oneParticle(lat: number, lon: number) {
  const particles = createParticles(1, BOUNDS, sequence(0.5));
  particles.lat[0] = lat;
  particles.lon[0] = lon;
  particles.age[0] = 0;
  particles.maxAge[0] = 10;
  return particles;
}

describe("createWindField / sampleWind", () => {
  it("samples the wind as u (east) and v (north) components in knots", () => {
    const field = createWindField(snapshot(), 250)!;
    const out = [0, 0];

    expect(sampleWind(field, 46.5, -2.5, out)).toBe(true);

    // A wind FROM 270 blows east.
    expect(out[0]).toBeCloseTo(100, 6);
    expect(out[1]).toBeCloseTo(0, 6);
  });

  it("agrees with interpolateWindAtLevel between grid points", () => {
    const snap = snapshot({
      levels: {
        "250": { wind_dir_deg: [350, 10, 270, 200], wind_speed_kt: [40, 60, 80, 20] },
      },
    });
    const field = createWindField(snap, 250)!;
    const out = [0, 0];

    sampleWind(field, 46.3, -2.8, out);
    const expected = interpolateWindAtLevel(snap, 250, 46.3, -2.8)!;
    const r = (expected.dirDeg * Math.PI) / 180;

    expect(out[0]).toBeCloseTo(-expected.speedKt * Math.sin(r), 6);
    expect(out[1]).toBeCloseTo(-expected.speedKt * Math.cos(r), 6);
  });

  it("reads the surface level", () => {
    const field = createWindField(snapshot(), "surface")!;
    const out = [0, 0];

    sampleWind(field, 46.5, -2.5, out);

    expect(out[0]).toBeCloseTo(10, 6);
  });

  it("is null for a level the snapshot does not carry", () => {
    expect(createWindField(snapshot(), 500)).toBeNull();
  });

  it("reports no wind outside the grid", () => {
    const field = createWindField(snapshot(), 250)!;

    expect(sampleWind(field, 45.9, -2.5, [0, 0])).toBe(false);
    expect(sampleWind(field, 46.5, -1.9, [0, 0])).toBe(false);
  });

  it("reports no wind in a cell with a missing corner", () => {
    const field = createWindField(
      snapshot({ levels: { "250": { wind_dir_deg: [270, 270, null, 270], wind_speed_kt: [1, 1, 1, 1] } } }),
      250,
    )!;

    expect(sampleWind(field, 46.5, -2.5, [0, 0])).toBe(false);
  });
});

describe("bounds", () => {
  it("spans the grid from its south-west corner", () => {
    const grid = { lat0: 40, lon0: -10, dlat: 1, dlon: 2, nlat: 11, nlon: 6 };

    expect(fieldBounds(grid)).toEqual({ south: 40, west: -10, north: 50, east: 0 });
  });

  it("intersects overlapping bounds", () => {
    expect(intersectBounds(BOUNDS, { south: 46.5, west: -4, north: 50, east: -2.5 })).toEqual({
      south: 46.5,
      west: -3,
      north: 47,
      east: -2.5,
    });
  });

  it("is null for disjoint bounds", () => {
    expect(intersectBounds(BOUNDS, { south: 48, west: -3, north: 49, east: -2 })).toBeNull();
  });
});

describe("sizing", () => {
  it("one pixel is 360/256 degrees of longitude at zoom 0, halving per zoom level", () => {
    expect(degreesPerPixel(0)).toBeCloseTo(360 / 256, 12);
    expect(degreesPerPixel(8)).toBeCloseTo(360 / 256 / 256, 12);
  });

  it("scales the particle count with the canvas area, within limits", () => {
    const small = particleCount(400, 300);
    const large = particleCount(1600, 1000);

    expect(large).toBeGreaterThan(small);
    expect(particleCount(10, 10)).toBe(MIN_PARTICLES);
    expect(particleCount(10_000, 10_000)).toBe(MAX_PARTICLES);
  });

  it("buckets speeds in 20 kt steps, open-ended at 100 kt", () => {
    expect(speedBucket(0)).toBe(0);
    expect(speedBucket(19.9)).toBe(0);
    expect(speedBucket(20)).toBe(1);
    expect(speedBucket(99)).toBe(4);
    expect(speedBucket(100)).toBe(5);
    expect(speedBucket(250)).toBe(5);
  });
});

describe("projectMercator", () => {
  it("puts (0, 0) at the centre of the zoom-0 world tile", () => {
    const out = [0, 0];
    projectMercator(0, 0, 0, out);

    expect(out[0]).toBeCloseTo(128, 9);
    expect(out[1]).toBeCloseTo(128, 9);
  });

  it("spans 256 x 2^zoom pixels of longitude", () => {
    const out = [0, 0];
    projectMercator(0, 180, 0, out);
    expect(out[0]).toBeCloseTo(256, 9);
    projectMercator(0, -180, 1, out);
    expect(out[0]).toBeCloseTo(0, 9);
    projectMercator(0, 90, 2, out);
    expect(out[0]).toBeCloseTo(768, 9);
  });

  it("stretches latitude towards the poles, symmetric about the equator", () => {
    const north = [0, 0];
    const south = [0, 0];
    projectMercator(45, 0, 0, north);
    projectMercator(-45, 0, 0, south);

    expect(north[1]).toBeCloseTo(92.09, 1);
    expect(south[1]).toBeCloseTo(256 - north[1], 9);
  });

  it("clamps latitude at Web Mercator's limit, like Leaflet", () => {
    const out = [0, 0];
    projectMercator(89.9, 0, 0, out);

    expect(out[1]).toBeCloseTo(0, 6);
  });
});

describe("createParticles", () => {
  it("seeds every particle inside the bounds, with nothing to draw yet", () => {
    const particles = createParticles(50, BOUNDS);

    expect(particles.count).toBe(50);
    for (let i = 0; i < particles.count; i++) {
      expect(particles.lat[i]).toBeGreaterThanOrEqual(BOUNDS.south);
      expect(particles.lat[i]).toBeLessThanOrEqual(BOUNDS.north);
      expect(particles.lon[i]).toBeGreaterThanOrEqual(BOUNDS.west);
      expect(particles.lon[i]).toBeLessThanOrEqual(BOUNDS.east);
      expect(particles.reborn[i]).toBe(1);
    }
  });

  it("staggers ages so particles do not all respawn on the same frame", () => {
    const particles = createParticles(20, BOUNDS);
    const ages = new Set(Array.from(particles.age));

    expect(ages.size).toBeGreaterThan(1);
    for (let i = 0; i < particles.count; i++) {
      expect(particles.age[i]).toBeLessThan(particles.maxAge[i]);
    }
  });
});

describe("stepParticles", () => {
  it("moves a particle downwind by speed x pixels-per-knot-second x dt x degrees-per-pixel", () => {
    const field = createWindField(snapshot(), 250)!; // from 270, 100 kt
    const particles = oneParticle(46.5, -2.5);

    stepParticles(particles, field, BOUNDS, STEP);

    expect(particles.reborn[0]).toBe(0);
    expect(particles.lon[0]).toBeCloseTo(-2.5 + 100 * 0.1 * 0.05 * 0.01, 9);
    expect(particles.lat[0]).toBeCloseTo(46.5, 9);
    expect(particles.speedKt[0]).toBeCloseTo(100, 6);
  });

  it("moves the same distance on screen north as east (Web Mercator)", () => {
    const grid = { lat0: 59, lon0: 9, dlat: 2, dlon: 2, nlat: 2, nlon: 2 };
    const bounds = { south: 59, west: 9, north: 61, east: 11 };
    const east = createWindField(snapshot({ grid, levels: { "250": uniform(270, 50) } }), 250)!;
    const north = createWindField(snapshot({ grid, levels: { "250": uniform(180, 50) } }), 250)!;

    const a = oneParticle(60, 10);
    const b = oneParticle(60, 10);
    stepParticles(a, east, bounds, STEP);
    stepParticles(b, north, bounds, STEP);

    // At 60°N a degree of latitude spans twice the pixels of a degree of longitude.
    expect(b.lat[0] - 60).toBeCloseTo((a.lon[0] - 10) * Math.cos((60 * Math.PI) / 180), 6);
  });

  it("clamps a long frame gap so particles do not teleport", () => {
    const field = createWindField(snapshot(), 250)!;
    const particles = oneParticle(46.5, -2.5);

    stepParticles(particles, field, BOUNDS, { ...STEP, dtS: 30 });

    expect(particles.lon[0]).toBeCloseTo(-2.5 + 100 * 0.1 * MAX_STEP_S * 0.01, 9);
    expect(particles.age[0]).toBeCloseTo(MAX_STEP_S, 6);
  });

  it("re-seeds a particle that has aged out", () => {
    const field = createWindField(snapshot(), 250)!;
    const particles = oneParticle(46.5, -2.5);
    particles.age[0] = 9.99;

    stepParticles(particles, field, BOUNDS, STEP, sequence(0.25));

    expect(particles.reborn[0]).toBe(1);
    expect(particles.age[0]).toBe(0);
    expect(particles.lat[0]).toBeCloseTo(46.25, 9);
    expect(particles.lon[0]).toBeCloseTo(-2.75, 9);
  });

  it("re-seeds a particle that leaves the bounds", () => {
    const field = createWindField(snapshot(), 250)!;
    const particles = oneParticle(46.5, -2.0000001);

    stepParticles(particles, field, BOUNDS, STEP, sequence(0.5));

    expect(particles.reborn[0]).toBe(1);
    expect(particles.lon[0]).toBeCloseTo(-2.5, 9);
  });

  it("re-seeds a particle over missing data", () => {
    const field = createWindField(
      snapshot({ levels: { "250": { wind_dir_deg: [270, 270, null, 270], wind_speed_kt: [1, 1, 1, 1] } } }),
      250,
    )!;
    const particles = oneParticle(46.5, -2.5);

    stepParticles(particles, field, BOUNDS, STEP);

    expect(particles.reborn[0]).toBe(1);
  });

  it("clears last frame's re-seed flag once the particle moves", () => {
    const field = createWindField(snapshot(), 250)!;
    const particles = oneParticle(46.5, -2.5);
    particles.reborn[0] = 1;

    stepParticles(particles, field, BOUNDS, STEP);

    expect(particles.reborn[0]).toBe(0);
  });
});
