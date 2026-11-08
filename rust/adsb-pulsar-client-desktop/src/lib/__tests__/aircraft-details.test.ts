import { describe, it, expect } from "vitest";
import {
  verticalTendency,
  formatVerticalRate,
  altitudeHistory,
  altitudeSparklinePoints,
  altitudeRange,
  formatTrackTime,
  receiverDistanceNm,
  formatDistance,
  receiverAzimuthDeg,
  receiverElevationDeg,
  formatAngle,
} from "../aircraft-details";

describe("verticalTendency", () => {
  it("returns level for null vertical_rate", () => {
    expect(verticalTendency(null)).toBe("level");
  });

  it("returns climbing for rate above threshold (+300 ft/min)", () => {
    expect(verticalTendency(300)).toBe("climbing");
  });

  it("returns descending for rate below negative threshold (-300 ft/min)", () => {
    expect(verticalTendency(-300)).toBe("descending");
  });

  it("returns level for small positive rate below threshold (+50 ft/min)", () => {
    expect(verticalTendency(50)).toBe("level");
  });

  it("returns level for small negative rate above negative threshold (-50 ft/min)", () => {
    expect(verticalTendency(-50)).toBe("level");
  });

  it("returns level for exactly zero", () => {
    expect(verticalTendency(0)).toBe("level");
  });

  it("returns climbing for exactly threshold boundary (+200 ft/min)", () => {
    expect(verticalTendency(200)).toBe("climbing");
  });

  it("returns descending for exactly negative threshold (-200 ft/min)", () => {
    expect(verticalTendency(-200)).toBe("descending");
  });
});

describe("formatVerticalRate", () => {
  it("returns em dash for null", () => {
    expect(formatVerticalRate(null)).toBe("—");
  });

  it("formats positive rate with + sign and comma separator", () => {
    expect(formatVerticalRate(2400)).toBe("+2,400 ft/min");
  });

  it("formats negative rate with minus sign", () => {
    expect(formatVerticalRate(-800)).toBe("-800 ft/min");
  });

  it("formats zero with ± sign", () => {
    expect(formatVerticalRate(0)).toBe("±0 ft/min");
  });

  it("formats large positive rate", () => {
    expect(formatVerticalRate(12000)).toBe("+12,000 ft/min");
  });
});

describe("altitudeHistory", () => {
  it("returns empty array for empty positions", () => {
    expect(altitudeHistory([])).toEqual([]);
  });

  it("extracts altitude component (index 2) from positions", () => {
    const positions: [number, number, number | null][] = [
      [45.5, -73.6, 10000],
      [45.6, -73.7, 15000],
      [45.7, -73.8, 20000],
    ];
    expect(altitudeHistory(positions)).toEqual([10000, 15000, 20000]);
  });

  it("filters out null altitude values", () => {
    const positions: [number, number, number | null][] = [
      [45.5, -73.6, 10000],
      [45.6, -73.7, null],
      [45.7, -73.8, 20000],
    ];
    expect(altitudeHistory(positions)).toEqual([10000, 20000]);
  });

  it("returns empty array when all altitudes are null", () => {
    const positions: [number, number, number | null][] = [
      [45.5, -73.6, null],
      [45.6, -73.7, null],
    ];
    expect(altitudeHistory(positions)).toEqual([]);
  });
});

