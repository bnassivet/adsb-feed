import { describe, expect, it } from "vitest";
import {
  DEFAULT_TILE_CACHE_SETTINGS,
  normalizeTileCacheSettings,
  validateTileCacheSettings,
} from "../settings";

describe("tile cache settings", () => {
  it("defaults to a 500 NM footprint, 500 MB cap and z10 prefetch", () => {
    expect(DEFAULT_TILE_CACHE_SETTINGS).toEqual({
      enabled: true,
      radiusNm: 500,
      maxSizeMb: 500,
      prefetchMaxZoom: 10,
    });
  });

  it("accepts the defaults", () => {
    expect(validateTileCacheSettings(DEFAULT_TILE_CACHE_SETTINGS)).toEqual([]);
  });

  it.each([
    [{ radiusNm: 5 }, "radius"],
    [{ radiusNm: 1001 }, "radius"],
    [{ maxSizeMb: 10 }, "size"],
    [{ maxSizeMb: 20_000 }, "size"],
    [{ prefetchMaxZoom: 13 }, "zoom"],
    [{ prefetchMaxZoom: 2.5 }, "zoom"],
    [{ radiusNm: Number.NaN }, "radius"],
  ])("rejects %j", (patch, word) => {
    const errors = validateTileCacheSettings({ ...DEFAULT_TILE_CACHE_SETTINGS, ...patch });
    expect(errors).toHaveLength(1);
    expect(errors[0].toLowerCase()).toContain(word);
  });

  it("fills fields missing from an older stored value with defaults", () => {
    expect(normalizeTileCacheSettings({ radiusNm: 250 })).toEqual({
      ...DEFAULT_TILE_CACHE_SETTINGS,
      radiusNm: 250,
    });
  });

  it("falls back to defaults for garbage", () => {
    expect(normalizeTileCacheSettings(null)).toEqual(DEFAULT_TILE_CACHE_SETTINGS);
    expect(normalizeTileCacheSettings("x")).toEqual(DEFAULT_TILE_CACHE_SETTINGS);
    expect(normalizeTileCacheSettings({ radiusNm: "far" })).toEqual(DEFAULT_TILE_CACHE_SETTINGS);
  });
});
