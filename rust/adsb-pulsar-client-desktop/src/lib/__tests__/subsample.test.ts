import { describe, it, expect } from "vitest";
import { subsamplePositions } from "../subsample";
import { ColumnarPositions } from "../types";

/** Helper: create ColumnarPositions from plain arrays. */
function makeColumnar(
  lats: number[],
  lngs: number[],
  alts: number[],
): ColumnarPositions {
  return new ColumnarPositions(
    Float64Array.from(lats),
    Float64Array.from(lngs),
    Float64Array.from(alts),
  );
}

/** Helper: create tuple positions. */
function makeTuples(
  coords: [number, number, number | null][],
): [number, number, number | null][] {
  return coords;
}

const fullBounds = { north: 90, south: -90, east: 180, west: -180 };

describe("subsamplePositions", () => {
  it("returns all indices at max zoom with spread-out positions", () => {
    const positions = makeColumnar([10, 20, 30], [10, 20, 30], [0, 0, 0]);
    const indices = subsamplePositions(positions, 18, fullBounds);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("deduplicates overlapping positions at low zoom", () => {
    // These positions are very close together — at low zoom they map to same pixel
    const n = 100;
    const lats = Array.from({ length: n }, () => 48.8566);
    const lngs = Array.from({ length: n }, () => 2.3522);
    const alts = Array.from({ length: n }, () => 35000);
    const positions = makeColumnar(lats, lngs, alts);
    const indices = subsamplePositions(positions, 3, fullBounds);
    // All map to same pixel, so only 1 index
    expect(indices.length).toBe(1);
    expect(indices[0]).toBe(0);
  });

  it("filters out-of-bounds positions", () => {
    const positions = makeColumnar([10, 50, 30], [10, 50, 30], [0, 0, 0]);
    const bounds = { north: 40, south: 0, east: 40, west: 0 };
    const indices = subsamplePositions(positions, 18, bounds);
    // Only positions 0 and 2 are in bounds (lat=10,lng=10 and lat=30,lng=30)
    expect(indices).toEqual([0, 2]);
  });

  it("returns empty array for empty positions", () => {
    const positions = makeColumnar([], [], []);
    const indices = subsamplePositions(positions, 10, fullBounds);
    expect(indices).toEqual([]);
  });

  it("works with tuple positions", () => {
    const positions = makeTuples([[10, 10, 0], [20, 20, 0], [30, 30, 0]]);
    const indices = subsamplePositions(positions, 18, fullBounds);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("reduces significantly at low zoom with clustered data", () => {
    // 1000 positions in a very small area — at zoom 2, most overlap the same pixel
    const n = 1000;
    // Spread < 0.01 degree — at zoom 2, scale=1024, that's ~10 pixels
    const lats = Array.from({ length: n }, (_, i) => 48.85 + (i % 10) * 0.0001);
    const lngs = Array.from({ length: n }, (_, i) => 2.35 + Math.floor(i / 10) * 0.0001);
    const alts = Array.from({ length: n }, () => 35000);
    const positions = makeColumnar(lats, lngs, alts);
    const indices = subsamplePositions(positions, 2, fullBounds);
    // Should be significantly fewer than 1000
    expect(indices.length).toBeLessThan(100);
    expect(indices.length).toBeGreaterThan(0);
  });

  it("at high zoom with spread-out data, keeps most positions", () => {
    const n = 100;
    // Positions spread over 1 degree — at zoom 15, each is a different pixel
    const lats = Array.from({ length: n }, (_, i) => 48 + i * 0.01);
    const lngs = Array.from({ length: n }, (_, i) => 2 + i * 0.01);
    const alts = Array.from({ length: n }, () => 35000);
    const positions = makeColumnar(lats, lngs, alts);
    const indices = subsamplePositions(positions, 15, fullBounds);
    expect(indices.length).toBe(n);
  });
});
