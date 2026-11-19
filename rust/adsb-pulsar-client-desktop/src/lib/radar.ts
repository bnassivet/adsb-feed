/**
 * Météo-France rain radar: what `get_radar` returns, and the little the
 * webview has to do with it. Rust decodes, reprojects and colours the mosaic
 * (`src-tauri/src/radar_grid.rs`); the map only places a PNG.
 */
import { ageMinutes, formatAge } from "./metar";

export const RADAR_ATTRIBUTION = 'Radar © <a href="https://meteofrance.com">Météo-France</a>';
export const DEFAULT_RADAR_OPACITY = 0.7;

export interface RadarBand {
  /** Lower bound of the band, mm/h. */
  fromMmH: number;
  color: string;
}

export interface RadarSnapshot {
  pngBase64: string | null;
  /** [south, west, north, east]. */
  bounds: [number, number, number, number] | null;
  /** The time the image shows (end of its 5-minute window). */
  validTimeMs: number | null;
  accumulationMinutes: number | null;
  origin: "cache" | "download" | "stale-cache" | "none";
  error: string | null;
  /** The colour scale the image was drawn with: the legend comes from here. */
  scale: RadarBand[];
}

export function legendLabels(scale: RadarBand[]): { color: string; label: string }[] {
  return scale.map((b, i) => ({
    color: b.color,
    label: i + 1 < scale.length ? `${b.fromMmH}–${scale[i + 1].fromMmH}` : `≥ ${b.fromMmH}`,
  }));
}

export function formatValidTime(validTimeMs: number, nowMs: number): string {
  const d = new Date(validTimeMs);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${hhmm} UTC · ${formatAge(ageMinutes(validTimeMs, nowMs))}`;
}

export const radarDataUrl = (s: RadarSnapshot) => (s.pngBase64 ? `data:image/png;base64,${s.pngBase64}` : null);

/** Leaflet bounds: [[south, west], [north, east]]. */
export function radarImageBounds(s: RadarSnapshot): [[number, number], [number, number]] | null {
  if (!s.bounds) return null;
  const [south, west, north, east] = s.bounds;
  return [[south, west], [north, east]];
}
