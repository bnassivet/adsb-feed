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
  /** Distance of this ring from the receiver (NM). */
  nm: number;
}

/** Ring spacing chosen by the user: a fixed step in NM, or "auto". */
export type RingStep = "auto" | number;

/** Steps the radar offers, smallest first. Auto starts from the first. */
export const RING_STEPS_NM = [10, 25, 50, 100, 200] as const;

/** Never draw more rings than this; a step that would need more moves up. */
export const MAX_RINGS = 5;

/**
 * Width of the distance bins requested from the backend (NM). Every step in
 * `RING_STEPS_NM` is a multiple of it, so changing the step only re-buckets
 * on the client.
 */
export const RADAR_BAND_WIDTH_NM = 5;

export interface RingScale {
  /** Distance between two rings (NM). */
  stepNm: number;
  /** Number of rings drawn, 1..MAX_RINGS. */
  ringCount: number;
  /** Distance of the outermost ring, which sits on the chart edge (NM). */
  outerNm: number;
}

export interface DensityCell {
  /** SVG path of the annular sector (a wedge for the innermost ring). */
  path: string;
  bearingDeg: number;
  /** 0 = innermost ring band. */
  ringIndex: number;
  /** Positions in this sector × ring band. */
  count: number;
  /** count / busiest cell's count, in (0, 1]. */
  t: number;
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
 * Resolve the user's ring step against the receiver's max range so that the
 * outermost ring covers the max range with at most `MAX_RINGS` rings.
 *
 * The chosen step is kept when it fits; otherwise the next listed step is
 * tried, and past the last one, multiples of it.
 */
export function resolveRingStep(maxRange: number, choice: RingStep): RingScale {
  const range = Math.max(maxRange, Number.MIN_VALUE);
  const fits = (step: number) => Math.ceil(range / step) <= MAX_RINGS;

  let stepNm: number = choice === "auto" ? RING_STEPS_NM[0] : choice;
  if (!fits(stepNm)) {
    const larger = RING_STEPS_NM.find((s) => s > stepNm && fits(s));
    if (larger !== undefined) {
      stepNm = larger;
    } else {
      const last = RING_STEPS_NM[RING_STEPS_NM.length - 1];
      stepNm = Math.ceil(range / MAX_RINGS / last) * last;
    }
  }
  const ringCount = Math.max(1, Math.ceil(range / stepNm));
  return { stepNm, ringCount, outerNm: ringCount * stepNm };
}

/**
 * Fold the backend's fine distance bins (`binNm` wide) into `ringCount` ring
 * bands of `stepNm`. Anything beyond the outer ring lands in the last band,
 * so the total is always preserved.
 */
export function rebinBandCounts(
  bandCounts: number[] | undefined,
  binNm: number,
  stepNm: number,
  ringCount: number,
): number[] {
  const rings = new Array<number>(ringCount).fill(0);
  (bandCounts ?? []).forEach((count, i) => {
    const ring = Math.min(Math.floor((i * binNm) / stepNm), ringCount - 1);
    rings[ring] += count;
  });
  return rings;
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

/** Build 36 cartesian points from sector data, normalized to `scaleNm` (default: the max range). */
export function buildRadarPoints(
  sectors: DetectionRangeSector[],
  config: RadarConfig = DEFAULT_CONFIG,
  scaleNm: number = computeMaxRange(sectors),
): RadarPoint[] {
  const maxRange = scaleNm;
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

/** Build SVG arc wedge paths for each non-zero sector (polar area chart), normalized to `scaleNm`. */
export function buildSectorWedges(
  sectors: DetectionRangeSector[],
  config: RadarConfig = DEFAULT_CONFIG,
  scaleNm: number = computeMaxRange(sectors),
): SectorWedge[] {
  const maxRange = scaleNm;
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

/**
 * Build concentric distance rings at round multiples of the resolved step
 * (see `resolveRingStep`). The outermost ring sits on the chart edge, so
 * wedges and polygons drawn with `scaleNm = outerNm` line up with the rings.
 */
export function buildDistanceRings(
  maxRange: number,
  step: RingStep,
  config: RadarConfig = DEFAULT_CONFIG,
): DistanceRing[] {
  const center = config.size / 2;
  const maxRadius = center - config.padding;
  const { stepNm, ringCount } = resolveRingStep(maxRange, step);

  return Array.from({ length: ringCount }, (_, i) => {
    const nm = stepNm * (i + 1);
    return {
      radius: (maxRadius * (i + 1)) / ringCount,
      label: `${nm} NM`,
      nm,
    };
  });
}

/**
 * Build one annular-sector cell per (sector, band of `stepNm`) holding
 * positions, from each sector's `band_counts`. `t` is relative to the busiest
 * cell so the color ramp spans the data actually shown.
 *
 * Radii are normalized to `scaleNm` (default `stepNm × ringCount`); a band
 * reaching past it is clipped at the chart edge.
 */
export function buildDensityCells(
  sectors: DetectionRangeSector[],
  stepNm: number,
  ringCount: number,
  config: RadarConfig = DEFAULT_CONFIG,
  binNm: number = RADAR_BAND_WIDTH_NM,
  scaleNm: number = stepNm * ringCount,
): DensityCell[] {
  const center = config.size / 2;
  const maxRadius = center - config.padding;
  const halfAngle = 5;
  const pt = (bearing: number, fraction: number) =>
    polarToCartesian(bearing, fraction, center, maxRadius);
  const f = (n: number) => n.toFixed(1);

  const raw: Omit<DensityCell, "t">[] = [];
  for (const s of sectors) {
    if (!s.band_counts?.length) continue;
    const rings = rebinBandCounts(s.band_counts, binNm, stepNm, ringCount);
    rings.forEach((count, ringIndex) => {
      if (count <= 0) return;
      const inner = Math.min((ringIndex * stepNm) / scaleNm, 1);
      const outer = Math.min(((ringIndex + 1) * stepNm) / scaleNm, 1);
      const a0 = s.bearing_deg - halfAngle;
      const a1 = s.bearing_deg + halfAngle;
      const oStart = pt(a0, outer);
      const oEnd = pt(a1, outer);
      const rOut = outer * maxRadius;
      let path: string;
      if (ringIndex === 0) {
        path =
          `M${f(center)},${f(center)}` +
          `L${f(oStart.x)},${f(oStart.y)}` +
          `A${f(rOut)},${f(rOut)} 0 0 1 ${f(oEnd.x)},${f(oEnd.y)}Z`;
      } else {
        const iStart = pt(a0, inner);
        const iEnd = pt(a1, inner);
        const rIn = inner * maxRadius;
        path =
          `M${f(oStart.x)},${f(oStart.y)}` +
          `A${f(rOut)},${f(rOut)} 0 0 1 ${f(oEnd.x)},${f(oEnd.y)}` +
          `L${f(iEnd.x)},${f(iEnd.y)}` +
          `A${f(rIn)},${f(rIn)} 0 0 0 ${f(iStart.x)},${f(iStart.y)}Z`;
      }
      raw.push({ path, bearingDeg: s.bearing_deg, ringIndex, count });
    });
  }

  const busiest = Math.max(0, ...raw.map((c) => c.count));
  return raw.map((c) => ({ ...c, t: busiest > 0 ? c.count / busiest : 0 }));
}

/** Lowest ramp position of a non-empty density cell: already a visible cyan. */
const DENSITY_FLOOR = 0.15;

/**
 * Map a cell's linear share of the busiest cell (`t`) onto the heatmap ramp.
 *
 * Density falls off steeply with distance, so on a linear scale most cells sit
 * at a few percent, in the ramp's near-transparent slate band. A square root
 * spreads them out, and the floor keeps every non-empty cell visible.
 */
export function densityIntensity(t: number): number {
  if (t <= 0) return 0;
  return DENSITY_FLOOR + (1 - DENSITY_FLOOR) * Math.sqrt(Math.min(t, 1));
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
