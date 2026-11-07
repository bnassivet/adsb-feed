import type { DensityMetric, DensityTooltipMode } from "./types";
import type { DensityProperties } from "./h3-density";
import { haversineDistanceNm } from "./geo";

type ReceiverLocation = { lat: number; lng: number; alt: number | null };

/** Build compact (single-line) tooltip for density cell. */
function buildCompactTooltip(props: DensityProperties, metric: DensityMetric): string {
  const val = `<span style="color:#fff">${Math.round(props.value).toLocaleString()}</span>`;
  if (metric === "altitude") return `Mean alt: ${val} ft`;
  if (metric === "altitude_min") return `Min alt: ${val} ft`;
  if (metric === "altitude_max") return `Max alt: ${val} ft`;
  const label = metric === "positions" ? "Positions" : "Aircraft";
  return `${label}: ${val}`;
}

/** Build extended (multi-line) tooltip showing all metrics + distance from receiver. */
function buildExtendedTooltip(props: DensityProperties, receiverLocation?: ReceiverLocation): string {
  const w = (v: string) => `<span style="color:#fff">${v}</span>`;
  const fmtAlt = (v: number | null) => v != null ? w(`${Math.round(v).toLocaleString()} ft`) : "N/A";

  const lines: string[] = [
    `<div style="font-weight:600;color:#22d3ee;margin-bottom:2px">H3 Cell</div>`,
    `Positions: ${w(props.positions.toLocaleString())}`,
    `Aircraft: ${w(props.aircraftCount.toLocaleString())}`,
    `Mean alt: ${fmtAlt(props.meanAlt)}`,
    `Min alt: ${fmtAlt(props.minAlt)}`,
    `Max alt: ${fmtAlt(props.maxAlt)}`,
  ];

  if (receiverLocation && props.cellCenter) {
    const d = haversineDistanceNm(
      receiverLocation.lat, receiverLocation.lng,
      props.cellCenter[0], props.cellCenter[1],
    );
    lines.push(`Distance: ${w(`${d.toFixed(1)} NM`)}`);
  }

  return lines.join("<br>");
}

/**
 * Tooltip HTML for one density cell, or `null` when tooltips are off —
 * the caller then binds nothing, so hovering the overlay is silent.
 */
export function buildDensityTooltip(
  mode: DensityTooltipMode,
  props: DensityProperties,
  metric: DensityMetric,
  receiverLocation?: ReceiverLocation,
): string | null {
  if (mode === "off") return null;
  if (mode === "extended") return buildExtendedTooltip(props, receiverLocation);
  return buildCompactTooltip(props, metric);
}
