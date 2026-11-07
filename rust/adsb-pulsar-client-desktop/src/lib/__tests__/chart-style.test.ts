import { describe, it, expect } from "vitest";
import { roundedTopRectPath, topEdgePath, frostedTooltipStyle } from "../chart-style";

describe("roundedTopRectPath", () => {
  it("rounds only the top corners", () => {
    expect(roundedTopRectPath(0, 0, 10, 20, 4)).toBe("M 0 20 L 0 4 Q 0 0 4 0 L 6 0 Q 10 0 10 4 L 10 20 Z");
  });

  it("clamps the radius to half the width (thin bars) and to the height (short bars)", () => {
    expect(roundedTopRectPath(0, 0, 4, 20, 4)).toBe("M 0 20 L 0 2 Q 0 0 2 0 L 2 0 Q 4 0 4 2 L 4 20 Z");
    expect(roundedTopRectPath(0, 0, 10, 1, 4)).toBe("M 0 1 L 0 1 Q 0 0 1 0 L 9 0 Q 10 0 10 1 L 10 1 Z");
  });

  it("draws a plain rectangle with radius 0", () => {
    expect(roundedTopRectPath(2, 3, 10, 5, 0)).toBe("M 2 8 L 2 3 Q 2 3 2 3 L 12 3 Q 12 3 12 3 L 12 8 Z");
  });

  it("returns an empty path for zero-size or invalid bars", () => {
    expect(roundedTopRectPath(0, 0, 0, 10, 4)).toBe("");
    expect(roundedTopRectPath(0, 0, 10, 0, 4)).toBe("");
    expect(roundedTopRectPath(0, 0, Number.NaN, 10, 4)).toBe("");
  });
});

describe("topEdgePath", () => {
  it("traces just the top edge, following the rounded corners", () => {
    expect(topEdgePath(0, 0, 10, 20, 4)).toBe("M 0 4 Q 0 0 4 0 L 6 0 Q 10 0 10 4");
  });

  it("returns an empty path for zero-size bars", () => {
    expect(topEdgePath(0, 0, 10, 0, 4)).toBe("");
  });
});

describe("frostedTooltipStyle", () => {
  it("is translucent with a backdrop blur", () => {
    expect(frostedTooltipStyle.backgroundColor).toMatch(/^rgba\(.*0\.7\d*\)$/);
    expect(frostedTooltipStyle.backdropFilter).toMatch(/blur/);
  });
});
