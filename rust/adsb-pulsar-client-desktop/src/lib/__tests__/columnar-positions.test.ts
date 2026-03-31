import { describe, it, expect } from "vitest";
import { ColumnarPositions, isColumnar } from "../types";

describe("ColumnarPositions", () => {
  const lat = new Float64Array([45.5, 45.6, 45.7]);
  const lng = new Float64Array([-73.5, -73.4, -73.3]);
  const alt = new Float64Array([35000, NaN, 37000]); // NaN = null altitude

  it("stores length from lat array", () => {
    const cp = new ColumnarPositions(lat, lng, alt);
    expect(cp.length).toBe(3);
  });

  it("get() returns tuple with NaN converted to null", () => {
    const cp = new ColumnarPositions(lat, lng, alt);
    expect(cp.get(0)).toEqual([45.5, -73.5, 35000]);
    expect(cp.get(1)).toEqual([45.6, -73.4, null]);
    expect(cp.get(2)).toEqual([45.7, -73.3, 37000]);
  });

  it("is iterable via for...of", () => {
    const cp = new ColumnarPositions(lat, lng, alt);
    const tuples: [number, number, number | null][] = [];
    for (const pos of cp) {
      tuples.push(pos);
    }
    expect(tuples).toEqual([
      [45.5, -73.5, 35000],
      [45.6, -73.4, null],
      [45.7, -73.3, 37000],
    ]);
  });

  it("supports spread syntax", () => {
    const cp = new ColumnarPositions(lat, lng, alt);
    const arr = [...cp];
    expect(arr).toHaveLength(3);
    expect(arr[0]).toEqual([45.5, -73.5, 35000]);
  });

  it("handles empty arrays", () => {
    const cp = new ColumnarPositions(
      new Float64Array(0),
      new Float64Array(0),
      new Float64Array(0),
    );
    expect(cp.length).toBe(0);
    expect([...cp]).toEqual([]);
  });

  it("exposes raw typed arrays for direct columnar access", () => {
    const cp = new ColumnarPositions(lat, lng, alt);
    expect(cp.lat).toBe(lat);
    expect(cp.lng).toBe(lng);
    expect(cp.alt).toBe(alt);
  });

  it("handles subarrayed Float64Arrays (shared buffer)", () => {
    const bigLat = new Float64Array([10, 20, 30, 40, 50]);
    const bigLng = new Float64Array([1, 2, 3, 4, 5]);
    const bigAlt = new Float64Array([100, 200, NaN, 400, 500]);
    // Subarray shares the same underlying ArrayBuffer
    const cp = new ColumnarPositions(
      bigLat.subarray(1, 4),
      bigLng.subarray(1, 4),
      bigAlt.subarray(1, 4),
    );
    expect(cp.length).toBe(3);
    expect(cp.get(0)).toEqual([20, 2, 200]);
    expect(cp.get(1)).toEqual([30, 3, null]);
    expect(cp.get(2)).toEqual([40, 4, 400]);
  });
});

describe("isColumnar", () => {
  it("returns true for ColumnarPositions", () => {
    const cp = new ColumnarPositions(
      new Float64Array([1]),
      new Float64Array([2]),
      new Float64Array([3]),
    );
    expect(isColumnar(cp)).toBe(true);
  });

  it("returns false for tuple array", () => {
    const tuples: [number, number, number | null][] = [[1, 2, 3]];
    expect(isColumnar(tuples)).toBe(false);
  });

  it("returns false for empty tuple array", () => {
    expect(isColumnar([])).toBe(false);
  });
});
