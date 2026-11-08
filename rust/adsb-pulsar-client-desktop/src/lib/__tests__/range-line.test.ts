import { describe, it, expect } from "vitest";
import { greatCirclePoints, rangeLineLabel, rangeLineTargets, midpoint } from "../range-line";
import { haversineDistanceNm } from "../geo";
import type { AircraftTrack } from "../types";

function makeTrack(overrides: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "ABC123",
    callsign: "UAL123",
    altitude: 35000,
    ground_speed: 450,
    track: 180,
    latitude: 45.5,
    longitude: -73.6,
    vertical_rate: 0,
    squawk: null,
    is_on_ground: false,
    timestamp: "",
    positions: [],
    first_seen: 0,
    last_seen: 0,
    message_count: 1,
    ...overrides,
  };
}

const d = (a: [number, number], b: [number, number]) => haversineDistanceNm(a[0], a[1], b[0], b[1]);

describe("greatCirclePoints", () => {
  const from: [number, number] = [45.5, -73.6];
  const to: [number, number] = [48.9, -66.2];

  it("starts and ends exactly at the endpoints, with segments + 1 points", () => {
    const pts = greatCirclePoints(from, to, 32);
    expect(pts).toHaveLength(33);
    expect(pts[0]).toEqual(from);
    expect(pts[32]).toEqual(to);
  });

  it("puts every point on the great circle between them", () => {
    const total = d(from, to);
    for (const p of greatCirclePoints(from, to, 32)) {
      // On the arc: from→p→to is no longer than from→to.
      expect(d(from, p) + d(p, to)).toBeCloseTo(total, 6);
    }
  });

  it("spaces points evenly along the arc", () => {
    const pts = greatCirclePoints(from, to, 4);
    const step = d(from, to) / 4;
    for (let i = 1; i < pts.length; i++) expect(d(pts[i - 1], pts[i])).toBeCloseTo(step, 6);
  });

  it("differs from a straight lat/lng interpolation over long distances", () => {
    // Montreal → Paris: the great circle bows north of the straight Mercator line.
    const mid = greatCirclePoints([45.5, -73.6], [48.85, 2.35], 2)[1];
    expect(mid[0]).toBeGreaterThan((45.5 + 48.85) / 2 + 5);
  });

  it("returns the two endpoints when they coincide", () => {
    expect(greatCirclePoints(from, from, 32)).toEqual([from, from]);
  });

  it("never produces NaN, even near-antipodal", () => {
    for (const p of greatCirclePoints([0, 0], [0, 179.9999999], 8)) {
      expect(Number.isFinite(p[0])).toBe(true);
      expect(Number.isFinite(p[1])).toBe(true);
    }
  });
});

describe("midpoint", () => {
  it("is the middle point of an odd-length line", () => {
    const pts: [number, number][] = [[0, 0], [1, 1], [2, 2]];
    expect(midpoint(pts)).toEqual([1, 1]);
  });

  it("is the arc midpoint of a great-circle line", () => {
    const from: [number, number] = [45.5, -73.6];
    const to: [number, number] = [48.9, -66.2];
    const m = midpoint(greatCirclePoints(from, to, 32));
    expect(d(from, m)).toBeCloseTo(d(m, to), 6);
  });
});

describe("rangeLineLabel", () => {
  // Receiver one degree north of the aircraft: 60.0 NM, bearing 180°, 5.0° up.
  const receiver = { lat: 46.5, lng: -73.6, alt: 0 };

  it("reads distance, bearing and elevation like the details panel", () => {
    expect(rangeLineLabel(makeTrack(), receiver)).toBe("111 km / 60.0 NM · 180.0° · el 5.0°");
  });

  it("drops the elevation when the altitude is unknown", () => {
    expect(rangeLineLabel(makeTrack({ altitude: null }), receiver)).toBe("111 km / 60.0 NM · 180.0°");
  });

  it("is null without a position", () => {
    expect(rangeLineLabel(makeTrack({ latitude: null }), receiver)).toBeNull();
  });
});

describe("rangeLineTargets", () => {
  const a = makeTrack({ hex_ident: "AAA111" });
  const b = makeTrack({ hex_ident: "BBB222", latitude: 46, longitude: -72 });
  const noPos = makeTrack({ hex_ident: "CCC333", latitude: null, longitude: null });
  const byKey = new Map([["AAA111", a], ["BBB222", b], ["CCC333", noPos]]);

  it("returns the selected tracks that have a position, in selection order", () => {
    expect(rangeLineTargets(new Set(["BBB222", "AAA111"]), byKey)).toEqual([b, a]);
  });

  it("skips tracks without a position and keys not on the map (hidden or gone)", () => {
    expect(rangeLineTargets(new Set(["CCC333", "ZZZ999", "AAA111"]), byKey)).toEqual([a]);
  });

  it("is empty with nothing selected", () => {
    expect(rangeLineTargets(new Set(), byKey)).toEqual([]);
  });
});
