import { describe, it, expect } from "vitest";
import {
  bearingDeg,
  changedPixels,
  destination,
  distanceM,
  findProbes,
  lineOfSight,
  pointInPolygon,
  type LngLat,
} from "../occlusion";

describe("destination / distanceM / bearingDeg", () => {
  it("moves north by the given distance", () => {
    const [lng, lat] = destination([0, 0], 0, 111_195);
    expect(lng).toBeCloseTo(0, 6);
    expect(lat).toBeCloseTo(1, 3);
  });

  it("round-trips through distance and bearing", () => {
    const a: LngLat = [-71.3, 44.27];
    const b = destination(a, 75, 5_000);
    expect(distanceM(a, b)).toBeCloseTo(5_000, 0);
    expect(bearingDeg(a, b)).toBeCloseTo(75, 3);
  });

  it("returns a bearing in [0, 360)", () => {
    expect(bearingDeg([0, 0], [-1, 0])).toBeCloseTo(270, 6);
  });
});

describe("pointInPolygon", () => {
  const square: LngLat[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

  it("is true inside and false outside", () => {
    expect(pointInPolygon([0.5, 0.5], square)).toBe(true);
    expect(pointInPolygon([1.5, 0.5], square)).toBe(false);
  });

  it("accepts an open ring", () => {
    expect(pointInPolygon([0.5, 0.5], square.slice(0, 4))).toBe(true);
  });
});

/** A 1000 m wall along the meridian lng = 0, flat ground (100 m) elsewhere. */
const wall = ([lng]: LngLat) => (Math.abs(lng) < 0.002 ? 1000 : 100);

describe("lineOfSight", () => {
  it("is blocked by a wall taller than the ray", () => {
    const r = lineOfSight({ lng: -0.1, lat: 0, alt: 500 }, { lng: 0.1, lat: 0, alt: 500 }, wall);
    expect(r.clear).toBe(false);
    expect(r.marginM).toBeCloseTo(-500, 0);
  });

  it("is clear over the wall, with the clearance as margin", () => {
    const r = lineOfSight({ lng: -0.1, lat: 0, alt: 1500 }, { lng: 0.1, lat: 0, alt: 1500 }, wall);
    expect(r.clear).toBe(true);
    expect(r.marginM).toBeCloseTo(500, 0);
  });

  it("ignores the ground right under the endpoints", () => {
    const r = lineOfSight({ lng: -0.1, lat: 0, alt: 101 }, { lng: -0.05, lat: 0, alt: 101 }, wall);
    expect(r.clear).toBe(true);
  });

  it("skips samples with no elevation", () => {
    const r = lineOfSight({ lng: -0.1, lat: 0, alt: 500 }, { lng: 0.1, lat: 0, alt: 500 }, () => null);
    expect(r.clear).toBe(true);
  });
});

describe("findProbes", () => {
  // A short wall: 1000 m high for |lat| < 0.01°, so a clear line exists beside it.
  const shortWall = ([lng, lat]: LngLat) => (Math.abs(lng) < 0.002 && Math.abs(lat) < 0.01 ? 1000 : 100);
  const camera = { lng: -0.2, lat: 0, alt: 1200 };

  it("finds a hidden aircraft behind the wall and a visible one beside it, at the same altitude", () => {
    const p = findProbes({
      camera,
      anchor: [0, 0],
      elevationAt: shortWall,
      distancesM: [1_000, 2_000],
      lateralM: [500, 1_000, 2_000, 4_000],
      clearanceM: 200,
      minMarginM: 50,
    });
    expect(p).not.toBeNull();
    expect(p!.hidden.alt).toBe(p!.visible.alt);
    expect(lineOfSight(camera, p!.hidden, shortWall).clear).toBe(false);
    expect(lineOfSight(camera, p!.visible, shortWall).clear).toBe(true);
    expect(p!.hiddenMarginM).toBeLessThanOrEqual(-50);
    expect(p!.visibleMarginM).toBeGreaterThanOrEqual(50);
  });

  it("returns null when nothing can hide an aircraft", () => {
    const flat = () => 100;
    expect(
      findProbes({ camera, anchor: [0, 0], elevationAt: flat, distancesM: [1_000], lateralM: [1_000], clearanceM: 200, minMarginM: 50 }),
    ).toBeNull();
  });
});

describe("changedPixels", () => {
  const px = (...rgba: number[]) => new Uint8ClampedArray(rgba);

  it("counts pixels whose largest channel difference exceeds the tolerance", () => {
    const a = px(0, 0, 0, 255, 10, 10, 10, 255, 50, 50, 50, 255);
    const b = px(0, 0, 0, 255, 20, 10, 10, 255, 50, 200, 50, 255);
    expect(changedPixels(a, b, 24)).toBe(1);
    expect(changedPixels(a, b, 5)).toBe(2);
  });

  it("refuses images of different sizes", () => {
    expect(() => changedPixels(px(0, 0, 0, 0), px(0, 0, 0, 0, 0, 0, 0, 0))).toThrow();
  });
});
