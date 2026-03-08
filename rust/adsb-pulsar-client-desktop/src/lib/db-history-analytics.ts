import type { AircraftSummary, HourlyHeatmapCell, TimeDistributionBucket, TimeGranularity } from "./types";

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
  totalRawMessages: number;
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
 * @param rawMessageCount - total raw messages in the queried time range (from backend).
 */
export function computeDbHistorySummary(summaries: AircraftSummary[], rawMessageCount: number = 0): DbHistorySummary {
  if (summaries.length === 0) {
    return { totalTracks: 0, totalPositions: 0, totalRawMessages: rawMessageCount, avgDurationMs: 0 };
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
    totalRawMessages: rawMessageCount,
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

// --- Hourly heatmap grid ---

/** A single row in the heatmap grid (one calendar day, 24 hour values). */
export interface HeatmapRow {
  dayLabel: string;
  dayMs: number;
  /** Array of 24 values (index = hour 0–23), representing the selected metric. */
  hours: number[];
}

const MS_DAY = 24 * MS_1H;

/**
 * Build a 2D heatmap grid from sparse heatmap cells.
 *
 * Zero-fills all (day, hour) pairs within [startMs, endMs].
 * Rows are sorted most-recent-day first.
 *
 * @param metric — which field to use as the cell value: `"aircraft"` or `"messages"`.
 */
export function buildHeatmapGrid(
  cells: HourlyHeatmapCell[],
  startMs: number,
  endMs: number,
  metric: "aircraft" | "messages" = "aircraft",
  tzName?: string,
): HeatmapRow[] {
  if (startMs >= endMs) return [];

  // Round start down to midnight, end to midnight of the last day with potential data.
  // Subtract 1ms from endMs to avoid including an empty next-day row at exact midnight boundaries.
  const startDay = floorToDay(startMs);
  const endDay = floorToDay(Math.max(endMs - 1, startMs));

  // Build a map of day_ms → Map<hour, value> from sparse cells.
  const cellMap = new Map<number, Map<number, number>>();
  for (const c of cells) {
    let hourMap = cellMap.get(c.day_ms);
    if (!hourMap) {
      hourMap = new Map();
      cellMap.set(c.day_ms, hourMap);
    }
    hourMap.set(c.hour, metric === "aircraft" ? c.aircraft_count : c.message_count);
  }

  // Generate rows for each day in range, most recent first.
  const rows: HeatmapRow[] = [];
  for (let dayMs = endDay; dayMs >= startDay; dayMs -= MS_DAY) {
    const hourMap = cellMap.get(dayMs);
    const hours = new Array<number>(24);
    for (let h = 0; h < 24; h++) {
      hours[h] = hourMap?.get(h) ?? 0;
    }
    rows.push({
      dayLabel: formatDayLabel(dayMs, tzName),
      dayMs,
      hours,
    });
  }

  return rows;
}

/** Floor a timestamp to midnight UTC of that day. */
function floorToDay(ms: number): number {
  return Math.floor(ms / MS_DAY) * MS_DAY;
}

/** Format a midnight epoch ms to a short day label like "Mon 1/15". */
function formatDayLabel(dayMs: number, tzName?: string): string {
  const d = new Date(dayMs);
  const tz = tzName ?? "UTC";
  try {
    const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: tz });
    const month = d.toLocaleDateString("en-US", { month: "numeric", timeZone: tz });
    const day = d.toLocaleDateString("en-US", { day: "numeric", timeZone: tz });
    return `${weekday} ${month}/${day}`;
  } catch {
    // Fallback for invalid timezone
    const iso = d.toISOString();
    return iso.slice(5, 10);
  }
}
