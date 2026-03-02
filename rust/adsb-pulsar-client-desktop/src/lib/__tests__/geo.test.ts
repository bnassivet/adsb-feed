import { describe, it, expect } from "vitest";
import { haversineDistanceNm } from "../geo";

describe("haversineDistanceNm", () => {
  it("returns 0 for identical points", () => {
    expect(haversineDistanceNm(45.5, -73.5, 45.5, -73.5)).toBe(0);
  });

  it("computes known distance Paris to London (~187 NM)", () => {
    // Paris 48.8566°N 2.3522°E → London 51.5074°N -0.1278°W ≈ 187 NM
    const d = haversineDistanceNm(48.8566, 2.3522, 51.5074, -0.1278);
    expect(d).toBeGreaterThan(183);
    expect(d).toBeLessThan(191);
  });

  it("computes known distance New York to Los Angeles (~2,130 NM)", () => {
    const d = haversineDistanceNm(40.7128, -74.006, 33.9425, -118.408);
    expect(d).toBeGreaterThan(2100);
    expect(d).toBeLessThan(2160);
  });

  it("handles short distances (~1 NM)", () => {
    // ~1 NM ≈ 1 minute of latitude ≈ 0.01667°
    const d = haversineDistanceNm(45.0, -73.0, 45.01667, -73.0);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThan(1.1);
  });

  it("handles antipodal points (~10,800 NM)", () => {
    const d = haversineDistanceNm(0, 0, 0, 180);
    expect(d).toBeGreaterThan(10790);
    expect(d).toBeLessThan(10810);
  });
});
