/** Pre-computed altitude scale stops for rendering a color legend. */
export const ALTITUDE_SCALE_STOPS: { altitude: number; color: string }[] = [
  { altitude: 0, color: "rgb(0,0,255)" },
  { altitude: 6250, color: "rgb(0,128,255)" },
  { altitude: 12500, color: "rgb(0,255,255)" },
  { altitude: 18750, color: "rgb(0,255,128)" },
  { altitude: 25000, color: "rgb(0,255,0)" },
  { altitude: 31250, color: "rgb(128,255,0)" },
  { altitude: 37500, color: "rgb(255,255,0)" },
  { altitude: 43750, color: "rgb(255,128,0)" },
  { altitude: 50000, color: "rgb(255,0,0)" },
];

/** Maps altitude (feet) to a color on a Jet-like scale.
 *
 * 0ft = blue, 12500ft = cyan, 25000ft = green, 37500ft = yellow, 50000ft = red.
 */
export function altitudeToColor(altitude: number | null): string {
  if (altitude == null) return "#888888"; // handles both null and undefined

  const clamped = Math.max(0, Math.min(50000, altitude));
  const ratio = clamped / 50000;

  // Jet colormap approximation
  if (ratio < 0.25) {
    const t = ratio / 0.25;
    return interpolateColor([0, 0, 255], [0, 255, 255], t);
  } else if (ratio < 0.5) {
    const t = (ratio - 0.25) / 0.25;
    return interpolateColor([0, 255, 255], [0, 255, 0], t);
  } else if (ratio < 0.75) {
    const t = (ratio - 0.5) / 0.25;
    return interpolateColor([0, 255, 0], [255, 255, 0], t);
  } else {
    const t = (ratio - 0.75) / 0.25;
    return interpolateColor([255, 255, 0], [255, 0, 0], t);
  }
}

/**
 * Maps a normalized density value (0-1) to a purple→yellow→red color
 * with ramping opacity — visually distinct from the Jet altitude colormap.
 */
export function densityColor(normalized: number): { color: string; fillOpacity: number } {
  const t = Math.max(0, Math.min(1, normalized));

  let color: string;
  if (t < 0.5) {
    // purple → yellow
    const s = t / 0.5;
    color = interpolateColor([128, 0, 128], [255, 255, 0], s);
  } else {
    // yellow → red
    const s = (t - 0.5) / 0.5;
    color = interpolateColor([255, 255, 0], [255, 0, 0], s);
  }

  // Reduced max opacity from 0.8 to 0.3 for better transparency at high densities
  const fillOpacity = 0.08 + 0.22 * t;
  return { color, fillOpacity };
}

const COLOR_CACHE_MAX = 512;
const colorCache = new Map<number | null, string>();

/** Cached version of altitudeToColor — avoids recomputing the same rgb() string. */
export function cachedAltitudeToColor(altitude: number | null): string {
  // Normalize undefined to null for consistent cache keys
  const key = altitude ?? null;
  const cached = colorCache.get(key);
  if (cached !== undefined) return cached;

  const color = altitudeToColor(key);

  if (colorCache.size >= COLOR_CACHE_MAX) {
    // Evict oldest entry (first inserted)
    const firstKey = colorCache.keys().next().value;
    colorCache.delete(firstKey!);
  }
  colorCache.set(key, color);

  return color;
}

/** Clears the altitude color cache. Exported for testing. */
export function clearColorCache(): void {
  colorCache.clear();
}

function interpolateColor(
  from: [number, number, number],
  to: [number, number, number],
  t: number,
): string {
  const r = Math.round(from[0] + (to[0] - from[0]) * t);
  const g = Math.round(from[1] + (to[1] - from[1]) * t);
  const b = Math.round(from[2] + (to[2] - from[2]) * t);
  return `rgb(${r},${g},${b})`;
}
