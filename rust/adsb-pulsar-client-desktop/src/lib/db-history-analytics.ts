import type { AircraftSummary, TimeDistributionBucket, TimeGranularity } from "./types";

/** A single bin in an altitude histogram. */
export interface AltitudeBin {
  label: string;
  count: number;
  minAlt: number;
  maxAlt: number;
}

/** Summary statistics computed from aircraft summaries. */
export interface DbHistorySummary {
  totalTracks: number;
  totalPositions: number;
  avgDurationMs: number;
}

/** A datum for the time distribution bar chart. */
export interface TimeChartDatum {
  label: string;
  count: number;
  bucketMs: number;
}

const MS_1H = 60 * 60 * 1000;
const MS_48H = 48 * MS_1H;
const MS_2W = 14 * 24 * MS_1H;

/** Duration of each granularity level in ms. */
const GRANULARITY_MS: Record<TimeGranularity, number> = {
  "1h": MS_1H,
  "4h": 4 * MS_1H,
  "day": 24 * MS_1H,
  "week": 7 * 24 * MS_1H,
  "month": 30 * 24 * MS_1H,
};

const MAX_BUCKETS = 500;

/**
 * Compute the number of histogram buckets for a given granularity and time range.
 * Floors the result, clamps to [1, 500].
 */
export function granularityToNumBuckets(granularity: TimeGranularity, rangeMs: number): number {
  const raw = Math.floor(rangeMs / GRANULARITY_MS[granularity]);
  return Math.max(1, Math.min(raw, MAX_BUCKETS));
}

/**
 * Format a timestamp label that adapts to the queried time range:
 * - ≤ 48h  → "HH:MM"
 * - ≤ 2w   → "MMM DD HH:MM"
 * - > 2w   → "MMM DD"
 */
export function formatAdaptiveTimeLabel(
  timestampMs: number,
  rangeMs: number,
  tzName?: string,
): string {
  const d = new Date(timestampMs);
  const tz = tzName ?? "UTC";

  try {
    if (rangeMs <= MS_48H) {
      return d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
      });
    }
    if (rangeMs <= MS_2W) {
      const month = d.toLocaleDateString("en-US", { month: "short", timeZone: tz });
      const day = d.toLocaleDateString("en-US", { day: "numeric", timeZone: tz });
      const time = d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
      });
      return `${month} ${day} ${time}`;
    }
    // > 2 weeks
    const month = d.toLocaleDateString("en-US", { month: "short", timeZone: tz });
    const day = d.toLocaleDateString("en-US", { day: "numeric", timeZone: tz });
    return `${month} ${day}`;
  } catch {
    // Fallback for invalid timezone
    const iso = d.toISOString();
    if (rangeMs <= MS_48H) return iso.slice(11, 16);
    if (rangeMs <= MS_2W) return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
    return iso.slice(5, 10);
  }
}

const BIN_SIZE_FT = 5000;
const NUM_BINS = 10;

/**
 * Build altitude histogram bins (10 bins of 5000ft each, 0–50000ft).
 * Returns all 10 bins, even if empty.
 */
export function buildAltitudeBins(summaries: AircraftSummary[]): AltitudeBin[] {
  const bins: AltitudeBin[] = [];
  for (let i = 0; i < NUM_BINS; i++) {
    const minAlt = i * BIN_SIZE_FT;
    const maxAlt = (i + 1) * BIN_SIZE_FT;
    bins.push({
      label: `${(minAlt / 1000).toFixed(0)}-${(maxAlt / 1000).toFixed(0)}k`,
      count: 0,
      minAlt,
      maxAlt,
    });
  }

  for (const s of summaries) {
    // Use max_altitude for binning (where the aircraft was flying)
    const alt = s.max_altitude;
    if (alt === null || alt === undefined) continue;
    const idx = Math.min(Math.floor(alt / BIN_SIZE_FT), NUM_BINS - 1);
    if (idx >= 0) bins[idx].count++;
  }

  return bins;
}

/**
 * Compute aggregate summary from a list of aircraft summaries.
 */
export function computeDbHistorySummary(summaries: AircraftSummary[]): DbHistorySummary {
  if (summaries.length === 0) {
    return { totalTracks: 0, totalPositions: 0, avgDurationMs: 0 };
  }

  let totalPositions = 0;
  let totalDuration = 0;
  for (const s of summaries) {
    totalPositions += s.position_count;
    totalDuration += s.last_seen_ms - s.first_seen_ms;
  }

  return {
    totalTracks: summaries.length,
    totalPositions,
    avgDurationMs: totalDuration / summaries.length,
  };
}

/**
 * Format time distribution buckets for the bar chart.
 * When rangeMs is provided, labels adapt to the time span; otherwise defaults to HH:MM.
 */
export function formatTimeChartData(
  buckets: TimeDistributionBucket[],
  tzName?: string,
  rangeMs?: number,
): TimeChartDatum[] {
  const effectiveRange = rangeMs ?? 0; // 0 → falls into ≤ 48h branch (HH:MM)
  return buckets.map((b) => ({
    label: formatAdaptiveTimeLabel(b.bucket_ms, effectiveRange, tzName),
    count: b.count,
    bucketMs: b.bucket_ms,
  }));
}
