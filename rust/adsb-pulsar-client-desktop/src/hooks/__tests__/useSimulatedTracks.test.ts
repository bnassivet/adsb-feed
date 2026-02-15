import { describe, it, expect } from "vitest";
import { computeHeading, interpolate } from "../useSimulatedTracks";

describe("computeHeading", () => {
  it("north direction (lat increases)", () => {
    const heading = computeHeading(0, 0, 1, 0);
    expect(heading).toBeCloseTo(0, 0);
  });

  it("east direction (lng increases)", () => {
    const heading = computeHeading(0, 0, 0, 1);
    expect(heading).toBeCloseTo(90, 0);
  });

  it("south direction (lat decreases)", () => {
    const heading = computeHeading(1, 0, 0, 0);
    expect(heading).toBeCloseTo(180, 0);
  });

  it("west direction (lng decreases)", () => {
    const heading = computeHeading(0, 0, 0, -1);
    expect(heading).toBeCloseTo(270, 0);
  });
});

describe("interpolate", () => {
  it("returns midpoint at t=0.5", () => {
    const result = interpolate([0, 0], [10, 10], 0.5);
    expect(result[0]).toBe(5);
    expect(result[1]).toBe(5);
  });

  it("returns start at t=0", () => {
    const result = interpolate([3, 7], [10, 20], 0);
    expect(result[0]).toBe(3);
    expect(result[1]).toBe(7);
  });

  it("returns end at t=1", () => {
    const result = interpolate([3, 7], [10, 20], 1);
    expect(result[0]).toBe(10);
    expect(result[1]).toBe(20);
  });
});
