/** Pre-computed altitude scale stops for dark theme (Jet colormap). */
export const ALTITUDE_SCALE_STOPS_DARK: { altitude: number; color: string }[] = [
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

/** Pre-computed altitude scale stops for light theme (no green — navy→indigo→crimson→burnt orange→dark red). */
export const ALTITUDE_SCALE_STOPS_LIGHT: { altitude: number; color: string }[] = [
  { altitude: 0, color: "rgb(0,0,180)" },
  { altitude: 6250, color: "rgb(50,0,170)" },
  { altitude: 12500, color: "rgb(100,0,160)" },
  { altitude: 18750, color: "rgb(140,0,120)" },
  { altitude: 25000, color: "rgb(170,0,80)" },
  { altitude: 31250, color: "rgb(185,20,40)" },
  { altitude: 37500, color: "rgb(190,60,0)" },
  { altitude: 43750, color: "rgb(185,90,0)" },
  { altitude: 50000, color: "rgb(170,0,0)" },
];

/** @deprecated Use altitudeScaleStops(theme) instead. Kept for backward compatibility. */
export const ALTITUDE_SCALE_STOPS = ALTITUDE_SCALE_STOPS_DARK;

export type MapTheme = "light" | "dark";

/** Returns the altitude scale stops for the given theme. */
export function altitudeScaleStops(theme: MapTheme) {
  return theme === "light" ? ALTITUDE_SCALE_STOPS_LIGHT : ALTITUDE_SCALE_STOPS_DARK;
}

/** Maps altitude (feet) to a color on a Jet-like scale (dark theme).
 *
 * 0ft = blue, 12500ft = cyan, 25000ft = green, 37500ft = yellow, 50000ft = red.
 */
function altitudeToColorDark(altitude: number): string {
  const clamped = Math.max(0, Math.min(50000, altitude));
  const ratio = clamped / 50000;

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

/** Maps altitude (feet) to a dark no-green scale (light theme).
 *
 * 0ft = navy, 12500ft = dark indigo, 25000ft = dark crimson, 37500ft = burnt orange, 50000ft = dark red.
 */
function altitudeToColorLight(altitude: number): string {
  const clamped = Math.max(0, Math.min(50000, altitude));
  const ratio = clamped / 50000;

  if (ratio < 0.25) {
    const t = ratio / 0.25;
    return interpolateColor([0, 0, 180], [100, 0, 160], t);
  } else if (ratio < 0.5) {
    const t = (ratio - 0.25) / 0.25;
    return interpolateColor([100, 0, 160], [170, 0, 80], t);
  } else if (ratio < 0.75) {
    const t = (ratio - 0.5) / 0.25;
    return interpolateColor([170, 0, 80], [190, 60, 0], t);
  } else {
    const t = (ratio - 0.75) / 0.25;
    return interpolateColor([190, 60, 0], [170, 0, 0], t);
  }
}

/** Maps altitude to color using the appropriate scale for the given theme. */
export function altitudeToColor(altitude: number | null, theme: MapTheme = "dark"): string {
  if (altitude == null) return "#888888";
  return theme === "light" ? altitudeToColorLight(altitude) : altitudeToColorDark(altitude);
}

/**
 * Maps a normalized density value (0-1) to a theme-appropriate color
 * with ramping opacity — visually distinct from the altitude colormap.
 *
 * Dark theme: purple → yellow → red (bright, high-contrast on dark basemap)
 * Light theme: dark teal → dark gold → dark brown (muted, visible on bright basemap)
 */
export function densityColor(normalized: number, theme: MapTheme = "dark"): { color: string; fillOpacity: number } {
  const t = Math.max(0, Math.min(1, normalized));

  let color: string;
  if (theme === "light") {
    if (t < 0.5) {
      // dark teal → dark gold
      const s = t / 0.5;
      color = interpolateColor([0, 100, 100], [180, 150, 0], s);
    } else {
      // dark gold → dark brown
      const s = (t - 0.5) / 0.5;
      color = interpolateColor([180, 150, 0], [140, 40, 0], s);
    }
  } else {
    if (t < 0.5) {
      // purple → yellow
      const s = t / 0.5;
      color = interpolateColor([128, 0, 128], [255, 255, 0], s);
    } else {
      // yellow → red
      const s = (t - 0.5) / 0.5;
      color = interpolateColor([255, 255, 0], [255, 0, 0], s);
    }
  }

  const fillOpacity = 0.12 + 0.22 * t;
  return { color, fillOpacity };
}

const COLOR_CACHE_MAX = 512;
const colorCacheDark = new Map<number | null, string>();
const colorCacheLight = new Map<number | null, string>();

/** Cached version of altitudeToColor — avoids recomputing the same rgb() string. */
export function cachedAltitudeToColor(altitude: number | null, theme: MapTheme = "dark"): string {
  const key = altitude ?? null;
  const cache = theme === "light" ? colorCacheLight : colorCacheDark;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const color = altitudeToColor(key, theme);

  if (cache.size >= COLOR_CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey!);
  }
  cache.set(key, color);

  return color;
}

/** Clears the altitude color cache. Exported for testing. */
export function clearColorCache(): void {
  colorCacheDark.clear();
  colorCacheLight.clear();
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
