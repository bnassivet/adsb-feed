/**
 * Pure SVG geometry utilities for the detection range radar chart.
 *
 * All functions are framework-agnostic (no React) and fully testable.
 * The polar coordinate system follows aviation convention:
 * 0° = North (up), degrees increase clockwise.
 */

import type { DetectionRangeSector } from "./types";

export interface RadarConfig {
  /** SVG viewBox size (width = height). Default 300. */
  size: number;
  /** Padding from SVG edge for labels. Default 24. */
  padding: number;
}

export type RadarMode = "polygon" | "polar";

export interface RadarPoint {
  x: number;
  y: number;
  bearingDeg: number;
  distanceNm: number;
}

export interface SectorWedge {
  /** SVG path string for the wedge arc. */
  path: string;
  /** Center bearing of this sector in degrees. */
  bearingDeg: number;
  /** Maximum detection distance in this sector (NM). */
  distanceNm: number;
  /** Number of positions observed in this sector. */
  positionCount: number;
  /** Minimum altitude in this sector (feet), or null if no altitude data. */
  minAltitude: number | null;
  /** Maximum altitude in this sector (feet), or null if no altitude data. */
  maxAltitude: number | null;
  /** Number of distinct flights observed in this sector. */
  flightCount: number;
}

export interface DistanceRing {
  radius: number;
  label: string;
}

export interface CardinalLabel {
  label: string;
  x: number;
  y: number;
}

const DEFAULT_CONFIG: RadarConfig = { size: 300, padding: 24 };

/** Maximum distance across all sectors (minimum 1 to avoid divide-by-zero). */
export function computeMaxRange(sectors: DetectionRangeSector[]): number {
  if (sectors.length === 0) return 1;
  return Math.max(1, ...sectors.map((s) => s.max_distance_nm));
}

/**
 * Convert a polar coordinate (bearing + normalized radius) to SVG cartesian.
 *
 * Aviation convention: 0° = North (up), clockwise.
 * SVG convention: Y increases downward.
 */
export function polarToCartesian(
  bearingDeg: number,
  normalizedRadius: number,
  center: number,
  maxRadius: number,
): { x: number; y: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  const r = normalizedRadius * maxRadius;
  return {
    x: center + r * Math.sin(rad),
    y: center - r * Math.cos(rad),
  };
}

/** Build 36 cartesian points from sector data, normalized to the max range. */
export function buildRadarPoints(
  sectors: DetectionRangeSector[],
  config: RadarConfig = DEFAULT_CONFIG,
): RadarPoint[] {
  const maxRange = computeMaxRange(sectors);
  const center = config.size / 2;
  const maxRadius = center - config.padding;

  return sectors.map((s) => {
    const normalized = maxRange > 0 ? s.max_distance_nm / maxRange : 0;
    const { x, y } = polarToCartesian(s.bearing_deg, normalized, center, maxRadius);
    return { x, y, bearingDeg: s.bearing_deg, distanceNm: s.max_distance_nm };
  });
}

/** Build a closed SVG path string from radar points (polygon mode). */
export function buildRadarPath(points: RadarPoint[]): string {
  if (points.length === 0) return "";
  const parts = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  return parts.join("") + "Z";
}

/** Build SVG arc wedge paths for each non-zero sector (polar area chart). */
export function buildSectorWedges(
  sectors: DetectionRangeSector[],
  config: RadarConfig = DEFAULT_CONFIG,
): SectorWedge[] {
  const maxRange = computeMaxRange(sectors);
  const center = config.size / 2;
  const maxRadius = center - config.padding;
  const halfAngle = 5; // 10° sectors → ±5° from center bearing

  return sectors
    .filter((s) => s.max_distance_nm > 0)
    .map((s) => {
      const normalized = s.max_distance_nm / maxRange;
      const r = normalized * maxRadius;
      const start = polarToCartesian(s.bearing_deg - halfAngle, normalized, center, maxRadius);
      const end = polarToCartesian(s.bearing_deg + halfAngle, normalized, center, maxRadius);

      // M center → L arc start → A (arc to end) → Z (close to center)
      const path = [
        `M${center.toFixed(1)},${center.toFixed(1)}`,
        `L${start.x.toFixed(1)},${start.y.toFixed(1)}`,
        `A${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${end.x.toFixed(1)},${end.y.toFixed(1)}`,
        "Z",
      ].join("");

      return {
        path,
        bearingDeg: s.bearing_deg,
        distanceNm: s.max_distance_nm,
        positionCount: s.position_count,
        minAltitude: s.min_altitude,
        maxAltitude: s.max_altitude,
        flightCount: s.flight_count,
      };
    });
}

/** Build concentric distance rings with labels. */
export function buildDistanceRings(
  maxRange: number,
  config: RadarConfig = DEFAULT_CONFIG,
): DistanceRing[] {
  const center = config.size / 2;
  const maxRadius = center - config.padding;
  const ringCount = maxRange <= 50 ? 3 : maxRange <= 150 ? 4 : 5;

  return Array.from({ length: ringCount }, (_, i) => {
    const fraction = (i + 1) / ringCount;
    const nm = maxRange * fraction;
    return {
      radius: maxRadius * fraction,
      label: `${Math.round(nm)} NM`,
    };
  });
}

/** Build cardinal direction labels (N, E, S, W) positioned outside the chart area. */
export function buildCardinalLabels(
  config: RadarConfig = DEFAULT_CONFIG,
): CardinalLabel[] {
  const center = config.size / 2;
  const labelOffset = config.padding / 2;
  return [
    { label: "N", x: center, y: labelOffset },
    { label: "E", x: config.size - labelOffset, y: center },
    { label: "S", x: center, y: config.size - labelOffset },
    { label: "W", x: labelOffset, y: center },
  ];
}
