import { describe, it, expect } from "vitest";
import { fromLonLat } from "ol/proj";
import { flatten, toMercator } from "@/bench/flatten";
import { generateTracks } from "@/bench/data";

describe("flatten", () => {
  it("concatenates columnar tracks with path start offsets", () => {
    const tracks = generateTracks({ points: 3_000, seed: 2 });
    const f = flatten(tracks);
    expect(f.count).toBe(3_000);
    expect(f.starts).toHaveLength(tracks.length + 1);
    expect(f.starts[0]).toBe(0);
    expect(f.starts[tracks.length]).toBe(3_000);
    const t1 = tracks[1].positions;
    const s = f.starts[1];
    expect(f.lat[s]).toBe((t1 as { lat: Float64Array }).lat[0]);
    expect(f.lng[s + 1]).toBe((t1 as { lng: Float64Array }).lng[1]);
  });

  it("accepts live tuple tracks and encodes null altitude as NaN", () => {
    const tracks = generateTracks({ points: 200, seed: 3, live: true, aircraft: 4 });
    const p0 = tracks[0].positions as [number, number, number | null][];
    p0[0] = [p0[0][0], p0[0][1], null];
    const f = flatten(tracks);
    expect(f.count).toBe(200);
    expect(f.alt[0]).toBeNaN();
    expect(f.lat[0]).toBe(p0[0][0]);
  });

  it("lists each track's last point as its head", () => {
    const tracks = generateTracks({ points: 200, seed: 3, live: true, aircraft: 4 });
    const f = flatten(tracks);
    expect(Array.from(f.heads)).toEqual([49, 99, 149, 199]);
  });
});

describe("toMercator", () => {
  it("matches OpenLayers' fromLonLat", () => {
    for (const [lng, lat] of [[0, 0], [-73.6, 45.5], [179.9, -60], [-76.6, 43.5]]) {
      const [x, y] = toMercator(lng, lat);
      const [ex, ey] = fromLonLat([lng, lat]);
      expect(x).toBeCloseTo(ex, 3);
      expect(y).toBeCloseTo(ey, 3);
    }
  });
});
