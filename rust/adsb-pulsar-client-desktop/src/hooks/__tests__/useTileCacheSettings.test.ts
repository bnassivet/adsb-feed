import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TILE_CACHE_SETTINGS, TILE_CACHE_SETTINGS_KEY } from "@/lib/tile-cache/settings";
import { useTileCacheSettings } from "../useTileCacheSettings";

describe("useTileCacheSettings", () => {
  beforeEach(() => localStorage.clear());

  it("returns the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useTileCacheSettings());
    expect(result.current[0]).toEqual(DEFAULT_TILE_CACHE_SETTINGS);
  });

  it("normalises a partial stored value written by an older version", () => {
    localStorage.setItem(TILE_CACHE_SETTINGS_KEY, JSON.stringify({ radiusNm: 200 }));
    const { result } = renderHook(() => useTileCacheSettings());
    expect(result.current[0]).toEqual({ ...DEFAULT_TILE_CACHE_SETTINGS, radiusNm: 200 });
  });

  it("persists under the shared key, so the map page sees what Settings saved", () => {
    const { result } = renderHook(() => useTileCacheSettings());
    act(() => result.current[1]({ ...DEFAULT_TILE_CACHE_SETTINGS, maxSizeMb: 900 }));
    expect(JSON.parse(localStorage.getItem(TILE_CACHE_SETTINGS_KEY)!).maxSizeMb).toBe(900);
    expect(renderHook(() => useTileCacheSettings()).result.current[0].maxSizeMb).toBe(900);
  });
});
