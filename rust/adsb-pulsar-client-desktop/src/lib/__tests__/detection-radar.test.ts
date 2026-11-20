import { describe, it, expect } from "vitest";
import {
  computeMaxRange,
  polarToCartesian,
  buildRadarPoints,
  buildRadarPath,
  buildSectorWedges,
  buildDistanceRings,
  buildCardinalLabels,
  resolveRingStep,
  rebinBandCounts,
  buildDensityCells,
  RADAR_BAND_WIDTH_NM,
  densityIntensity,
} from "../detection-radar";
import type { DetectionRangeSector } from "../types";

function makeSectors(overrides: Partial<DetectionRangeSector>[] = []): DetectionRangeSector[] {
  const sectors: DetectionRangeSector[] = Array.from({ length: 36 }, (_, i) => ({
    bearing_deg: i * 10,
    max_distance_nm: 0,
    position_count: 0,
    min_altitude: null,
    max_altitude: null,
    flight_count: 0,
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

describe("buildSectorWedges", () => {
  const config = { size: 300, padding: 24 };

  it("returns empty array when all sectors have zero distance", () => {
    const wedges = buildSectorWedges(makeSectors(), config);
    expect(wedges).toHaveLength(0);
  });

  it("filters out zero-distance sectors", () => {
    const sectors = makeSectors([
      { bearing_deg: 0, max_distance_nm: 100, position_count: 5 },
      { bearing_deg: 90, max_distance_nm: 50, position_count: 3 },
    ]);
    const wedges = buildSectorWedges(sectors, config);
    expect(wedges).toHaveLength(2);
    expect(wedges[0].bearingDeg).toBe(0);
    expect(wedges[1].bearingDeg).toBe(90);
  });

  it("wedge path starts with M (center), contains A (arc), ends with Z", () => {
    const sectors = makeSectors([
      { bearing_deg: 0, max_distance_nm: 100, position_count: 5 },
    ]);
    const wedges = buildSectorWedges(sectors, config);
    expect(wedges[0].path).toMatch(/^M/);
    expect(wedges[0].path).toContain("A");
    expect(wedges[0].path).toMatch(/Z$/);
  });

  it("preserves distance and position count in wedge data", () => {
    const sectors = makeSectors([
      { bearing_deg: 180, max_distance_nm: 75, position_count: 42 },
    ]);
    const wedges = buildSectorWedges(sectors, config);
    expect(wedges[0].distanceNm).toBe(75);
    expect(wedges[0].positionCount).toBe(42);
  });

  it("preserves min/max altitude in wedge data", () => {
    const sectors = makeSectors([
      { bearing_deg: 0, max_distance_nm: 100, position_count: 5, min_altitude: 1000, max_altitude: 40000 },
    ]);
    const wedges = buildSectorWedges(sectors, config);
    expect(wedges[0].minAltitude).toBe(1000);
    expect(wedges[0].maxAltitude).toBe(40000);
  });

  it("preserves null altitude in wedge data", () => {
    const sectors = makeSectors([
      { bearing_deg: 0, max_distance_nm: 100, position_count: 5, min_altitude: null, max_altitude: null },
    ]);
    const wedges = buildSectorWedges(sectors, config);
    expect(wedges[0].minAltitude).toBeNull();
    expect(wedges[0].maxAltitude).toBeNull();
  });

  it("returns wedges for all non-zero sectors", () => {
    const overrides = Array.from({ length: 36 }, (_, i) => ({
      bearing_deg: i * 10,
      max_distance_nm: (i + 1) * 5,
      position_count: 1,
    }));
    const wedges = buildSectorWedges(makeSectors(overrides), config);
    expect(wedges).toHaveLength(36);
  });
});

describe("resolveRingStep", () => {
  it("keeps the chosen step when it needs 5 rings or fewer", () => {
    expect(resolveRingStep(67, 25)).toEqual({ stepNm: 25, ringCount: 3, outerNm: 75 });
  });

  it("moves up to the next step when the chosen one would need more than 5 rings", () => {
    expect(resolveRingStep(180, 25)).toEqual({ stepNm: 50, ringCount: 4, outerNm: 200 });
  });

  it("auto picks the smallest step that fits in 5 rings", () => {
    expect(resolveRingStep(40, "auto")).toEqual({ stepNm: 10, ringCount: 4, outerNm: 40 });
    expect(resolveRingStep(400, "auto")).toEqual({ stepNm: 100, ringCount: 4, outerNm: 400 });
  });

  it("goes past the last listed step in multiples of it", () => {
    expect(resolveRingStep(1500, 25)).toEqual({ stepNm: 400, ringCount: 4, outerNm: 1600 });
  });

  it("never draws more than 5 rings", () => {
    for (const max of [1, 9, 51, 126, 249, 251, 999, 4321]) {
      for (const choice of ["auto", 10, 25, 50, 100] as const) {
        const { ringCount, outerNm } = resolveRingStep(max, choice);
        expect(ringCount).toBeGreaterThanOrEqual(1);
        expect(ringCount).toBeLessThanOrEqual(5);
        expect(outerNm).toBeGreaterThanOrEqual(max);
      }
    }
  });
});

describe("buildDistanceRings", () => {
  it("draws rings at round multiples of the step", () => {
    const rings = buildDistanceRings(67, 25);
    expect(rings.map((r) => r.label)).toEqual(["25 NM", "50 NM", "75 NM"]);
    expect(rings.map((r) => r.nm)).toEqual([25, 50, 75]);
  });

  it("outermost ring sits on the chart edge", () => {
    const config = { size: 300, padding: 24 };
    const rings = buildDistanceRings(120, 25, config);
    expect(rings[rings.length - 1].radius).toBeCloseTo(126);
  });

  it("ring radii increase evenly", () => {
    const rings = buildDistanceRings(100, 25);
    for (let i = 1; i < rings.length; i++) {
      expect(rings[i].radius - rings[i - 1].radius).toBeCloseTo(rings[0].radius);
    }
  });

  it("caps at 5 rings", () => {
    expect(buildDistanceRings(250, 10)).toHaveLength(5);
  });
});

describe("explicit radar scale", () => {
  const config = { size: 300, padding: 24 };
  const sectors = makeSectors([{ bearing_deg: 0, max_distance_nm: 50, position_count: 1 }]);

  it("buildRadarPoints scales to the given outer distance", () => {
    // 50 NM on a 100 NM scale → half of the 126 px radius, straight up.
    const north = buildRadarPoints(sectors, config, 100)[0];
    expect(north.y).toBeCloseTo(150 - 63, 0);
  });

  it("buildSectorWedges scales to the given outer distance", () => {
    const [wedge] = buildSectorWedges(sectors, config, 100);
    expect(wedge.path).toContain("A63.0,63.0");
  });

  it("defaults to the max range, as before", () => {
    const [wedge] = buildSectorWedges(sectors, config);
    expect(wedge.path).toContain("A126.0,126.0");
  });
});

describe("rebinBandCounts", () => {
  it("folds 5 NM bins into ring bands", () => {
    // bins: 0-5, 5-10, ..., 25-30 → 25 NM rings: [0-25) and [25-50)
    expect(rebinBandCounts([1, 2, 3, 0, 4, 5], RADAR_BAND_WIDTH_NM, 25, 3)).toEqual([10, 5, 0]);
  });

  it("puts anything beyond the outer ring into the last band, keeping the total", () => {
    const bins = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]; // 7 positions at 60-65 NM
    const rebinned = rebinBandCounts(bins, 5, 25, 2);
    expect(rebinned).toEqual([1, 7]);
  });

  it("returns zeros when there are no bins", () => {
    expect(rebinBandCounts(undefined, 5, 25, 3)).toEqual([0, 0, 0]);
  });
});

describe("buildDensityCells", () => {
  const config = { size: 300, padding: 24 };
  const sectors = makeSectors([
    { bearing_deg: 0, max_distance_nm: 40, position_count: 12, band_counts: [2, 0, 0, 0, 0, 0, 10] },
    { bearing_deg: 90, max_distance_nm: 10, position_count: 5, band_counts: [0, 5] },
  ]);

  it("returns one cell per non-empty sector × ring", () => {
    const cells = buildDensityCells(sectors, 25, 2, config);
    expect(cells.map((c) => [c.bearingDeg, c.ringIndex, c.count])).toEqual([
      [0, 0, 2],
      [0, 1, 10],
      [90, 0, 5],
    ]);
  });

  it("scales color intensity to the busiest cell", () => {
    const cells = buildDensityCells(sectors, 25, 2, config);
    expect(Math.max(...cells.map((c) => c.t))).toBe(1);
    expect(cells.find((c) => c.count === 5)!.t).toBeCloseTo(0.5);
  });

  it("draws an annular sector for outer rings and a wedge for the inner one", () => {
    const cells = buildDensityCells(sectors, 25, 2, config);
    const inner = cells.find((c) => c.ringIndex === 0)!;
    const outer = cells.find((c) => c.ringIndex === 1)!;
    expect(inner.path.startsWith("M150.0,150.0")).toBe(true);
    expect(outer.path.match(/A/g)).toHaveLength(2);
    expect(outer.path).toMatch(/Z$/);
  });

  it("scales cells to an explicit outer distance and clips the last one at the edge", () => {
    // 10 NM cells on a 75 NM scale: 8 cells, the last (70-80 NM) clipped to 75 NM.
    const one = makeSectors([
      { bearing_deg: 0, max_distance_nm: 74, position_count: 2, band_counts: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] },
    ]);
    const cells = buildDensityCells(one, 10, 8, config, RADAR_BAND_WIDTH_NM, 75);
    const first = cells.find((c) => c.ringIndex === 0)!;
    const last = cells.find((c) => c.ringIndex === 7)!;
    expect(first.path).toContain(`A${((10 / 75) * 126).toFixed(1)}`);
    expect(last.path).toContain("A126.0,126.0");
  });

  it("returns nothing when no sector carries bands", () => {
    expect(buildDensityCells(makeSectors([{ bearing_deg: 0, max_distance_nm: 9 }]), 25, 1, config)).toEqual([]);
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

describe("densityIntensity", () => {
  it("keeps empty at 0 and the busiest cell at 1", () => {
    expect(densityIntensity(0)).toBe(0);
    expect(densityIntensity(1)).toBe(1);
  });

  it("lifts sparse cells well above their linear share", () => {
    // 4% of the busiest cell: linear would sit in the near-invisible slate band.
    expect(densityIntensity(0.04)).toBeGreaterThanOrEqual(0.3);
  });

  it("starts any non-empty cell above the floor", () => {
    expect(densityIntensity(1e-6)).toBeGreaterThanOrEqual(0.15);
  });

  it("stays monotonic", () => {
    let prev = 0;
    for (let t = 0.01; t <= 1; t += 0.01) {
      const v = densityIntensity(t);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});
