import { describe, it, expect } from "vitest";
import { parseParams, LIVE_AIRCRAFT, LIVE_POINTS } from "@/bench/harness";

describe("parseParams", () => {
  it("reads size, style, scenario and seed from the query string", () => {
    expect(parseParams("?size=200000&style=line&scenario=panzoom&seed=7")).toEqual({
      size: 200_000, style: "line", scenario: "panzoom", seed: 7,
    });
  });

  it("defaults to 10k dots, initial scenario, seed 1", () => {
    expect(parseParams("")).toEqual({ size: 10_000, style: "dots", scenario: "initial", seed: 1 });
  });

  it("rejects values that would silently benchmark the wrong thing", () => {
    expect(() => parseParams("?style=heatmap")).toThrow(/style/);
    expect(() => parseParams("?scenario=nope")).toThrow(/scenario/);
    expect(() => parseParams("?size=-5")).toThrow(/size/);
    expect(() => parseParams("?size=abc")).toThrow(/size/);
  });

  it("forces the fixed live workload regardless of size", () => {
    const p = parseParams("?size=1000000&scenario=live");
    expect(p.size).toBe(LIVE_POINTS);
    expect(LIVE_POINTS / LIVE_AIRCRAFT).toBeLessThanOrEqual(100);
  });
});
