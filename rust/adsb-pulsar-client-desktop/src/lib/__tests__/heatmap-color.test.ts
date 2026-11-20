import { describe, it, expect } from "vitest";
import { heatmapColor } from "../heatmap-color";

describe("heatmapColor", () => {
  it("is transparent at zero", () => {
    expect(heatmapColor(0)).toBe("transparent");
  });

  it("is cyan at the midpoint", () => {
    expect(heatmapColor(0.5)).toBe("rgba(6, 182, 212, 0.8)");
  });

  it("is opaque amber at the top", () => {
    expect(heatmapColor(1)).toBe("rgba(245, 158, 11, 1)");
  });
});
