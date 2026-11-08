"use client";
import { useLocalStorage } from "./useLocalStorage";
import {
  DEFAULT_TILE_CACHE_SETTINGS,
  TILE_CACHE_SETTINGS_KEY,
  normalizeTileCacheSettings,
  type TileCacheSettings,
} from "@/lib/tile-cache/settings";

/**
 * Tile cache settings, shared by the map (which applies them) and the Settings
 * page (which edits them) through one localStorage key. The stored value is
 * normalised on every read, so an older or hand-edited value cannot break the map.
 */
export function useTileCacheSettings(): [TileCacheSettings, (s: TileCacheSettings) => void] {
  const [raw, setRaw] = useLocalStorage<unknown>(TILE_CACHE_SETTINGS_KEY, DEFAULT_TILE_CACHE_SETTINGS);
  return [normalizeTileCacheSettings(raw), setRaw];
}
