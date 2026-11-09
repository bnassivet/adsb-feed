import { describe, it, expect } from "vitest";
import { buildDotBuffers, cssToRgb, locateDot } from "../deck-dots";
import { cachedAltitudeToColor } from "../colors";
import { ColumnarPositions, type AircraftTrack, type Positions } from "../types";

function track(hex: string, positions: Positions, extra: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: hex, callsign: null, altitude: 30_000, ground_speed: null, track: null,
    latitude: null, longitude: null, vertical_rate: null, squawk: null, is_on_ground: null,
    timestamp: "", positions, first_seen: 0, last_seen: 0, ...extra,
  } as AircraftTrack;
}

const col = (rows: [number, number, number | null][]) =>
  new ColumnarPositions(
    Float64Array.from(rows.map((r) => r[0])),
    Float64Array.from(rows.map((r) => r[1])),
    Float64Array.from(rows.map((r) => r[2] ?? NaN)),
  );

describe("cssToRgb", () => {
  it("parses the app's rgb() and hex forms", () => {
    expect(cssToRgb("rgb(0,128,255)")).toEqual([0, 128, 255]);
    expect(cssToRgb("rgb( 1, 2 ,3 )")).toEqual([1, 2, 3]);
    expect(cssToRgb("#888888")).toEqual([0x88, 0x88, 0x88]);
    expect(cssToRgb("#06b6d4")).toEqual([0x06, 0xb6, 0xd4]);
  });
});

describe("buildDotBuffers", () => {
  const a = track("A", [[45, -73, 10_000], [45.1, -73.1, null], [45.2, -73.2, 20_000]]);
  const b = track("B", col([[46, -74, 5_000], [46.1, -74.1, 6_000]]), { track_id: "B#1" });
  const tooShort = track("C", [[47, -75, 1_000]]);

  it("packs lng/lat of every drawable track, tuple and columnar alike", () => {
    const buf = buildDotBuffers([a, tooShort, b], { colorMode: "plot", theme: "dark", alpha: 0.4 });
    expect(buf.length).toBe(5);
    expect(Array.from(buf.starts)).toEqual([0, 3, 5]);
    expect(buf.tracks.map((t) => t.hex_ident)).toEqual(["A", "B"]);
    expect(buf.positions[0]).toBeCloseTo(-73);
    expect(buf.positions[1]).toBeCloseTo(45);
    expect(buf.positions[2 * 4]).toBeCloseTo(-74.1);
    expect(buf.positions[2 * 4 + 1]).toBeCloseTo(46.1);
  });

  it("colours per point in plot mode, matching the app's altitude scale and theme", () => {
    for (const theme of ["dark", "light"] as const) {
      const buf = buildDotBuffers([a], { colorMode: "plot", theme, alpha: 0.4 });
      const rgbAt = (i: number) => Array.from(buf.colors.slice(4 * i, 4 * i + 3));
      expect(rgbAt(0)).toEqual(cssToRgb(cachedAltitudeToColor(10_000, theme)));
      expect(rgbAt(1)).toEqual(cssToRgb(cachedAltitudeToColor(null, theme)));
      expect(rgbAt(2)).toEqual(cssToRgb(cachedAltitudeToColor(20_000, theme)));
      expect(buf.colors[3]).toBe(Math.round(0.4 * 255));
    }
  });

  it("colours every point with the track altitude in track mode", () => {
    const buf = buildDotBuffers([a], { colorMode: "track", theme: "dark", alpha: 1 });
    const expected = cssToRgb(cachedAltitudeToColor(30_000, "dark"));
    for (let i = 0; i < 3; i++) expect(Array.from(buf.colors.slice(4 * i, 4 * i + 3))).toEqual(expected);
  });

  it("restricts to the given track keys (the selected overlay)", () => {
    const buf = buildDotBuffers([a, b], { colorMode: "plot", theme: "dark", alpha: 0.9, only: new Set(["B#1"]) });
    expect(buf.tracks.map((t) => t.hex_ident)).toEqual(["B"]);
    expect(buf.length).toBe(2);
  });

  it("is empty for no tracks", () => {
    const buf = buildDotBuffers([], { colorMode: "plot", theme: "dark", alpha: 1 });
    expect(buf.length).toBe(0);
    expect(Array.from(buf.starts)).toEqual([0]);
  });
});

describe("locateDot", () => {
  it("maps a picked index back to its track, point, altitude and last-point flag", () => {
    const a = track("A", [[45, -73, 10_000], [45.1, -73.1, null], [45.2, -73.2, 20_000]]);
    const b = track("B", col([[46, -74, 5_000], [46.1, -74.1, NaN]]));
    const buf = buildDotBuffers([a, b], { colorMode: "plot", theme: "dark", alpha: 1 });

    expect(locateDot(buf, 0)).toMatchObject({ track: a, index: 0, lat: 45, lng: -73, alt: 10_000, isLast: false });
    expect(locateDot(buf, 1)).toMatchObject({ track: a, index: 1, alt: null, isLast: false });
    expect(locateDot(buf, 2)).toMatchObject({ track: a, index: 2, isLast: true });
    expect(locateDot(buf, 3)).toMatchObject({ track: b, index: 0, lat: 46, alt: 5_000 });
    expect(locateDot(buf, 4)).toMatchObject({ track: b, index: 1, alt: null, isLast: true });
  });

  it("returns null out of range", () => {
    const buf = buildDotBuffers([], { colorMode: "plot", theme: "dark", alpha: 1 });
    expect(locateDot(buf, 0)).toBeNull();
    expect(locateDot(buf, -1)).toBeNull();
  });
});
