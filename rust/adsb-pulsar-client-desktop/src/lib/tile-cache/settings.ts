/**
 * User-facing tile cache settings. Stored in localStorage under
 * `TILE_CACHE_SETTINGS_KEY` (via `useLocalStorage`), which both the map page and
 * the Settings page read -- they are separate routes but the same origin.
 */
export interface TileCacheSettings {
  /** Store newly viewed tiles. When off, cached tiles are still served. */
  enabled: boolean;
  /** Footprint radius around the receiver, in nautical miles. */
  radiusNm: number;
  /** Size cap; least-recently-used tiles are evicted above it. */
  maxSizeMb: number;
  /** Deepest zoom "Download area" fetches. Each extra level is ~4x the tiles. */
  prefetchMaxZoom: number;
}

export const TILE_CACHE_SETTINGS_KEY = "adsb-tile-cache-settings";

export const DEFAULT_TILE_CACHE_SETTINGS: TileCacheSettings = {
  enabled: true,
  radiusNm: 500,
  maxSizeMb: 500,
  prefetchMaxZoom: 10,
};

export const TILE_CACHE_LIMITS = {
  radiusNm: { min: 10, max: 1000 },
  maxSizeMb: { min: 50, max: 10_000 },
  prefetchMaxZoom: { min: 0, max: 12 },
} as const;

/** One message per invalid field; empty when the settings can be applied. */
export function validateTileCacheSettings(s: TileCacheSettings): string[] {
  const errors: string[] = [];
  const { radiusNm, maxSizeMb, prefetchMaxZoom } = TILE_CACHE_LIMITS;
  const inRange = (v: number, r: { min: number; max: number }) => Number.isFinite(v) && v >= r.min && v <= r.max;
  if (!inRange(s.radiusNm, radiusNm)) {
    errors.push(`Radius must be ${radiusNm.min}–${radiusNm.max} NM`);
  }
  if (!inRange(s.maxSizeMb, maxSizeMb)) {
    errors.push(`Max size must be ${maxSizeMb.min}–${maxSizeMb.max} MB`);
  }
  if (!Number.isInteger(s.prefetchMaxZoom) || !inRange(s.prefetchMaxZoom, prefetchMaxZoom)) {
    errors.push(`Prefetch zoom must be a whole number ${prefetchMaxZoom.min}–${prefetchMaxZoom.max}`);
  }
  return errors;
}

/**
 * Merge a stored value over the defaults, field by field. A field of the wrong
 * type is dropped rather than poisoning the whole object, and a value written
 * by an older version (missing a field) still loads.
 */
export function normalizeTileCacheSettings(raw: unknown): TileCacheSettings {
  const out = { ...DEFAULT_TILE_CACHE_SETTINGS };
  if (raw === null || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  for (const k of ["radiusNm", "maxSizeMb", "prefetchMaxZoom"] as const) {
    if (typeof r[k] === "number" && Number.isFinite(r[k])) out[k] = r[k] as number;
  }
  return out;
}
