import { describe, it, expect } from "vitest";
import { RELIEF_URL, RELIEF_HOST, RELIEF_ATTRIBUTION, DEFAULT_RELIEF_OPACITY, RELIEF_BLEND, RELIEF_MAX_NATIVE_ZOOM } from "../relief";

describe("relief", () => {
  it("is Esri's light hillshade, multiplied over the base map in both themes", () => {
    expect(RELIEF_URL).toContain("/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}");
    expect(RELIEF_URL).not.toContain("Dark");
    expect(RELIEF_BLEND).toBe("multiply");
  });

  it("comes from the base map's host and credits Esri", () => {
    expect(new URL(RELIEF_URL.replace(/\{\w\}/g, "0")).origin).toBe(RELIEF_HOST);
    expect(RELIEF_ATTRIBUTION).toMatch(/Esri/);
  });

  it("has sensible defaults", () => {
    expect(DEFAULT_RELIEF_OPACITY).toBeGreaterThan(0.3);
    expect(DEFAULT_RELIEF_OPACITY).toBeLessThan(1);
    expect(RELIEF_MAX_NATIVE_ZOOM).toBe(16);
  });
});
