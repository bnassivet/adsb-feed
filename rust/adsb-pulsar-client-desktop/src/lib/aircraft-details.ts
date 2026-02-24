/** Vertical tendency threshold in ft/min. */
const VERTICAL_RATE_THRESHOLD = 200;

/** Classify vertical movement from vertical_rate (ft/min). */
export function verticalTendency(vr: number | null): "climbing" | "descending" | "level" {
  if (vr === null) return "level";
  if (vr >= VERTICAL_RATE_THRESHOLD) return "climbing";
  if (vr <= -VERTICAL_RATE_THRESHOLD) return "descending";
  return "level";
}

/** Format vertical rate for display, e.g. "+2,400 ft/min", "-800 ft/min", "±0 ft/min". */
export function formatVerticalRate(vr: number | null): string {
  if (vr === null) return "—";
  if (vr === 0) return "±0 ft/min";
  const sign = vr > 0 ? "+" : "-";
  const abs = Math.abs(vr).toLocaleString("en-US");
  return `${sign}${abs} ft/min`;
}

/**
 * Extract altitude values from position history, filtering out null altitudes.
 * Positions are [lat, lng, altitude | null][].
 */
export function altitudeHistory(positions: [number, number, number | null][]): number[] {
  return positions
    .map(p => p[2])
    .filter((alt): alt is number => alt !== null);
}

/**
 * Return the min/max altitude bounds from a non-empty altitude array.
 * Returns null for empty input.
 */
export function altitudeRange(altitudes: number[]): { min: number; max: number } | null {
  if (altitudes.length === 0) return null;
  return { min: Math.min(...altitudes), max: Math.max(...altitudes) };
}

/**
 * Format a ms-since-epoch timestamp as HH:MM:SS.
 * Optional tzName: IANA timezone name; omit (or pass "Local") for machine local time.
 */
export function formatTrackTime(ms: number, tzName?: string): string {
  if (!tzName || tzName === "Local") {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }
  // Use Intl for explicit non-local TZ
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tzName,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

/**
 * Compute SVG polyline `points` attribute string from altitude array.
 * Normalizes to the given viewBox dimensions (width × height).
 * Higher altitudes map to lower Y values (SVG Y-axis is top-down).
 * Returns "" for empty input.
 */
export function altitudeSparklinePoints(
  altitudes: number[],
  width: number,
  height: number,
): string {
  if (altitudes.length === 0) return "";

  const min = Math.min(...altitudes);
  const max = Math.max(...altitudes);
  const range = max - min;

  return altitudes
    .map((alt, i) => {
      const x = altitudes.length === 1 ? 0 : (i / (altitudes.length - 1)) * width;
      // Invert Y: higher altitude → lower Y value in SVG
      const y = range === 0 ? height / 2 : height - ((alt - min) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");
}
