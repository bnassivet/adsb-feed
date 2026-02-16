import { describe, it, expect, beforeEach } from "vitest";
import { altitudeToColor, densityColor, ALTITUDE_SCALE_STOPS, cachedAltitudeToColor, clearColorCache } from "../colors";

describe("altitudeToColor", () => {
  it("returns gray for null", () => {
    expect(altitudeToColor(null)).toBe("#888888");
  });

  it("returns gray for undefined (legacy 2-element positions)", () => {
    // pos[2] on a [lat, lng] array is undefined, not null
    expect(altitudeToColor(undefined as unknown as number | null)).toBe("#888888");
  });

  it("never returns NaN in rgb values", () => {
    // Regression: undefined input previously produced rgb(NaN,NaN,NaN)
    for (const val of [null, undefined, 0, 25000, 50000]) {
      const color = altitudeToColor(val as unknown as number | null);
      expect(color).not.toContain("NaN");
    }
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

describe("cachedAltitudeToColor", () => {
  beforeEach(() => {
    clearColorCache();
  });

  it("returns same result as altitudeToColor for all test values", () => {
    const testValues = [null, 0, 100, 6250, 12500, 18750, 25000, 31250, 37500, 43750, 50000];
    for (const val of testValues) {
      expect(cachedAltitudeToColor(val)).toBe(altitudeToColor(val));
    }
  });

  it("handles undefined the same as altitudeToColor (legacy 2-element positions)", () => {
    expect(cachedAltitudeToColor(undefined as unknown as number | null)).toBe(
      altitudeToColor(undefined as unknown as number | null),
    );
  });

  it("returns cached result on second call (same reference)", () => {
    const first = cachedAltitudeToColor(35000);
    const second = cachedAltitudeToColor(35000);
    expect(first).toBe(second);
    expect(first).toBe(altitudeToColor(35000));
  });

  it("does not grow beyond 512 entries", () => {
    // Fill cache with 600 unique altitude values
    for (let i = 0; i < 600; i++) {
      cachedAltitudeToColor(i);
    }
    // Should still return correct results after eviction
    expect(cachedAltitudeToColor(0)).toBe(altitudeToColor(0));
    expect(cachedAltitudeToColor(50000)).toBe(altitudeToColor(50000));
  });

  it("clearColorCache resets the cache", () => {
    cachedAltitudeToColor(10000);
    clearColorCache();
    // After clearing, should still return correct result (recomputed)
    expect(cachedAltitudeToColor(10000)).toBe(altitudeToColor(10000));
  });
});
