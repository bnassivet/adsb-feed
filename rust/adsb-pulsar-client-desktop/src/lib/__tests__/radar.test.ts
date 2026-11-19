import { describe, it, expect } from "vitest";
import { legendLabels, formatValidTime, radarDataUrl, radarImageBounds, DEFAULT_RADAR_OPACITY, RADAR_ATTRIBUTION, type RadarSnapshot } from "../radar";

const scale = [
  { fromMmH: 0.1, color: "#9bd3f5" },
  { fromMmH: 1, color: "#4aa3f0" },
  { fromMmH: 64, color: "#c026d3" },
];

describe("radar", () => {
  it("labels each band by its lower bound, the last one open-ended", () => {
    expect(legendLabels(scale)).toEqual([
      { color: "#9bd3f5", label: "0.1–1" },
      { color: "#4aa3f0", label: "1–64" },
      { color: "#c026d3", label: "≥ 64" },
    ]);
  });

  it("formats the image time in UTC with its age", () => {
    const t = Date.UTC(2026, 10, 19, 3, 10);
    expect(formatValidTime(t, t + 7 * 60_000)).toBe("03:10 UTC · 7 min ago");
    expect(formatValidTime(t, t)).toBe("03:10 UTC · just now");
  });

  it("builds the image URL and Leaflet bounds", () => {
    const s: RadarSnapshot = {
      pngBase64: "iVBORw0KGgo=", bounds: [42, -9, 52, 6], validTimeMs: 0, accumulationMinutes: 5,
      origin: "download", error: null, scale,
    };
    expect(radarDataUrl(s)).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(radarImageBounds(s)).toEqual([[42, -9], [52, 6]]);
    expect(radarDataUrl({ ...s, pngBase64: null })).toBeNull();
    expect(radarImageBounds({ ...s, bounds: null })).toBeNull();
  });

  it("credits Météo-France and has a sensible default opacity", () => {
    expect(RADAR_ATTRIBUTION).toMatch(/Météo-France/);
    expect(DEFAULT_RADAR_OPACITY).toBeGreaterThan(0.3);
    expect(DEFAULT_RADAR_OPACITY).toBeLessThan(1);
  });
});
