/** Hover tooltip content for map dots (moved from MapInner's DotsLayer). */
import type { AircraftTrack } from "./types";

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

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Tooltip HTML for one dot. Callsigns come off the air, so they are escaped. */
export function dotTooltipHtml(
  type: DotSetType,
  t: AircraftTrack,
  alt: number | null,
  isLast: boolean,
  now: number = Date.now(),
): string {
  const label = escapeHtml(t.callsign ?? t.hex_ident);
  const hex = escapeHtml(t.hex_ident);
  const parts = [`<div style="font-weight:600;color:#fff">${label}</div>`];
  if (type !== "live") parts.push(`<div>Hex: ${hex}</div>`);
  parts.push(`<div>Alt: <span style="color:#fff">${formatAlt(alt)}</span></div>`);
  if (type === "history" && isLast) parts.push(`<div>Last seen: ${timeAgo(t.last_seen, now)}</div>`);
  if (type === "dbHistory") parts.push(`<div style="color:#22d3ee;margin-top:2px">DB History</div>`);
  if (type === "imported") parts.push(`<div style="color:#818cf8;margin-top:2px">Imported</div>`);
  return parts.join("");
}
