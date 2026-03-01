import { describe, it, expect } from "vitest";
import { computeH3Density } from "../h3-density";
import type { AircraftTrack } from "../types";

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
    positions: [[45.5, -73.5, 35000]],
    first_seen: Date.now(),
    last_seen: Date.now(),
    message_count: 0,
    ...overrides,
  };
}

describe("computeH3Density", () => {
  it("returns empty features for empty tracks", () => {
    const result = computeH3Density([], "positions", 5);
    expect(result.type).toBe("FeatureCollection");
    expect(result.features).toHaveLength(0);
  });

  it("returns features for single track with positions metric", () => {
    const track = makeTrack({
      positions: [[45.5, -73.5, 35000], [45.51, -73.51, 36000]],
    });
    const result = computeH3Density([track], "positions", 5);
    expect(result.features.length).toBeGreaterThan(0);
    // Should have count-based values
    for (const f of result.features) {
      expect(f.properties.value).toBeGreaterThan(0);
    }
  });

  it("counts unique aircraft for aircraft metric", () => {
    const track1 = makeTrack({
      hex_ident: "AAA",
      positions: [[45.5, -73.5, 35000]],
    });
    const track2 = makeTrack({
      hex_ident: "BBB",
      positions: [[45.5, -73.5, 35000]], // same position, different aircraft
    });
    const result = computeH3Density([track1, track2], "aircraft", 5);
    // At least one feature should have aircraft count >= 2
    const maxAircraft = Math.max(...result.features.map(f => f.properties.value));
    expect(maxAircraft).toBe(2);
  });

  it("computes mean altitude for altitude metric", () => {
    const track1 = makeTrack({
      hex_ident: "AAA",
      altitude: 30000,
      positions: [[45.5, -73.5, 30000]],
    });
    const track2 = makeTrack({
      hex_ident: "BBB",
      altitude: 40000,
      positions: [[45.5, -73.5, 40000]],
    });
    const result = computeH3Density([track1, track2], "altitude", 5);
    // Should have altitude values; mean of 30000 and 40000 = 35000
    const altValues = result.features.map(f => f.properties.value);
    expect(altValues.some(v => v > 0)).toBe(true);
  });

  it("excludes null altitude from mean", () => {
    const trackWithAlt = makeTrack({
      hex_ident: "AAA",
      altitude: 30000,
      positions: [[45.5, -73.5, 30000]],
    });
    const trackNoAlt = makeTrack({
      hex_ident: "BBB",
      altitude: null,
      positions: [[45.5, -73.5, null]],
    });
    const result = computeH3Density([trackWithAlt, trackNoAlt], "altitude", 5);
    // The mean should be 30000 (only one altitude contributed)
    for (const f of result.features) {
      if (f.properties.value > 0) {
        expect(f.properties.value).toBe(30000);
      }
    }
  });

  it("normalizes values between 0 and 1", () => {
    const tracks = [
      makeTrack({ hex_ident: "A", positions: [[45.5, -73.5, 35000], [45.51, -73.51, 36000]] }),
      makeTrack({ hex_ident: "B", positions: [[46.0, -74.0, 30000]] }),
    ];
    const result = computeH3Density(tracks, "positions", 5);
    for (const f of result.features) {
      expect(f.properties.normalized).toBeGreaterThanOrEqual(0);
      expect(f.properties.normalized).toBeLessThanOrEqual(1);
    }
  });

  it("returns valid GeoJSON structure", () => {
    const track = makeTrack({ positions: [[45.5, -73.5, 35000]] });
    const result = computeH3Density([track], "positions", 5);
    expect(result.type).toBe("FeatureCollection");
    expect(Array.isArray(result.features)).toBe(true);
    for (const f of result.features) {
      expect(f.type).toBe("Feature");
      expect(f.geometry.type).toBe("Polygon");
      expect(Array.isArray(f.geometry.coordinates)).toBe(true);
    }
  });

  it("produces closed polygon rings", () => {
    const track = makeTrack({ positions: [[45.5, -73.5, 35000]] });
    const result = computeH3Density([track], "positions", 5);
    for (const f of result.features) {
      const ring = f.geometry.coordinates[0];
      expect(ring.length).toBeGreaterThan(3);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });

  describe("altitude_min metric", () => {
    it("computes min altitude per cell", () => {
      const track1 = makeTrack({
        hex_ident: "AAA",
        positions: [[45.5, -73.5, 30000]],
      });
      const track2 = makeTrack({
        hex_ident: "BBB",
        positions: [[45.5, -73.5, 10000]],
      });
      const result = computeH3Density([track1, track2], "altitude_min", 5);
      // Min of 30000 and 10000 = 10000
      for (const f of result.features) {
        if (f.properties.value > 0) {
          expect(f.properties.value).toBe(10000);
        }
      }
    });

    it("excludes null altitude from min", () => {
      const trackWithAlt = makeTrack({
        hex_ident: "AAA",
        positions: [[45.5, -73.5, 25000]],
      });
      const trackNoAlt = makeTrack({
        hex_ident: "BBB",
        positions: [[45.5, -73.5, null]],
      });
      const result = computeH3Density([trackWithAlt, trackNoAlt], "altitude_min", 5);
      for (const f of result.features) {
        if (f.properties.value > 0) {
          expect(f.properties.value).toBe(25000);
        }
      }
    });

    it("uses fixed 0-50000 normalization for altitude_min", () => {
      const track = makeTrack({ positions: [[45.5, -73.5, 25000]] });
      const result = computeH3Density([track], "altitude_min", 5);
      expect(result.features[0].properties.normalized).toBeCloseTo(0.5, 1);
    });
  });

  describe("altitude_max metric", () => {
    it("computes max altitude per cell", () => {
      const track1 = makeTrack({
        hex_ident: "AAA",
        positions: [[45.5, -73.5, 30000]],
      });
      const track2 = makeTrack({
        hex_ident: "BBB",
        positions: [[45.5, -73.5, 42000]],
      });
      const result = computeH3Density([track1, track2], "altitude_max", 5);
      // Max of 30000 and 42000 = 42000
      for (const f of result.features) {
        if (f.properties.value > 0) {
          expect(f.properties.value).toBe(42000);
        }
      }
    });

    it("excludes null altitude from max", () => {
      const trackWithAlt = makeTrack({
        hex_ident: "AAA",
        positions: [[45.5, -73.5, 38000]],
      });
      const trackNoAlt = makeTrack({
        hex_ident: "BBB",
        positions: [[45.5, -73.5, null]],
      });
      const result = computeH3Density([trackWithAlt, trackNoAlt], "altitude_max", 5);
      for (const f of result.features) {
        if (f.properties.value > 0) {
          expect(f.properties.value).toBe(38000);
        }
      }
    });

    it("uses fixed 0-50000 normalization for altitude_max", () => {
      const track = makeTrack({ positions: [[45.5, -73.5, 40000]] });
      const result = computeH3Density([track], "altitude_max", 5);
      expect(result.features[0].properties.normalized).toBeCloseTo(0.8, 1);
    });
  });

  describe("altitude range filtering", () => {
    it("excludes positions below altitudeMin", () => {
      const track = makeTrack({
        positions: [
          [45.5, -73.5, 5000],   // below min
          [45.51, -73.51, 20000], // within range
        ],
      });
      const result = computeH3Density([track], "positions", 5, { altitudeMin: 10000, altitudeMax: 50000 });
      // Only the 20000 ft position should be included
      const totalPositions = result.features.reduce((sum, f) => sum + f.properties.value, 0);
      expect(totalPositions).toBe(1);
    });

    it("excludes positions above altitudeMax", () => {
      const track = makeTrack({
        positions: [
          [45.5, -73.5, 20000],  // within range
          [45.51, -73.51, 45000], // above max
        ],
      });
      const result = computeH3Density([track], "positions", 5, { altitudeMin: 0, altitudeMax: 30000 });
      const totalPositions = result.features.reduce((sum, f) => sum + f.properties.value, 0);
      expect(totalPositions).toBe(1);
    });

    it("excludes positions with null altitude when range is set", () => {
      const track = makeTrack({
        positions: [
          [45.5, -73.5, null],    // no altitude — excluded
          [45.51, -73.51, 20000], // within range
        ],
      });
      const result = computeH3Density([track], "positions", 5, { altitudeMin: 10000, altitudeMax: 50000 });
      const totalPositions = result.features.reduce((sum, f) => sum + f.properties.value, 0);
      expect(totalPositions).toBe(1);
    });

    it("includes all positions when no altitude range is specified", () => {
      const track = makeTrack({
        positions: [
          [45.5, -73.5, 5000],
          [45.51, -73.51, 20000],
        ],
      });
      const withRange = computeH3Density([track], "positions", 5);
      const totalPositions = withRange.features.reduce((sum, f) => sum + f.properties.value, 0);
      expect(totalPositions).toBe(2);
    });

    it("returns empty features when all positions are filtered out", () => {
      const track = makeTrack({
        positions: [[45.5, -73.5, 5000]],
      });
      const result = computeH3Density([track], "positions", 5, { altitudeMin: 10000, altitudeMax: 50000 });
      expect(result.features).toHaveLength(0);
    });

    it("filters altitude metric correctly with altitude range", () => {
      const track1 = makeTrack({
        hex_ident: "AAA",
        positions: [[45.5, -73.5, 30000]],
      });
      const track2 = makeTrack({
        hex_ident: "BBB",
        positions: [[45.5, -73.5, 5000]], // below min — excluded
      });
      const result = computeH3Density([track1, track2], "altitude", 5, { altitudeMin: 10000, altitudeMax: 50000 });
      // Only track1's 30000 ft should contribute to mean
      for (const f of result.features) {
        if (f.properties.value > 0) {
          expect(f.properties.value).toBe(30000);
        }
      }
    });
  });
});
