import type { AircraftSummary, FlightSummary, HeatmapMetric, HourlyHeatmapCell, MessageTypeBucket, TimeDistributionBucket, TimeGranularity } from "./types";

/** A single bin in an altitude histogram. */
export interface AltitudeBin {
  label: string;
  count: number;
  minAlt: number;
  maxAlt: number;
}

/** Summary statistics computed from aircraft and flight summaries. */
export interface DbHistorySummary {
  totalAircraft: number;
  totalFlights: number;
  totalPositions: number;
  totalRawMessages: number;
  avgFlightDurationMs: number;
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
 * Accepts any array of objects with a `max_altitude` field (AircraftSummary or FlightSummary).
 * Returns all 10 bins, even if empty.
 */
export function buildAltitudeBins(items: { max_altitude: number | null }[]): AltitudeBin[] {
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

  for (const s of items) {
    // Use max_altitude for binning (where the aircraft was flying)
    const alt = s.max_altitude;
    if (alt === null || alt === undefined) continue;
    const idx = Math.min(Math.floor(alt / BIN_SIZE_FT), NUM_BINS - 1);
    if (idx >= 0) bins[idx].count++;
  }

  return bins;
}

/**
 * Compute aggregate summary from aircraft summaries and flight summaries.
 * Avg duration is computed from flights (gap-segmented) rather than raw aircraft timespans.
 */
export function computeDbHistorySummary(
  summaries: AircraftSummary[],
  rawMessageCount: number = 0,
  flights: FlightSummary[] = [],
): DbHistorySummary {
  let totalPositions = 0;
  for (const s of summaries) {
    totalPositions += s.position_count;
  }

  let avgFlightDurationMs = 0;
  if (flights.length > 0) {
    let totalDuration = 0;
    for (const f of flights) {
      totalDuration += f.last_seen_ms - f.first_seen_ms;
    }
    avgFlightDurationMs = totalDuration / flights.length;
  }

  return {
    totalAircraft: summaries.length,
    totalFlights: flights.length,
    totalPositions,
    totalRawMessages: rawMessageCount,
    avgFlightDurationMs,
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
  metric: HeatmapMetric = "aircraft",
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
    const value = metric === "aircraft" ? c.aircraft_count : metric === "messages" ? c.message_count : metric === "flights" ? c.flight_count : c.raw_message_count;
    hourMap.set(c.hour, value);
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

/**
 * Build a lookup map from heatmap cells, keyed by `"${day_ms}-${hour}"`.
 * Used to quickly retrieve all metrics for a given cell in multi-metric tooltips.
 */
export function buildHeatmapCellLookup(cells: HourlyHeatmapCell[]): Map<string, HourlyHeatmapCell> {
  const map = new Map<string, HourlyHeatmapCell>();
  for (const c of cells) {
    map.set(`${c.day_ms}-${c.hour}`, c);
  }
  return map;
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

// --- Raw message types (SBS-1 transmission types) ---

export type MessageTypeKey = "t1" | "t2" | "t3" | "t4" | "t5" | "t6" | "t7" | "t8" | "other";

export interface MessageTypeInfo {
  key: MessageTypeKey;
  /** Short legend label. */
  label: string;
  /** Full description for tooltips. */
  description: string;
  color: string;
}

/**
 * SBS-1 transmission types in fixed order. Colors are the validated 8-slot
 * categorical palette (dark steps, checked against the slate-900 surface);
 * a type always keeps its color, whichever others are present. Anything
 * outside 1–8 folds into a neutral "Other" rather than a ninth hue.
 */
export const MESSAGE_TYPES: readonly MessageTypeInfo[] = [
  { key: "t1", label: "MSG1 ID", description: "MSG,1 — ES identification & category", color: "#3987e5" },
  { key: "t2", label: "MSG2 Surface", description: "MSG,2 — ES surface position", color: "#d95926" },
  { key: "t3", label: "MSG3 Position", description: "MSG,3 — ES airborne position", color: "#199e70" },
  { key: "t4", label: "MSG4 Velocity", description: "MSG,4 — ES airborne velocity", color: "#c98500" },
  { key: "t5", label: "MSG5 Altitude", description: "MSG,5 — surveillance altitude", color: "#d55181" },
  { key: "t6", label: "MSG6 Squawk", description: "MSG,6 — surveillance ID (squawk)", color: "#008300" },
  { key: "t7", label: "MSG7 Air-air", description: "MSG,7 — air-to-air", color: "#9085e9" },
  { key: "t8", label: "MSG8 All-call", description: "MSG,8 — all-call reply", color: "#e66767" },
  { key: "other", label: "Other", description: "Unknown or unparsed type", color: "#64748b" },
];

/** Map a transmission type to its series key; null / out-of-range → "other". */
export function messageTypeKey(type: number | null): MessageTypeKey {
  if (type != null && Number.isInteger(type) && type >= 1 && type <= 8) {
    return `t${type}` as MessageTypeKey;
  }
  return "other";
}

/** One stacked-histogram bar: per-type counts plus the bucket total. */
export type StackedTypeDatum = TimeChartDatum & Record<MessageTypeKey, number>;

function emptyTypeCounts(): Record<MessageTypeKey, number> {
  return { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0, t8: 0, other: 0 };
}

/**
 * Pivot long-format (bucket, type, count) rows into one zero-filled datum per
 * bucket, sorted by time. `count` is the bucket total, so the datum shape is a
 * superset of TimeChartDatum and drag-to-zoom works unchanged.
 */
export function buildStackedTypeData(
  rows: MessageTypeBucket[],
  tzName?: string,
  rangeMs?: number,
): StackedTypeDatum[] {
  const byBucket = new Map<number, StackedTypeDatum>();
  for (const r of rows) {
    let d = byBucket.get(r.bucket_ms);
    if (!d) {
      d = {
        label: formatAdaptiveTimeLabel(r.bucket_ms, rangeMs ?? 0, tzName),
        bucketMs: r.bucket_ms,
        count: 0,
        ...emptyTypeCounts(),
      };
      byBucket.set(r.bucket_ms, d);
    }
    d[messageTypeKey(r.transmission_type)] += r.count;
    d.count += r.count;
  }
  return [...byBucket.values()].sort((a, b) => a.bucketMs - b.bucketMs);
}

export interface MessageTypeTotal extends MessageTypeInfo {
  count: number;
  /** Share of all raw messages in the range, 0–100. */
  pct: number;
}

/** Total raw messages per type over the whole range, fixed order, zero types dropped. */
export function buildMessageTypeTotals(rows: MessageTypeBucket[]): MessageTypeTotal[] {
  const counts = emptyTypeCounts();
  let total = 0;
  for (const r of rows) {
    counts[messageTypeKey(r.transmission_type)] += r.count;
    total += r.count;
  }
  if (total === 0) return [];
  return MESSAGE_TYPES.filter((t) => counts[t.key] > 0).map((t) => ({
    ...t,
    count: counts[t.key],
    pct: (counts[t.key] / total) * 100,
  }));
}

export interface PieSlice extends MessageTypeTotal {
  /** Radians, clockwise from 12 o'clock. */
  startAngle: number;
  endAngle: number;
  /** Bisector of the slice, for nudging it outward on hover. */
  midAngle: number;
  /** SVG path: a wedge, or a ring segment when an inner radius is given. Unused when `fullCircle`. */
  path: string;
  /** A single 100% slice: an SVG arc cannot start and end at one point, so draw a circle / ring instead. */
  fullCircle: boolean;
}

/** Round to 2 decimals for compact, stable SVG path strings. */
function svgNum(n: number): number {
  return +n.toFixed(2);
}

/**
 * Lay out slices for the given totals, clockwise from 12 o'clock, in their given order.
 * `innerR > 0` makes a donut: each slice is a ring segment (outer arc clockwise,
 * inner arc back counter-clockwise).
 */
export function buildPieSlices(
  totals: MessageTypeTotal[],
  cx: number,
  cy: number,
  r: number,
  innerR: number = 0,
): PieSlice[] {
  const sum = totals.reduce((s, t) => s + t.count, 0);
  if (sum === 0) return [];
  const point = (a: number, rad: number) => `${svgNum(cx + rad * Math.sin(a))} ${svgNum(cy - rad * Math.cos(a))}`;
  let angle = 0;
  return totals.map((t) => {
    const startAngle = angle;
    const endAngle = angle + (t.count / sum) * 2 * Math.PI;
    angle = endAngle;
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const path =
      innerR > 0
        ? `M ${point(startAngle, r)} A ${r} ${r} 0 ${largeArc} 1 ${point(endAngle, r)} ` +
          `L ${point(endAngle, innerR)} A ${innerR} ${innerR} 0 ${largeArc} 0 ${point(startAngle, innerR)} Z`
        : `M ${svgNum(cx)} ${svgNum(cy)} L ${point(startAngle, r)} A ${r} ${r} 0 ${largeArc} 1 ${point(endAngle, r)} Z`;
    return {
      ...t,
      startAngle,
      endAngle,
      midAngle: (startAngle + endAngle) / 2,
      path,
      fullCircle: t.count === sum,
    };
  });
}

// --- Type filter (one selection, shared by the stacked histogram and Message Types) ---

/** Types present minus hidden ones. Never empty: if everything present is hidden, all are shown. */
export function visibleTypes<T extends { key: MessageTypeKey }>(present: readonly T[], hidden: readonly MessageTypeKey[]): T[] {
  const shown = present.filter((t) => !hidden.includes(t.key));
  return shown.length > 0 ? shown : [...present];
}

/** Click: hide or re-show `key`. Refuses to hide the last visible type, so a chart is never empty. */
export function toggleHiddenType(
  hidden: readonly MessageTypeKey[],
  key: MessageTypeKey,
  present: readonly { key: MessageTypeKey }[],
): MessageTypeKey[] {
  if (hidden.includes(key)) return hidden.filter((k) => k !== key);
  const visible = visibleTypes(present, hidden);
  const isVisible = visible.some((t) => t.key === key);
  return isVisible && visible.length <= 1 ? [...hidden] : [...hidden, key];
}

/** Double-click: with every present type on, show only `key`; otherwise show all. */
export function toggleAllHiddenTypes(
  hidden: readonly MessageTypeKey[],
  key: MessageTypeKey,
  present: readonly { key: MessageTypeKey }[],
): MessageTypeKey[] {
  const allOn = present.every((t) => !hidden.includes(t.key));
  return allOn ? MESSAGE_TYPES.filter((t) => t.key !== key).map((t) => t.key) : [];
}

/** Recompute each type's share over the given (visible) types, so shares sum to 100%. */
export function rebaseShares(totals: readonly MessageTypeTotal[]): MessageTypeTotal[] {
  const sum = totals.reduce((s, t) => s + t.count, 0);
  return totals.map((t) => ({ ...t, pct: sum > 0 ? (t.count / sum) * 100 : 0 }));
}
