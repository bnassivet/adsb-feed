import { describe, it, expect } from "vitest";
import { toLonLat } from "ol/proj";
import { Cartesian3 } from "cesium";
import { flatten, toMercator } from "@/bench/flatten";
import { generateTracks } from "@/bench/data";
import { binByAltitude, NULL_ALT_BIN } from "@/bench/ol-binned";
import { olToDeckViewState } from "@/bench/deck-ol-view";
import { toEcef, flatToEcef, zoomToCameraHeight, FEET_TO_M } from "@/bench/cesium-geo";

describe("binByAltitude (OpenLayers MultiPoint per 1000 ft)", () => {
  it("keeps every point exactly once, in Web Mercator", () => {
    const f = flatten(generateTracks({ points: 5_000, seed: 4 }));
    const bins = binByAltitude(f);
    const total = bins.reduce((n, b) => n + b.coords.length / 2, 0);
    expect(total).toBe(f.count);
    // First point of its bin, in mercator.
    const b0 = bins.find((b) => b.alt === Math.floor(f.alt[0] / 1000) * 1000)!;
    const [x, y] = toMercator(f.lng[0], f.lat[0]);
    expect(Array.from(b0.coords).some((v, i) => i % 2 === 0 && v === x && b0.coords[i + 1] === y)).toBe(true);
  });

  it("puts unknown altitude in its own bin and labels bins by their floor", () => {
    const f = flatten(generateTracks({ points: 200, seed: 3, live: true, aircraft: 4 }));
    f.alt[0] = NaN;
    f.alt[1] = 12_345;
    const bins = binByAltitude(f);
    expect(bins.find((b) => b.alt === NULL_ALT_BIN)!.coords.length).toBeGreaterThanOrEqual(2);
    expect(bins.some((b) => b.alt === 12_000)).toBe(true);
    for (const b of bins) if (b.alt !== NULL_ALT_BIN) expect(b.alt % 1000).toBe(0);
  });

  it("emits no empty bins", () => {
    const f = flatten(generateTracks({ points: 1_000, seed: 9 }));
    for (const b of binByAltitude(f)) expect(b.coords.length).toBeGreaterThan(0);
  });
});

describe("olToDeckViewState", () => {
  it("converts an OL view to deck.gl's 512-px-tile zoom and degrees", () => {
    const center = toMercator(-73.6, 45.5);
    const v = olToDeckViewState(center, 8, 0);
    const [lng, lat] = toLonLat(center);
    expect(v.longitude).toBeCloseTo(lng, 9);
    expect(v.latitude).toBeCloseTo(lat, 9);
    expect(v.zoom).toBe(7);
    expect(v.bearing).toBeCloseTo(0);
  });

  it("maps OL's counter-clockwise radians to deck's clockwise degrees", () => {
    expect(olToDeckViewState([0, 0], 3, Math.PI / 2).bearing).toBeCloseTo(-90);
  });
});

describe("cesium-geo", () => {
  it("matches Cesium's own WGS84 conversion", () => {
    for (const [lng, lat, h] of [[0, 0, 0], [-73.6, 45.5, 10_000], [139.7, -35.2, 300], [0, 90, 0]]) {
      const ours = toEcef(lng, lat, h);
      const theirs = Cartesian3.fromDegrees(lng, lat, h);
      expect(ours[0]).toBeCloseTo(theirs.x, 3);
      expect(ours[1]).toBeCloseTo(theirs.y, 3);
      expect(ours[2]).toBeCloseTo(theirs.z, 3);
    }
  });

  it("flattens positions to xyz with altitude in metres, unknown altitude on the ellipsoid", () => {
    const f = flatten(generateTracks({ points: 100, seed: 1 }));
    f.alt[1] = NaN;
    const xyz = flatToEcef(f);
    expect(xyz).toHaveLength(f.count * 3);
    const e0 = toEcef(f.lng[0], f.lat[0], f.alt[0] * FEET_TO_M);
    expect(Array.from(xyz.subarray(0, 3))).toEqual(e0);
    const e1 = toEcef(f.lng[1], f.lat[1], 0);
    expect(Array.from(xyz.subarray(3, 6))).toEqual(e1);
  });

  it("chooses a camera height whose vertical extent matches the slippy-map zoom", () => {
    const fov = Math.PI / 3;
    const h = zoomToCameraHeight(8, 45.5, 1280, 800, fov);
    // Leaflet zoom 8 at 45.5° ≈ 428 m/px → 800 px ≈ 343 km tall.
    const fovy = 2 * Math.atan(Math.tan(fov / 2) / (1280 / 800));
    expect(2 * h * Math.tan(fovy / 2)).toBeCloseTo(800 * (156_543.034 * Math.cos((45.5 * Math.PI) / 180)) / 256, -2);
    expect(zoomToCameraHeight(9, 45.5, 1280, 800, fov)).toBeCloseTo(h / 2, 6);
  });
});
