/**
 * Typed-array buffers for drawing track positions as deck.gl dots
 * (see components/DeckDotsOverlay.tsx and docs/MAP_BENCH.md).
 *
 * One buffer holds every point of a dot set. Per point there are 8 bytes of
 * lng/lat (Float32: about 1 m at these latitudes, below one pixel at any useful
 * zoom) and 4 bytes of RGBA. There is no per-point track index: `starts` gives
 * each track's first point, and `locateDot` binary-searches it on hover only.
 */
import { cachedAltitudeToColor, type MapTheme } from "./colors";
import { isColumnar, trackKey, type AircraftTrack, type AltitudeColorMode } from "./types";

export type Rgb = [number, number, number];

export interface DotBuffers {
  length: number;
  /** Interleaved lng, lat. */
  positions: Float32Array;
  /** Interleaved r, g, b, a. */
  colors: Uint8Array;
  /** Track k owns points [starts[k], starts[k+1]). */
  starts: Uint32Array;
  /** The tracks drawn, in buffer order. */
  tracks: AircraftTrack[];
}

export interface DotBufferOptions {
  colorMode: AltitudeColorMode;
  theme: MapTheme;
  /** 0–1, written into every point's alpha byte. */
  alpha: number;
  /** Keep only these track keys (used for the selected-track overlay). */
  only?: ReadonlySet<string>;
}

const rgbCache = new Map<string, Rgb>();

/** Parses the two colour forms `colors.ts` produces: `rgb(r,g,b)` and `#rrggbb`. */
export function cssToRgb(css: string): Rgb {
  const hit = rgbCache.get(css);
  if (hit) return hit;
  let rgb: Rgb;
  if (css.startsWith("#")) {
    const n = parseInt(css.slice(1, 7), 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    const m = css.match(/\d+/g) ?? ["0", "0", "0"];
    rgb = [Number(m[0]), Number(m[1]), Number(m[2])];
  }
  if (rgbCache.size > 4096) rgbCache.clear();
  rgbCache.set(css, rgb);
  return rgb;
}

function altAt(t: AircraftTrack, i: number): number | null {
  const p = t.positions;
  if (isColumnar(p)) {
    const a = p.alt[i];
    return Number.isNaN(a) ? null : a;
  }
  return p[i][2];
}

/** Tracks with fewer than two positions are skipped, as `DotsLayer` did. */
export function buildDotBuffers(tracks: readonly AircraftTrack[], opts: DotBufferOptions): DotBuffers {
  const kept = tracks.filter((t) => t.positions.length >= 2 && (!opts.only || opts.only.has(trackKey(t))));
  const starts = new Uint32Array(kept.length + 1);
  for (let k = 0; k < kept.length; k++) starts[k + 1] = starts[k] + kept[k].positions.length;
  const length = starts[kept.length];
  const positions = new Float32Array(length * 2);
  const colors = new Uint8Array(length * 4);
  const alpha = Math.round(Math.max(0, Math.min(1, opts.alpha)) * 255);

  for (let k = 0; k < kept.length; k++) {
    const t = kept[k];
    const p = t.positions;
    const base = starts[k];
    const n = p.length;
    const trackRgb = opts.colorMode === "plot" ? null : cssToRgb(cachedAltitudeToColor(t.altitude, opts.theme));
    if (isColumnar(p)) {
      for (let i = 0; i < n; i++) {
        positions[2 * (base + i)] = p.lng[i];
        positions[2 * (base + i) + 1] = p.lat[i];
      }
    } else {
      for (let i = 0; i < n; i++) {
        positions[2 * (base + i)] = p[i][1];
        positions[2 * (base + i) + 1] = p[i][0];
      }
    }
    for (let i = 0; i < n; i++) {
      const rgb = trackRgb ?? cssToRgb(cachedAltitudeToColor(altAt(t, i), opts.theme));
      const o = 4 * (base + i);
      colors[o] = rgb[0];
      colors[o + 1] = rgb[1];
      colors[o + 2] = rgb[2];
      colors[o + 3] = alpha;
    }
  }
  return { length, positions, colors, starts, tracks: kept };
}

export interface LocatedDot {
  track: AircraftTrack;
  /** Index into `track.positions`. */
  index: number;
  lat: number;
  lng: number;
  alt: number | null;
  isLast: boolean;
}

/** Maps a deck.gl picking index back to the track and position it came from. */
export function locateDot(buf: DotBuffers, i: number): LocatedDot | null {
  if (!Number.isInteger(i) || i < 0 || i >= buf.length) return null;
  let lo = 0;
  let hi = buf.tracks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buf.starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  const track = buf.tracks[lo];
  const index = i - buf.starts[lo];
  const p = track.positions;
  const [lat, lng] = isColumnar(p) ? [p.lat[index], p.lng[index]] : [p[index][0], p[index][1]];
  return { track, index, lat, lng, alt: altAt(track, index), isLast: index === p.length - 1 };
}
