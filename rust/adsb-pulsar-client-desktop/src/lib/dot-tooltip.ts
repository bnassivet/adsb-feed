/** Hover tooltip content for map dots (moved from MapInner's DotsLayer). */
import type { AircraftTrack, RejectedPosition } from "./types";
import { REASON_COLORS, REASON_LABELS, formatKnots } from "./rejected-positions";

export type DotSetType = "history" | "live" | "imported" | "dbHistory";

/** Format altitude for tooltip display. */
export function formatAlt(alt: number | null | undefined): string {
  if (alt == null) return "N/A";
  return `${alt.toLocaleString()} ft`;
}

/** Relative time, e.g. "2h 5m ago". */
export function timeAgo(lastSeen: number, now: number = Date.now()): string {
  const seconds = Math.floor((now - lastSeen) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

const CLOCK_MS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
};

/** A position's time to the millisecond: the clock alone for today, with the date for an earlier day. */
export function formatPositionTime(ms: number, now: number = Date.now()): string {
  const at = new Date(ms);
  const clock = at.toLocaleTimeString(undefined, CLOCK_MS);
  return at.toDateString() === new Date(now).toDateString() ? clock : `${at.toLocaleDateString()} ${clock}`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Tooltip HTML for one dot. Callsigns come off the air, so they are escaped. */
export function dotTooltipHtml(
  type: DotSetType,
  t: AircraftTrack,
  alt: number | null,
  isLast: boolean,
  /** The hovered position's time (ms since epoch); null when the track carries none. */
  time: number | null = null,
  now: number = Date.now(),
): string {
  const label = escapeHtml(t.callsign ?? t.hex_ident);
  const hex = escapeHtml(t.hex_ident);
  const parts = [`<div style="font-weight:600;color:#fff">${label}</div>`];
  if (type !== "live") parts.push(`<div>Hex: ${hex}</div>`);
  parts.push(`<div>Alt: <span style="color:#fff">${formatAlt(alt)}</span></div>`);
  if (time !== null) parts.push(`<div>Time: <span style="color:#fff">${formatPositionTime(time, now)}</span></div>`);
  if (type === "history" && isLast) parts.push(`<div>Last seen: ${timeAgo(t.last_seen, now)}</div>`);
  if (type === "dbHistory") parts.push(`<div style="color:#22d3ee;margin-top:2px">DB History</div>`);
  if (type === "imported") parts.push(`<div style="color:#818cf8;margin-top:2px">Imported</div>`);
  return parts.join("");
}

/** The colour that marks OpenSky as a point's source (OpenSkyLayer's violet). */
const OPENSKY_TAG_COLOR = "#a78bfa";

/**
 * Hover tooltip for an OpenSky flight-history waypoint. Same layout as a DB
 * History dot -- callsign, hex, altitude -- then the waypoint's time, and
 * OpenSky as the source tag.
 */
export function openSkyWaypointTooltipHtml(
  flight: { hex: string; callsign: string | null },
  alt: number | null,
  timeS: number,
): string {
  const label = escapeHtml(flight.callsign ?? flight.hex);
  const hex = escapeHtml(flight.hex);
  return [
    `<div style="font-weight:600;color:#fff">${label}</div>`,
    `<div>Hex: ${hex}</div>`,
    `<div>Alt: <span style="color:#fff">${formatAlt(alt)}</span></div>`,
    `<div>Time: <span style="color:#fff">${new Date(timeS * 1000).toLocaleTimeString()}</span></div>`,
    `<div style="color:${OPENSKY_TAG_COLOR};margin-top:2px">OpenSky</div>`,
  ].join("");
}

/**
 * Hover tooltip for a rejected position shown from DB History. Same layout as
 * a DB History dot -- callsign, hex, altitude -- then the reason as the tag,
 * and the figure it was judged on.
 */
export function rejectedTooltipHtml(r: RejectedPosition): string {
  const label = escapeHtml(r.callsign ?? r.hex_ident);
  const hex = escapeHtml(r.hex_ident);
  const color = REASON_COLORS[r.reason];
  const parts = [
    `<div style="font-weight:600;color:#fff">${label}</div>`,
    `<div>Hex: ${hex}</div>`,
    `<div>Alt: <span style="color:#fff">${formatAlt(r.altitude)}</span></div>`,
    `<div style="color:${color};margin-top:2px">${REASON_LABELS[r.reason]}</div>`,
  ];
  if (r.reason === "implausible_speed" && r.implied_speed_kt !== null) {
    parts.push(`<div>Speed: <span style="color:#fff">${formatKnots(r.implied_speed_kt)} kt</span></div>`);
  } else if (r.distance_nm !== null) {
    parts.push(`<div>Distance: <span style="color:#fff">${Math.round(r.distance_nm)} NM</span></div>`);
  }
  return parts.join("");
}
