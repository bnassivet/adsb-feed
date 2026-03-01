import { describe, it, expect } from "vitest";
import {
  computeMaxRange,
  polarToCartesian,
  buildRadarPoints,
  buildRadarPath,
  buildDistanceRings,
  buildCardinalLabels,
} from "../detection-radar";
import type { DetectionRangeSector } from "../types";

function makeSectors(overrides: Partial<DetectionRangeSector>[] = []): DetectionRangeSector[] {
  const sectors: DetectionRangeSector[] = Array.from({ length: 36 }, (_, i) => ({
    bearing_deg: i * 10,
    max_distance_nm: 0,
    position_count: 0,
  }));
  for (const o of overrides) {
    const idx = (o.bearing_deg ?? 0) / 10;
    sectors[idx] = { ...sectors[idx], ...o };
  }
  return sectors;
}

describe("computeMaxRange", () => {
  it("returns 1 for empty sectors", () => {
    expect(computeMaxRange([])).toBe(1);
  });

  it("returns 1 for all-zero sectors", () => {
    expect(computeMaxRange(makeSectors())).toBe(1);
  });

  it("returns the maximum distance", () => {
    const sectors = makeSectors([
      { bearing_deg: 0, max_distance_nm: 100 },
      { bearing_deg: 90, max_distance_nm: 200 },
    ]);
    expect(computeMaxRange(sectors)).toBe(200);
  });
});

describe("polarToCartesian", () => {
  const center = 150;
  const maxR = 126; // 150 - 24 padding

  it("North (0°) maps to up (negative Y)", () => {
    const { x, y } = polarToCartesian(0, 1, center, maxR);
    expect(x).toBeCloseTo(center, 0);
    expect(y).toBeCloseTo(center - maxR, 0);
  });

  it("East (90°) maps to right (positive X)", () => {
    const { x, y } = polarToCartesian(90, 1, center, maxR);
    expect(x).toBeCloseTo(center + maxR, 0);
    expect(y).toBeCloseTo(center, 0);
  });

  it("South (180°) maps to down (positive Y)", () => {
    const { x, y } = polarToCartesian(180, 1, center, maxR);
    expect(x).toBeCloseTo(center, 0);
    expect(y).toBeCloseTo(center + maxR, 0);
  });

  it("West (270°) maps to left (negative X)", () => {
    const { x, y } = polarToCartesian(270, 1, center, maxR);
    expect(x).toBeCloseTo(center - maxR, 0);
    expect(y).toBeCloseTo(center, 0);
  });

  it("zero radius stays at center", () => {
    const { x, y } = polarToCartesian(45, 0, center, maxR);
    expect(x).toBeCloseTo(center);
    expect(y).toBeCloseTo(center);
  });
});

describe("buildRadarPoints", () => {
  it("returns 36 points for 36 sectors", () => {
    const points = buildRadarPoints(makeSectors());
    expect(points).toHaveLength(36);
  });

  it("all-zero sectors produce points at center", () => {
    const config = { size: 300, padding: 24 };
    const points = buildRadarPoints(makeSectors(), config);
    for (const p of points) {
      expect(p.x).toBeCloseTo(150, 0);
      expect(p.y).toBeCloseTo(150, 0);
    }
  });
});

describe("buildRadarPath", () => {
  it("returns empty string for no points", () => {
    expect(buildRadarPath([])).toBe("");
  });

  it("starts with M, ends with Z", () => {
    const points = buildRadarPoints(
      makeSectors([{ bearing_deg: 0, max_distance_nm: 100 }])
    );
    const path = buildRadarPath(points);
    expect(path).toMatch(/^M/);
    expect(path).toMatch(/Z$/);
  });

  it("contains L segments for multi-point paths", () => {
    const points = buildRadarPoints(
      makeSectors([
        { bearing_deg: 0, max_distance_nm: 100 },
        { bearing_deg: 90, max_distance_nm: 50 },
      ])
    );
    const path = buildRadarPath(points);
    expect(path).toContain("L");
  });
});

describe("buildDistanceRings", () => {
  it("returns 3 rings for small range (≤50 NM)", () => {
    const rings = buildDistanceRings(30);
    expect(rings).toHaveLength(3);
  });

  it("returns 4 rings for medium range (50-150 NM)", () => {
    const rings = buildDistanceRings(100);
    expect(rings).toHaveLength(4);
  });

  it("returns 5 rings for large range (>150 NM)", () => {
    const rings = buildDistanceRings(250);
    expect(rings).toHaveLength(5);
  });

  it("outermost ring label matches max range", () => {
    const rings = buildDistanceRings(120);
    const last = rings[rings.length - 1];
    expect(last.label).toBe("120 NM");
  });

  it("ring radii increase", () => {
    const rings = buildDistanceRings(100);
    for (let i = 1; i < rings.length; i++) {
      expect(rings[i].radius).toBeGreaterThan(rings[i - 1].radius);
    }
  });
});

describe("buildCardinalLabels", () => {
  it("returns 4 labels", () => {
    const labels = buildCardinalLabels();
    expect(labels).toHaveLength(4);
  });

  it("has N, E, S, W", () => {
    const labels = buildCardinalLabels();
    const names = labels.map((l) => l.label);
    expect(names).toEqual(["N", "E", "S", "W"]);
  });

  it("N is at the top", () => {
    const config = { size: 300, padding: 24 };
    const labels = buildCardinalLabels(config);
    const n = labels.find((l) => l.label === "N")!;
    expect(n.y).toBeLessThan(config.size / 2);
    expect(n.x).toBeCloseTo(config.size / 2);
  });
});
