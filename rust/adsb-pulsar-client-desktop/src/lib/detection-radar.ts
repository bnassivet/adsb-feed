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

export interface RadarPoint {
  x: number;
  y: number;
  bearingDeg: number;
  distanceNm: number;
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

/** Build a closed SVG path string from radar points. */
export function buildRadarPath(points: RadarPoint[]): string {
  if (points.length === 0) return "";
  const parts = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  return parts.join("") + "Z";
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