describe("altitudeSparklinePoints", () => {
  it("returns empty string for empty altitude array", () => {
    expect(altitudeSparklinePoints([], 120, 40)).toBe("");
  });

  it("returns a valid point string for a single altitude", () => {
    const result = altitudeSparklinePoints([35000], 120, 40);
    expect(result).toBeTruthy();
    // Single point: x=0, y=some number
    expect(result).toMatch(/^\d+(\.\d+)?,\d+(\.\d+)?$/);
  });

  it("returns correct number of points for multi-value array", () => {
    const altitudes = [10000, 20000, 30000];
    const result = altitudeSparklinePoints(altitudes, 120, 40);
    // 3 points separated by spaces
    const points = result.trim().split(" ");
    expect(points).toHaveLength(3);
  });

  it("maps min altitude to bottom of viewbox and max to top", () => {
    const altitudes = [10000, 20000];
    const result = altitudeSparklinePoints(altitudes, 100, 40);
    const points = result.trim().split(" ");
    const [x0, y0] = points[0].split(",").map(Number);
    const [x1, y1] = points[1].split(",").map(Number);
    // First point (min altitude) should be at bottom (y=40) or near it
    expect(y0).toBeCloseTo(40, 0);
    // Second point (max altitude) should be at top (y=0) or near it
    expect(y1).toBeCloseTo(0, 0);
    // x values should span the width
    expect(x0).toBeCloseTo(0, 0);
    expect(x1).toBeCloseTo(100, 0);
  });

  it("uses single point at x=0 for one-element array", () => {
    const result = altitudeSparklinePoints([35000], 120, 40);
    expect(result.startsWith("0,")).toBe(true);
  });

  it("handles flat altitude (all same) without division by zero", () => {
    const altitudes = [35000, 35000, 35000];
    const result = altitudeSparklinePoints(altitudes, 120, 40);
    expect(result).toBeTruthy();
    const points = result.trim().split(" ");
    expect(points).toHaveLength(3);
  });
});

describe("altitudeRange", () => {
  it("returns null for empty array", () => {
    expect(altitudeRange([])).toBeNull();
  });

  it("returns same min and max for single value", () => {
    expect(altitudeRange([35000])).toEqual({ min: 35000, max: 35000 });
  });

  it("returns correct min and max for multiple values", () => {
    expect(altitudeRange([10000, 35000, 20000])).toEqual({ min: 10000, max: 35000 });
  });
});

