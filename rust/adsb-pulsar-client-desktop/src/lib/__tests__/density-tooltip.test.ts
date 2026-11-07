import { describe, it, expect } from "vitest";
import { buildDensityTooltip } from "../density-tooltip";
import type { DensityProperties } from "../h3-density";

const props = {
  value: 1234,
  normalized: 0.5,
  positions: 1234,
  aircraftCount: 7,
  meanAlt: 21000,
  minAlt: 3000,
  maxAlt: 38000,
  cellCenter: [48.85, 2.35],
} as unknown as DensityProperties;

describe("buildDensityTooltip", () => {
  it("returns null in off mode so no tooltip is bound", () => {
    expect(buildDensityTooltip("off", props, "positions")).toBeNull();
  });

  it("returns null in off mode even with a receiver location", () => {
    expect(
      buildDensityTooltip("off", props, "aircraft", { lat: 48.8, lng: 2.3, alt: null }),
    ).toBeNull();
  });

  it("builds a single-line tooltip in compact mode", () => {
    const text = buildDensityTooltip("compact", props, "positions");
    expect(text).toContain("Positions:");
    expect(text).not.toContain("<br>");
  });

  it("uses the metric label in compact mode", () => {
    expect(buildDensityTooltip("compact", props, "altitude_max")).toContain("Max alt:");
  });

  it("builds a multi-line tooltip with all metrics in extended mode", () => {
    const text = buildDensityTooltip("extended", props, "positions")!;
    expect(text).toContain("H3 Cell");
    expect(text).toContain("Aircraft:");
    expect(text).toContain("Min alt:");
    expect(text).not.toContain("Distance:");
  });

  it("adds receiver distance in extended mode when a receiver is known", () => {
    const text = buildDensityTooltip("extended", props, "positions", { lat: 48.8, lng: 2.3, alt: null });
    expect(text).toContain("Distance:");
    expect(text).toContain("NM");
  });
});
