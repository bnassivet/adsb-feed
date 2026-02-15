import { describe, it, expect } from "vitest";
import { altitudeToColor, densityColor, ALTITUDE_SCALE_STOPS } from "../colors";

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

describe("ALTITUDE_SCALE_STOPS", () => {
  it("covers range from 0 to 50000 ft", () => {
    expect(ALTITUDE_SCALE_STOPS[0].altitude).toBe(0);
    expect(ALTITUDE_SCALE_STOPS[ALTITUDE_SCALE_STOPS.length - 1].altitude).toBe(50000);
  });

  it("has valid RGB colors for all stops", () => {
    for (const stop of ALTITUDE_SCALE_STOPS) {
      expect(stop.color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    }
  });

  it("has at least 5 stops for a smooth gradient", () => {
    expect(ALTITUDE_SCALE_STOPS.length).toBeGreaterThanOrEqual(5);
  });

  it("has altitudes in ascending order", () => {
    for (let i = 1; i < ALTITUDE_SCALE_STOPS.length; i++) {
      expect(ALTITUDE_SCALE_STOPS[i].altitude).toBeGreaterThan(ALTITUDE_SCALE_STOPS[i - 1].altitude);
    }
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
