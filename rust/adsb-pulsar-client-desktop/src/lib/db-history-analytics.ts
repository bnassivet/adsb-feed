import type { AircraftSummary, TimeDistributionBucket } from "./types";

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
 * Labels are formatted as HH:MM using the given timezone.
 */
export function formatTimeChartData(
  buckets: TimeDistributionBucket[],
  tzName?: string,
): TimeChartDatum[] {
  return buckets.map((b) => {
    const d = new Date(b.bucket_ms);
    let label: string;
    try {
      label = d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tzName ?? "UTC",
      });
    } catch {
      // Fallback for invalid timezone
      label = d.toISOString().slice(11, 16);
    }
    return { label, count: b.count, bucketMs: b.bucket_ms };
  });
}
