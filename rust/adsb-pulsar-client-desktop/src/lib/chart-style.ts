import type { CSSProperties } from "react";

/**
 * Shared "glass" styling for the DB History charts: translucent fills with a
 * solid edge, and frosted tooltips. Kept pure so the geometry
 * can be tested without rendering Recharts (which draws nothing under jsdom).
 */

/** App surface (slate-900); used for gaps between stacked marks. */
export const CHART_SURFACE = "#0f172a";

/** Faint dashed horizontal gridlines. */
export const GRID_STROKE = "#1e293b";
export const GRID_DASH = "2 4";

/** Opacity of a translucent bar fill. Stacks stay more opaque so segments don't blend. */
export const GLASS_FILL_OPACITY = 0.6;
export const GLASS_STACK_OPACITY = 0.8;

/** Bar-end corner radius (dataviz spec: 4px data-ends). */
export const BAR_RADIUS = 4;

/** Recharts tooltip `contentStyle`: translucent with a backdrop blur. */
export const frostedTooltipStyle: CSSProperties = {
  backgroundColor: "rgba(15, 23, 42, 0.72)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  border: "1px solid rgba(148, 163, 184, 0.25)",
  borderRadius: 6,
  fontSize: 11,
};

/** Recharts tooltip `cursor`: a soft highlight band instead of a solid block. */
export const softCursor = { fill: "#94a3b8", fillOpacity: 0.08 };

function valid(w: number, h: number): boolean {
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
}

function clampRadius(w: number, h: number, r: number): number {
  return Math.max(0, Math.min(r, w / 2, h));
}

/** Closed path of a bar whose top two corners are rounded. "" for an empty bar. */
export function roundedTopRectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (!valid(w, h)) return "";
  const rr = clampRadius(w, h, r);
  return `M ${x} ${y + h} L ${x} ${y + rr} Q ${x} ${y} ${x + rr} ${y} L ${x + w - rr} ${y} Q ${x + w} ${y} ${x + w} ${y + rr} L ${x + w} ${y + h} Z`;
}

/** Open path along just the top edge of the same bar, for a solid highlight line. */
export function topEdgePath(x: number, y: number, w: number, h: number, r: number): string {
  if (!valid(w, h)) return "";
  const rr = clampRadius(w, h, r);
  return `M ${x} ${y + rr} Q ${x} ${y} ${x + rr} ${y} L ${x + w - rr} ${y} Q ${x + w} ${y} ${x + w} ${y + rr}`;
}
