import type { MapTheme } from "./colors";

/**
 * Basemap tile sources, one per map theme.
 *
 * Since 2026-09-25 CARTO serves raster tiles only with a `?key=` parameter;
 * a keyless request gets a tile reading "API KEY REQUIRED" instead of the map.
 * Keys are free (carto.com/basemaps/apikey, 5M tiles/month non-commercial), but
 * a fresh checkout has none, so without one the dark theme falls back to Esri's
 * keyless Dark Gray Canvas rather than showing the watermark.
 *
 * `NEXT_PUBLIC_CARTO_API_KEY` is inlined by Next when the dev server starts or
 * `next build` runs, like `NEXT_PUBLIC_AGENT_URL` -- changing it means
 * restarting the desktop. `scripts/stack.sh` sets it from
 * `[desktop] carto_api_key`.
 *
 * Every host here must also be in the CSP's `img-src`, in BOTH
 * `src-tauri/tauri.conf.json` and `scripts/tauri-dev-config.py`, or tiles are
 * blocked with nothing but a console message.
 */
export const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY?.trim() || undefined;

export interface TileConfig {
  url: string;
  attribution: string;
  maxZoom: number;
  subdomains?: string;
}

const OSM: TileConfig = {
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
};

// ArcGIS REST tiles are addressed {z}/{y}/{x} -- row before column.
const ESRI_DARK_GRAY: TileConfig = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
  maxZoom: 16,
};

function cartoDarkMatter(key: string): TileConfig {
  return {
    url: `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
    subdomains: "abcd",
  };
}

/** The tile layer for `theme`: CARTO when a key is configured, Esri otherwise. */
export function tileConfig(theme: MapTheme, cartoKey?: string): TileConfig {
  if (theme === "light") return OSM;
  const key = cartoKey?.trim();
  return key ? cartoDarkMatter(key) : ESRI_DARK_GRAY;
}
