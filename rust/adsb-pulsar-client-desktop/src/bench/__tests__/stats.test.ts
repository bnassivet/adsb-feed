import { describe, it, expect } from "vitest";
import { percentile, median, summarizeFrames, aggregate, toMarkdown, type RunResult } from "@/bench/stats";

describe("percentile / median", () => {
  it("interpolates linearly like numpy's default", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    expect(percentile([4, 1, 3, 2], 100)).toBe(4);
    expect(percentile([10, 20], 95)).toBeCloseTo(19.5);
  });

  it("does not mutate its input", () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("returns NaN for empty input", () => {
    expect(percentile([], 50)).toBeNaN();
    expect(median([])).toBeNaN();
  });

  it("median of odd and even lengths", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("summarizeFrames", () => {
  it("reports percentiles and the share of slow frames", () => {
    const deltas = [...Array(16).fill(16), 20, 20, 60, 100];
    const s = summarizeFrames(deltas);
    expect(s.frames).toBe(20);
    expect(s.p50).toBe(16);
    expect(s.max).toBe(100);
    expect(s.over16Pct).toBeCloseTo(20); // 4 of 20 above 16.7 ms
    expect(s.over50Pct).toBeCloseTo(10); // 2 of 20 above 50 ms
    expect(s.p95).toBeGreaterThan(60);
  });

  it("does not count a frame of exactly one 60 Hz vsync as slow", () => {
    expect(summarizeFrames([16.7, 16.7]).over16Pct).toBe(0);
  });
});

function run(variant: string, rep: number, value: number | null, extra: Partial<RunResult> = {}): RunResult {
  return {
    variant, rep, engine: "webkit", size: 10_000, style: "dots", scenario: "initial",
    dnf: value === null, metrics: value === null ? {} : { totalMs: value }, ...extra,
  };
}

describe("aggregate", () => {
  it("takes the median per variant and the ratio against the baseline", () => {
    const rows = aggregate([
      run("leaflet", 0, 100), run("leaflet", 1, 300), run("leaflet", 2, 200),
      run("maplibre", 0, 50), run("maplibre", 1, 40), run("maplibre", 2, 60),
    ]);
    const ml = rows.find((r) => r.variant === "maplibre")!;
    expect(ml.metrics.totalMs).toBe(50);
    expect(ml.ratio.totalMs).toBeCloseTo(0.25);
    const base = rows.find((r) => r.variant === "leaflet")!;
    expect(base.ratio.totalMs).toBe(1);
  });

  it("keeps groups apart by engine, size, style and scenario", () => {
    const rows = aggregate([
      run("leaflet", 0, 100), run("leaflet", 0, 999, { engine: "chromium" }),
      run("leaflet", 0, 5, { size: 50_000 }), run("leaflet", 0, 7, { style: "line" }),
    ]);
    expect(rows).toHaveLength(4);
  });

  it("marks a variant DNF only when every repetition failed, and counts failures", () => {
    const rows = aggregate([
      run("leaflet", 0, null), run("leaflet", 1, null),
      run("deckgl", 0, 30), run("deckgl", 1, null),
    ]);
    const base = rows.find((r) => r.variant === "leaflet")!;
    expect(base.dnf).toBe(true);
    expect(base.metrics.totalMs).toBeNull();
    const deck = rows.find((r) => r.variant === "deckgl")!;
    expect(deck.dnf).toBe(false);
    expect(deck.dnfCount).toBe(1);
    expect(deck.metrics.totalMs).toBe(30);
    // No ratio against a baseline that never finished.
    expect(deck.ratio.totalMs).toBeNull();
  });

  it("orders variants with the baseline first", () => {
    const rows = aggregate([run("openlayers", 0, 1), run("deckgl", 0, 1), run("leaflet", 0, 1), run("maplibre", 0, 1)]);
    expect(rows.map((r) => r.variant)).toEqual(["leaflet", "deckgl", "maplibre", "openlayers"]);
  });
});

describe("toMarkdown", () => {
  it("renders one table per engine/scenario/style with sizes as columns", () => {
    const rows = aggregate([
      run("leaflet", 0, 200), run("maplibre", 0, 50),
      run("leaflet", 0, null, { size: 1_000_000 }), run("maplibre", 0, 80, { size: 1_000_000 }),
    ]);
    const md = toMarkdown(rows);
    expect(md).toContain("### webkit · initial · dots");
    expect(md).toContain("| Variant | 10k | 1M |");
    expect(md).toMatch(/\| maplibre \| 50(\.0)? ms \(×0\.25\) \| 80(\.0)? ms \|/);
    expect(md).toMatch(/\| leaflet \| 200(\.0)? ms \| DNF \|/);
  });
});
