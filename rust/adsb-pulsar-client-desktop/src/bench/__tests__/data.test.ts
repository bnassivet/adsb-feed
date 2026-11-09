import { describe, it, expect } from "vitest";
import { generateTracks, BENCH_BBOX, liveStep } from "@/bench/data";
import { isColumnar, type ColumnarPositions } from "@/lib/types";

function totalPoints(tracks: ReturnType<typeof generateTracks>): number {
  return tracks.reduce((n, t) => n + t.positions.length, 0);
}

describe("generateTracks", () => {
  it("produces exactly the requested number of points", () => {
    for (const n of [1, 999, 10_000, 54_321]) {
      expect(totalPoints(generateTracks({ points: n, seed: 1 }))).toBe(n);
    }
  });

  it("is deterministic for a given seed and differs across seeds", () => {
    const a = generateTracks({ points: 5_000, seed: 42 });
    const b = generateTracks({ points: 5_000, seed: 42 });
    const c = generateTracks({ points: 5_000, seed: 43 });
    const lat = (ts: typeof a) => Array.from((ts[0].positions as ColumnarPositions).lat.slice(0, 20));
    expect(lat(a)).toEqual(lat(b));
    expect(lat(a)).not.toEqual(lat(c));
    expect(a.map((t) => t.hex_ident)).toEqual(b.map((t) => t.hex_ident));
  });

  it("uses columnar positions inside the bench bounding box", () => {
    const tracks = generateTracks({ points: 20_000, seed: 7 });
    for (const t of tracks) {
      expect(isColumnar(t.positions)).toBe(true);
      const p = t.positions as ColumnarPositions;
      for (let i = 0; i < p.length; i++) {
        expect(p.lat[i]).toBeGreaterThanOrEqual(BENCH_BBOX.south);
        expect(p.lat[i]).toBeLessThanOrEqual(BENCH_BBOX.north);
        expect(p.lng[i]).toBeGreaterThanOrEqual(BENCH_BBOX.west);
        expect(p.lng[i]).toBeLessThanOrEqual(BENCH_BBOX.east);
      }
    }
  });

  it("gives every track at least 2 points so DotsLayer does not skip it", () => {
    const tracks = generateTracks({ points: 10_001, seed: 3 });
    expect(tracks.every((t) => t.positions.length >= 2)).toBe(true);
    expect(new Set(tracks.map((t) => t.track_id)).size).toBe(tracks.length);
  });

  it("has realistic altitudes with some null (NaN) gaps", () => {
    const tracks = generateTracks({ points: 20_000, seed: 9 });
    let nan = 0, n = 0;
    for (const t of tracks) {
      const alt = (t.positions as ColumnarPositions).alt;
      for (const a of alt) {
        n++;
        if (Number.isNaN(a)) { nan++; continue; }
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(45_000);
      }
    }
    expect(nan).toBeGreaterThan(0);
    expect(nan / n).toBeLessThan(0.05);
  });

  it("keeps consecutive points of a track close together (real trajectories, not noise)", () => {
    const [t] = generateTracks({ points: 2_000, seed: 5 });
    const p = t.positions as ColumnarPositions;
    for (let i = 1; i < p.length; i++) {
      expect(Math.abs(p.lat[i] - p.lat[i - 1])).toBeLessThan(0.05);
      expect(Math.abs(p.lng[i] - p.lng[i - 1])).toBeLessThan(0.05);
    }
  });
});

describe("liveStep", () => {
  it("appends exactly one position to every live track, deterministically", () => {
    const start = generateTracks({ points: 1_000, seed: 1, live: true, aircraft: 50 });
    expect(start).toHaveLength(50);
    expect(start.every((t) => !isColumnar(t.positions))).toBe(true);
    const next = liveStep(start, 1);
    expect(next).not.toBe(start);
    for (let i = 0; i < start.length; i++) {
      expect(next[i].positions.length).toBe(start[i].positions.length + 1);
      expect(next[i]).not.toBe(start[i]);
    }
    expect(liveStep(start, 1).map((t) => t.latitude)).toEqual(next.map((t) => t.latitude));
  });
});
