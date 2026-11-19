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

export function formatUtcTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function formatValidTime(validTimeMs: number, nowMs: number): string {
  return `${formatUtcTime(validTimeMs)} · ${formatAge(ageMinutes(validTimeMs, nowMs))}`;
}

const pngUrl = (base64: string) => `data:image/png;base64,${base64}`;
export const radarDataUrl = (s: RadarSnapshot) => (s.pngBase64 ? pngUrl(s.pngBase64) : null);

/** Leaflet bounds: [[south, west], [north, east]]. */
export function radarImageBounds(s: RadarSnapshot): [[number, number], [number, number]] | null {
  if (!s.bounds) return null;
  const [south, west, north, east] = s.bounds;
  return [[south, west], [north, east]];
}

// ── Animation of the last hour ─────────────────────────────────────────────
// Météo-France serves only the current image, so Rust keeps each one it
// downloads (src-tauri/src/radar_history.rs): frames exist for the times the
// layer was on.

/** An hour of 5-minute images. */
export const HISTORY_FRAMES = 12;
export const ANIMATION_FRAME_MS = 500;
/** The newest frame stays up longer, so the loop reads as "ending now". */
export const ANIMATION_HOLD_MS = 2000;

/** What `get_radar_frames` returns: an image is null when the webview said it has it. */
export interface RadarFrames {
  bounds: [number, number, number, number];
  frames: { validTimeMs: number; pngBase64: string | null }[];
}

export interface RadarImage {
  validTimeMs: number;
  url: string;
}

/** The frames held by the webview, oldest first. */
export interface RadarFrameSet {
  bounds: [number, number, number, number];
  frames: RadarImage[];
}

/** What the map draws: every image loaded, one of them shown. */
export interface RadarView {
  bounds: [number, number, number, number];
  images: RadarImage[];
  shownMs: number;
}

/**
 * The new frame list, taking the images it left out from `prev`. A frame with
 * no image either way (the box changed) is dropped rather than drawn blank.
 */
export function mergeFrames(prev: RadarFrameSet | null, next: RadarFrames): RadarFrameSet {
  const sameBox = prev != null && prev.bounds.join() === next.bounds.join();
  const held = new Map(sameBox ? prev.frames.map((f) => [f.validTimeMs, f.url]) : []);
  return {
    bounds: next.bounds,
    frames: next.frames.flatMap((f) => {
      const url = f.pngBase64 ? pngUrl(f.pngBase64) : held.get(f.validTimeMs);
      return url ? [{ validTimeMs: f.validTimeMs, url }] : [];
    }),
  };
}

export function latestView(s: RadarSnapshot | null): RadarView | null {
  const url = s ? radarDataUrl(s) : null;
  if (!s || !url || !s.bounds || s.validTimeMs == null) return null;
  return { bounds: s.bounds, images: [{ validTimeMs: s.validTimeMs, url }], shownMs: s.validTimeMs };
}

export function animationView(set: RadarFrameSet, index: number): RadarView | null {
  if (set.frames.length === 0) return null;
  const shown = set.frames[Math.min(Math.max(index, 0), set.frames.length - 1)];
  return { bounds: set.bounds, images: set.frames, shownMs: shown.validTimeMs };
}

/** How long frame `index` stays up. */
export const frameDelayMs = (index: number, count: number) =>
  index >= count - 1 ? ANIMATION_HOLD_MS : ANIMATION_FRAME_MS;

export const nextFrame = (index: number, count: number) => (index + 1 >= count ? 0 : index + 1);

/** Minutes from the newest frame to frame `index` (0 or negative). */
export function frameOffsetMinutes(frames: RadarImage[], index: number): number {
  if (frames.length === 0) return 0;
  const newest = frames[frames.length - 1].validTimeMs;
  const shown = frames[Math.min(Math.max(index, 0), frames.length - 1)].validTimeMs;
  return Math.round((shown - newest) / 60_000);
}

export const formatOffset = (minutes: number) => (minutes === 0 ? "latest" : `−${Math.abs(minutes)} min`);
