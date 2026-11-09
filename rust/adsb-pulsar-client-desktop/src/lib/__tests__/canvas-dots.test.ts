import { describe, it, expect } from "vitest";
import { worldPx, buildDotBuckets, ALT_BIN_FT, NULL_BIN } from "../canvas-dots";

describe("worldPx", () => {
  it("projects to Leaflet's zoom-0 pixel space (one 256 px world)", () => {
    expect(worldPx(0, 0)).toEqual([128, 128]);
    expect(worldPx(0, 180)[0]).toBeCloseTo(256);
    expect(worldPx(0, -180)[0]).toBeCloseTo(0);
    expect(worldPx(85.0511287798, 0)[1]).toBeCloseTo(0, 4);
  });

  it("matches Leaflet's own projection at zoom 0", async () => {
    const L = (await import("leaflet")).default;
    const p = L.CRS.EPSG3857.latLngToPoint(L.latLng(45.5, -73.6), 0);
    const [x, y] = worldPx(45.5, -73.6);
    expect(x).toBeCloseTo(p.x, 9);
    expect(y).toBeCloseTo(p.y, 9);
  });
});

describe("buildDotBuckets", () => {
  const lat = Float64Array.from([1, 2, 3, 4, 5]);
  const lng = Float64Array.from([10, 20, 30, 40, 50]);

  it("groups points by 1000 ft altitude bin, ascending, unknown altitude last", () => {
    const alt = Float64Array.from([35_200, 500, NaN, 35_900, 999]);
    const b = buildDotBuckets(lat, lng, alt);
    expect(b.bins).toEqual([0, 35, NULL_BIN]);
    expect(Array.from(b.starts)).toEqual([0, 2, 4, 5]);
    // within the 0 bin: points 1 and 4, input order kept
    expect(b.x[0]).toBeCloseTo(worldPx(2, 20)[0]);
    expect(b.x[1]).toBeCloseTo(worldPx(5, 50)[0]);
    expect(b.y[4]).toBeCloseTo(worldPx(3, 30)[1]);
    expect(b.count).toBe(5);
  });

  it("clamps out-of-range altitudes into the first and last bins", () => {
    const b = buildDotBuckets(lat.subarray(0, 2), lng.subarray(0, 2), Float64Array.from([-300, 80_000]));
    expect(b.bins).toEqual([0, 50_000 / ALT_BIN_FT]);
  });

  it("handles no points", () => {
    const b = buildDotBuckets(new Float64Array(), new Float64Array(), new Float64Array());
    expect(b.bins).toEqual([]);
    expect(Array.from(b.starts)).toEqual([0]);
  });
});
