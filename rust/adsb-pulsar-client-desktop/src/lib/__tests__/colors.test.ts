import { describe, it, expect } from "vitest";
import { altitudeToColor, densityColor } from "../colors";

describe("altitudeToColor", () => {
  it("returns gray for null", () => {
    expect(altitudeToColor(null)).toBe("#888888");
  });

  it("returns blue-ish for 0ft", () => {
    const color = altitudeToColor(0);
    expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    // At 0ft ratio=0, t=0 → interpolate [0,0,255] to [0,255,255] at t=0 → rgb(0,0,255)
    expect(color).toBe("rgb(0,0,255)");
  });

  it("returns red-ish for 50000ft", () => {
    const color = altitudeToColor(50000);
    expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    // At 50000ft ratio=1, t=1 in last bracket → rgb(255,0,0)
    expect(color).toBe("rgb(255,0,0)");
  });

  it("returns valid rgb string for 25000ft", () => {
    const color = altitudeToColor(25000);
    expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it("clamps negative altitude to 0", () => {
    expect(altitudeToColor(-100)).toBe(altitudeToColor(0));
  });

  it("clamps altitude above 50000 to 50000", () => {
    expect(altitudeToColor(60000)).toBe(altitudeToColor(50000));
  });
});

describe("densityColor", () => {
  it("returns low opacity for 0", () => {
    const { fillOpacity } = densityColor(0);
    expect(fillOpacity).toBeCloseTo(0.08, 2);
  });

  it("returns high opacity for 1", () => {
    const { fillOpacity } = densityColor(1);
    expect(fillOpacity).toBeCloseTo(0.30, 2);
  });

  it("returns mid-range values for 0.5", () => {
    const { color, fillOpacity } = densityColor(0.5);
    expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    expect(fillOpacity).toBeGreaterThan(0.08);
    expect(fillOpacity).toBeLessThan(0.30);
  });

  it("returns rgb string format", () => {
    const { color } = densityColor(0.3);
    expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });
});
