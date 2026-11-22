import { cellToBoundary, latLngToCell } from "h3-js";
import type { RejectedPosition, RejectionReason } from "./types";

export const REASON_LABELS: Record<RejectionReason, string> = {
  out_of_range: "Out of range",
  implausible_speed: "Impossible speed",
};

export const REASON_TITLES: Record<RejectionReason, string> = {
  out_of_range: "Farther from the receiver than any reception reaches",
  implausible_speed: "No neighbouring fix of the same aircraft is reachable from it",
};

/** Map colour per reason, matching the table's text colours. */
export const REASON_COLORS: Record<RejectionReason, string> = {
  out_of_range: "#fb923c", // orange-400
  implausible_speed: "#facc15", // yellow-400
};

/**
 * Identity of a rejected fix: what was received, not when it was judged.
 * Two fixes of one aircraft can share a timestamp, so the position is part
 * of it.
 */
export function rejectedKey(r: RejectedPosition): string {
  return `${r.hex_ident}|${r.timestamp_ms}|${r.latitude}|${r.longitude}`;
}

export function isShown(shown: readonly RejectedPosition[], r: RejectedPosition): boolean {
  const key = rejectedKey(r);
  return shown.some((s) => rejectedKey(s) === key);
}

/**
 * Show or hide `rows` on the map, leaving every other shown row alone.
 * Order is kept, and nothing is shown twice.
 */
export function setShown(
  shown: readonly RejectedPosition[],
  rows: readonly RejectedPosition[],
  show: boolean
): RejectedPosition[] {
  if (!show) {
    const hide = new Set(rows.map(rejectedKey));
    return shown.filter((s) => !hide.has(rejectedKey(s)));
  }
  const out = [...shown];
  const seen = new Set(shown.map(rejectedKey));
  for (const r of rows) {
    const key = rejectedKey(r);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

export function formatKnots(kt: number): string {
  return Math.round(kt).toLocaleString("en-US");
}

/** The H3 cell holding the fix at `resolution`, outlined as [lat, lng] pairs. */
export function rejectedCell(
  r: RejectedPosition,
  resolution: number
): { id: string; boundary: [number, number][] } | null {
  if (r.latitude === null || r.longitude === null) return null;
  const id = latLngToCell(r.latitude, r.longitude, resolution);
  return { id, boundary: cellToBoundary(id) as [number, number][] };
}
