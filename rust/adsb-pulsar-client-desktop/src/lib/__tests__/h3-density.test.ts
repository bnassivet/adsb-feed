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
});
