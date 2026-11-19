import { describe, it, expect } from "vitest";
import {
  depthLayers, DEPTH_LEGEND, SEA_HOSTS, SEAMARK_URL, SEAMARK_MIN_ZOOM, EMODNET_WMS_URL,
  DEFAULT_DEPTH_OPACITY, DEFAULT_SEAMARK_OPACITY, SEAMARK_ATTRIBUTION, DEPTH_ATTRIBUTION,
} from "../sea";

describe("sea overlays", () => {
  it("asks EMODnet for the depth layers that are switched on, in one request", () => {
    expect(depthLayers({ colours: true, contours: true })).toBe("emodnet:mean_multicolour,emodnet:contours");
    expect(depthLayers({ colours: true, contours: false })).toBe("emodnet:mean_multicolour");
    expect(depthLayers({ colours: false, contours: true })).toBe("emodnet:contours");
    expect(depthLayers({ colours: false, contours: false })).toBeNull();
  });

  it("has a depth legend from shallow to deep", () => {
    const m = DEPTH_LEGEND.map((b) => b.depthM);
    expect(m[0]).toBe(0);
    expect(m).toEqual([...m].sort((a, b) => a - b));
    for (const b of DEPTH_LEGEND) expect(b.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("lists every host the overlays load from", () => {
    expect(SEA_HOSTS).toEqual(["https://tiles.openseamap.org", "https://ows.emodnet-bathymetry.eu"]);
    for (const url of [SEAMARK_URL, EMODNET_WMS_URL]) {
      expect(SEA_HOSTS).toContain(new URL(url.replace(/\{\w\}/g, "0")).origin);
    }
  });

  it("starts seamarks at zoom 9, where the tiles stop being empty", () => {
    expect(SEAMARK_MIN_ZOOM).toBe(9);
  });

  it("credits both sources and keeps the loud depth colours faint by default", () => {
    expect(SEAMARK_ATTRIBUTION).toMatch(/OpenSeaMap/);
    expect(DEPTH_ATTRIBUTION).toMatch(/EMODnet/);
    expect(DEFAULT_DEPTH_OPACITY).toBeLessThan(DEFAULT_SEAMARK_OPACITY);
    expect(DEFAULT_DEPTH_OPACITY).toBeGreaterThan(0.2);
  });
});
