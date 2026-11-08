import type { Positions } from "./types";
import { isColumnar } from "./types";
import { haversineDistanceNm } from "./geo";

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
 * Supports both tuple arrays and ColumnarPositions.
 */
export function altitudeHistory(positions: Positions): number[] {
  if (isColumnar(positions)) {
    const result: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      const a = positions.alt[i];
      if (!Number.isNaN(a)) result.push(a);
    }
    return result;
  }
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

/** Exact, by definition of the international nautical mile. */
const KM_PER_NM = 1.852;

/**
 * Great-circle distance from the receiver to the aircraft's latest position, in NM.
 * Null when either end is unknown: a track with no position yet, or no receiver configured.
 */
export function receiverDistanceNm(
  track: { latitude: number | null; longitude: number | null },
  receiver: { lat: number; lng: number; alt?: number | null } | null | undefined,
): number | null {
  if (!receiver || track.latitude === null || track.longitude === null) return null;
  return haversineDistanceNm(receiver.lat, receiver.lng, track.latitude, track.longitude);
}

/** One decimal below 100, whole numbers from 100 up, per unit. */
function formatUnit(v: number): string {
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1);
}

/** `"18.5 km / 10.0 NM"`. */
export function formatDistance(nm: number): string {
  return `${formatUnit(nm * KM_PER_NM)} km / ${formatUnit(nm)} NM`;
}

/** Receiver position; `alt` in feet like aircraft altitudes (`receiver_altitude`), null = sea level. */
export interface ReceiverPoint {
  lat: number;
  lng: number;
  alt?: number | null;
}

const FT_TO_M = 0.3048;
/** Same sphere as `haversineDistanceNm` (3440.065 NM), in metres. */
const EARTH_RADIUS_M = 3440.065 * KM_PER_NM * 1000;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Initial great-circle bearing from the receiver to the aircraft, degrees true, 0..360.
 * Null when either position is unknown, or when the aircraft is exactly over the receiver
 * (no bearing exists there).
 */
export function receiverAzimuthDeg(
  track: { latitude: number | null; longitude: number | null },
  receiver: ReceiverPoint | null | undefined,
): number | null {
  if (!receiver || track.latitude === null || track.longitude === null) return null;
  if (track.latitude === receiver.lat && track.longitude === receiver.lng) return null;
  const p1 = toRad(receiver.lat);
  const p2 = toRad(track.latitude);
  const dl = toRad(track.longitude - receiver.lng);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Elevation angle of the aircraft above the receiver's local horizon, degrees
 * (negative = below it). Geometric, on a spherical Earth: curvature is included,
 * so a distant aircraft sinks toward the horizon, but atmospheric refraction is not.
 * Uses the reported (barometric) altitude as height above sea level, a few hundred feet
 * of error at most, which is well under 0.1° beyond a few NM.
 */
export function receiverElevationDeg(
  track: { latitude: number | null; longitude: number | null; altitude: number | null },
  receiver: ReceiverPoint | null | undefined,
): number | null {
  if (track.altitude === null) return null;
  const nm = receiverDistanceNm(track, receiver);
  if (nm === null) return null;
  const theta = nm / 3440.065; // central angle, rad
  const rAircraft = EARTH_RADIUS_M + track.altitude * FT_TO_M;
  const rReceiver = EARTH_RADIUS_M + (receiver!.alt ?? 0) * FT_TO_M;
  // Receiver-local frame: "up" along the receiver's radius, "out" toward the aircraft.
  const up = rAircraft * Math.cos(theta) - rReceiver;
  const out = rAircraft * Math.sin(theta);
  return toDeg(Math.atan2(up, out));
}

/** `"89.6°"`; with `wrap360`, a value that rounds to 360.0 reads as 0.0 (an azimuth). */
export function formatAngle(deg: number, opts: { wrap360?: boolean } = {}): string {
  let v = Math.round(deg * 10) / 10;
  if (opts.wrap360 && v >= 360) v -= 360;
  return `${v.toFixed(1)}°`;
}