describe("formatTrackTime", () => {
  it("returns a string matching HH:MM format", () => {
    // Use a known timestamp: 2026-02-19T14:30:00 UTC
    const ms = new Date("2026-02-19T14:30:00Z").getTime();
    const result = formatTrackTime(ms);
    // Should be three colon-separated 2-digit numbers (HH:MM:SS)
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("returns different strings for timestamps 1 hour apart", () => {
    const base = new Date("2026-02-19T10:00:00Z").getTime();
    const later = base + 60 * 60 * 1000;
    const r1 = formatTrackTime(base);
    const r2 = formatTrackTime(later);
    // In any timezone, 1-hour difference means at least one digit must differ
    expect(r1).not.toBe(r2);
  });

  it("with tzName='UTC' returns HH:MM:SS in UTC", () => {
    // 2026-02-23T15:30:45Z — UTC hour is 15
    const ms = new Date("2026-02-23T15:30:45Z").getTime();
    const result = formatTrackTime(ms, "UTC");
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(result).toBe("15:30:45");
  });
});

describe("receiverDistanceNm", () => {
  const receiver = { lat: 45.5, lng: -73.6 };

  it("is zero over the receiver", () => {
    expect(receiverDistanceNm({ latitude: 45.5, longitude: -73.6 }, receiver)).toBeCloseTo(0, 6);
  });

  it("measures the great-circle distance: one degree of latitude is 60 NM", () => {
    expect(receiverDistanceNm({ latitude: 46.5, longitude: -73.6 }, receiver)).toBeCloseTo(60.04, 1);
  });

  it("is null without a position or a receiver", () => {
    expect(receiverDistanceNm({ latitude: null, longitude: -73.6 }, receiver)).toBeNull();
    expect(receiverDistanceNm({ latitude: 45.5, longitude: null }, receiver)).toBeNull();
    expect(receiverDistanceNm({ latitude: 45.5, longitude: -73.6 }, null)).toBeNull();
    expect(receiverDistanceNm({ latitude: 45.5, longitude: -73.6 }, undefined)).toBeNull();
  });
});

describe("formatDistance", () => {
  it("shows kilometres and nautical miles (1 NM = 1.852 km)", () => {
    expect(formatDistance(10)).toBe("18.5 km / 10.0 NM");
  });

  it("keeps one decimal at short range", () => {
    expect(formatDistance(0.27)).toBe("0.5 km / 0.3 NM");
  });

  it("drops the decimal from 100 upward", () => {
    expect(formatDistance(150)).toBe("278 km / 150 NM");
    expect(formatDistance(60)).toBe("111 km / 60.0 NM");
  });
});

describe("receiverAzimuthDeg", () => {
  const receiver = { lat: 45.5, lng: -73.6 };
  const at = (latitude: number | null, longitude: number | null) => ({ latitude, longitude });

  it("is the true bearing from the receiver, 0..360", () => {
    expect(receiverAzimuthDeg(at(46.5, -73.6), receiver)).toBeCloseTo(0, 6);
    expect(receiverAzimuthDeg(at(44.5, -73.6), receiver)).toBeCloseTo(180, 6);
    // Great-circle initial bearing: due east along a parallel is not quite 90°.
    expect(receiverAzimuthDeg(at(45.5, -72.6), receiver)).toBeCloseTo(89.643, 2);
    expect(receiverAzimuthDeg(at(45.0, -74.3), receiver)).toBeCloseTo(224.834, 2);
  });

  it("is null without a position, a receiver, or any separation", () => {
    expect(receiverAzimuthDeg(at(null, -73.6), receiver)).toBeNull();
    expect(receiverAzimuthDeg(at(46.5, -73.6), null)).toBeNull();
    expect(receiverAzimuthDeg(at(45.5, -73.6), receiver)).toBeNull();
  });
});

describe("receiverElevationDeg", () => {
  const track = (altitude: number | null, latitude: number | null = 46.5, longitude: number | null = -73.6) =>
    ({ latitude, longitude, altitude });

  it("accounts for Earth curvature (60 NM out at 35,000 ft)", () => {
    // Flat-earth would say atan(10668 m / 111 km) = 5.48°.
    expect(receiverElevationDeg(track(35000), { lat: 45.5, lng: -73.6, alt: 0 })).toBeCloseTo(4.975, 2);
  });

  it("subtracts the receiver's own altitude (both in feet)", () => {
    expect(receiverElevationDeg(track(35000), { lat: 45.5, lng: -73.6, alt: 1000 })).toBeCloseTo(4.82, 2);
  });

  it("goes negative below the receiver's horizon", () => {
    expect(receiverElevationDeg(track(0, 45.5, -72.32), { lat: 45.5, lng: -73.6, alt: 0 })).toBeCloseTo(-0.449, 2);
  });

  it("treats an unknown receiver altitude as sea level", () => {
    expect(receiverElevationDeg(track(35000), { lat: 45.5, lng: -73.6, alt: null }))
      .toBeCloseTo(receiverElevationDeg(track(35000), { lat: 45.5, lng: -73.6, alt: 0 })!, 9);
    expect(receiverElevationDeg(track(35000), { lat: 45.5, lng: -73.6 })).toBeCloseTo(4.975, 2);
  });

  it("is 90° straight overhead", () => {
    expect(receiverElevationDeg(track(10000, 45.5, -73.6), { lat: 45.5, lng: -73.6, alt: 0 })).toBeCloseTo(90, 6);
  });

  it("is null without an altitude, a position or a receiver", () => {
    expect(receiverElevationDeg(track(null), { lat: 45.5, lng: -73.6 })).toBeNull();
    expect(receiverElevationDeg(track(35000, null), { lat: 45.5, lng: -73.6 })).toBeNull();
    expect(receiverElevationDeg(track(35000), null)).toBeNull();
  });
});

describe("formatAngle", () => {
  it("shows one decimal and a degree sign, keeping the sign", () => {
    expect(formatAngle(89.643)).toBe("89.6°");
    expect(formatAngle(-0.449)).toBe("-0.4°");
    expect(formatAngle(0)).toBe("0.0°");
  });

  it("wraps an azimuth that rounds up to 360 back to 0", () => {
    expect(formatAngle(359.97, { wrap360: true })).toBe("0.0°");
  });
});
