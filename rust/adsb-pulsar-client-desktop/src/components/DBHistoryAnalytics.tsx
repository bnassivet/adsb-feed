"use client";
import React, { useCallback, useId, useMemo, useState } from "react";
import { BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea } from "recharts";
import {
  BAR_RADIUS,
  CHART_SURFACE,
  GLASS_FILL_OPACITY,
  GLASS_STACK_OPACITY,
  GRID_DASH,
  GRID_STROKE,
  frostedTooltipStyle,
  roundedTopRectPath,
  softCursor,
  topEdgePath,
} from "@/lib/chart-style";
import type { DetectionRangeSector, FlightSummary, HeatmapMetric, HourlyHeatmapCell, MessageTypeBucket, TimeDistributionBucket, TimeDistributionMetric, TimeGranularity } from "@/lib/types";
import type { RadarMode } from "@/lib/detection-radar";
import {
  buildAltitudeBins,
  buildHeatmapGrid,
  buildHeatmapCellLookup,
  buildMessageTypeTotals,
  buildPieSlices,
  buildStackedTypeData,
  rebaseShares,
  toggleAllHiddenTypes,
  toggleHiddenType,
  visibleTypes as filterVisibleTypes,
  computeDbHistorySummary,
  formatTimeChartData,
  formatAdaptiveTimeLabel,
} from "@/lib/db-history-analytics";
import type { MessageTypeInfo, MessageTypeKey, MessageTypeTotal, StackedTypeDatum } from "@/lib/db-history-analytics";
import type { AircraftSummary } from "@/lib/types";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { DetectionRadar } from "./DetectionRadar";

type AltitudeMode = "aircraft" | "flights";

interface Props {
  summaries: AircraftSummary[];
  timeBuckets: TimeDistributionBucket[];
  tzName?: string;
  detectionSectors?: DetectionRangeSector[];
  /** Duration of the queried time range in ms (for adaptive label formatting). */
  rangeMs?: number;
  /** Called when user drag-selects a region on the time chart. */
  onZoom?: (startMs: number, endMs: number) => void;
  /** Current time granularity for the histogram. */
  granularity?: TimeGranularity;
  /** Called when user selects a different granularity. */
  onGranularityChange?: (g: TimeGranularity) => void;
  /** Heatmap cells from the backend query. */
  heatmapCells?: HourlyHeatmapCell[];
  /** Start of the queried time range (ms). */
  startMs?: number;
  /** End of the queried time range (ms). */
  endMs?: number;
  /** Total raw messages in the queried time range. */
  rawMessageCount?: number;
  /** Current metric for the time distribution chart. */
  timeMetric?: TimeDistributionMetric;
  /** Called when user selects a different time distribution metric. */
  onTimeMetricChange?: (m: TimeDistributionMetric) => void;
  /** Flight summaries for flight-level analytics. */
  flightSummaries?: FlightSummary[];
  /** Raw-message counts per (bucket, transmission type), same bucketing as `timeBuckets`. */
  messageTypeBuckets?: MessageTypeBucket[];
}

// --- Glass bar styling (shared by the bar charts) ---

interface GlassBarOptions {
  color: string;
  /** Fill override, e.g. a gradient `url(#id)`; defaults to `color`. */
  fill?: string;
  fillOpacity?: number;
  /** Top-corner radius; 0 for stacked segments under the top one. */
  radius?: number;
  /** Pixels trimmed off the bottom: the surface gap between stacked segments. */
  gap?: number;
  opacity?: number;
}

/**
 * Recharts `shape` for a translucent bar with a solid top edge. The edge keeps
 * the series colour at full strength, so identity survives the transparency.
 */
function glassBar({ color, fill, fillOpacity = GLASS_FILL_OPACITY, radius = BAR_RADIUS, gap = 0, opacity = 1 }: GlassBarOptions) {
  // A render function, not a component: Recharts calls it per bar.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function renderGlassBar(props: any) {
    const { x, y, width } = props as { x: number; y: number; width: number };
    const height = (props.height as number) - gap;
    const d = roundedTopRectPath(x, y, width, height, radius);
    if (!d) return null;
    return (
      <g opacity={opacity} style={{ transition: "opacity 150ms" }}>
        <path d={d} fill={fill ?? color} fillOpacity={fillOpacity} />
        <path d={topEdgePath(x, y, width, height, radius)} fill="none" stroke={color} strokeWidth={1.25} />
      </g>
    );
  };
}

/** SVG-safe id for gradient defs (React ids contain characters `url(#…)` dislikes). */
function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** Vertical fade: strong at the bar top, faint at the baseline. */
function FadeGradient({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={0.85} />
        <stop offset="100%" stopColor={color} stopOpacity={0.2} />
      </linearGradient>
    </defs>
  );
}

const AXIS_TICK = { fill: "#64748b", fontSize: 9 };

/** Stable fallback so the memos below don't recompute every render. */
const NO_TYPE_ROWS: MessageTypeBucket[] = [];

const GRANULARITIES: { value: TimeGranularity; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export function DBHistoryAnalytics({ summaries, timeBuckets, tzName, detectionSectors, rangeMs, onZoom, granularity, onGranularityChange, heatmapCells, startMs, endMs, rawMessageCount, timeMetric, onTimeMetricChange, flightSummaries, messageTypeBuckets }: Props) {
  const summary = useMemo(() => computeDbHistorySummary(summaries, rawMessageCount ?? 0, flightSummaries ?? []), [summaries, rawMessageCount, flightSummaries]);
  const [altMode, setAltMode] = useState<AltitudeMode>("aircraft");
  const altFadeId = useSvgId("alt-fade");
  const altBins = useMemo(
    () => buildAltitudeBins(altMode === "flights" && flightSummaries ? flightSummaries : summaries),
    [summaries, flightSummaries, altMode],
  );
  const timeData = useMemo(() => formatTimeChartData(timeBuckets, tzName, rangeMs), [timeBuckets, tzName, rangeMs]);
  const hasAltData = altBins.some((b) => b.count > 0);
  const typeRows = messageTypeBuckets ?? NO_TYPE_ROWS;
  const stackedData = useMemo(() => buildStackedTypeData(typeRows, tzName, rangeMs), [typeRows, tzName, rangeMs]);
  const typeTotals = useMemo(() => buildMessageTypeTotals(typeRows), [typeRows]);
  // One MSG-type filter, shared by the stacked histogram and Message Types.
  const [hiddenTypes, setHiddenTypes] = useLocalStorage<MessageTypeKey[]>("adsb-dbhist-hidden-types", []);
  const shownTypes = filterVisibleTypes(typeTotals, hiddenTypes);
  const typeFilter: TypeFilter = {
    present: typeTotals,
    visible: shownTypes,
    onToggle: (key) => setHiddenTypes(toggleHiddenType(hiddenTypes, key, typeTotals)),
    onToggleAll: (key) => setHiddenTypes(toggleAllHiddenTypes(hiddenTypes, key, typeTotals)),
  };

  function formatDuration(ms: number): string {
    if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  const tickFormatter = useCallback(
    (value: number) => formatAdaptiveTimeLabel(value, rangeMs ?? 0, tzName),
    [rangeMs, tzName],
  );

  return (
    <details className="border-t border-slate-800 mt-1" data-testid="dbhist-analytics">
      <summary className="flex items-center gap-1.5 cursor-pointer select-none px-3 py-1.5 text-xs font-semibold text-slate-400 list-none [&::-webkit-details-marker]:hidden">
        <span className="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
        Analytics
      </summary>
      <div className="px-3 pb-2 space-y-3">
        {/* Summary stats */}
        <div className="flex gap-3 text-xs">
          <div className="flex-1 bg-slate-800/50 rounded px-2 py-1.5">
            <div className="text-[10px] text-slate-500 uppercase">Aircraft</div>
            <div className="text-cyan-300 font-mono font-semibold">{summary.totalAircraft}</div>
          </div>
          <div className="flex-1 bg-slate-800/50 rounded px-2 py-1.5">
            <div className="text-[10px] text-slate-500 uppercase">Flights</div>
            <div className="text-cyan-300 font-mono font-semibold">{summary.totalFlights}</div>
          </div>
          <div className="flex-1 bg-slate-800/50 rounded px-2 py-1.5">
            <div className="text-[10px] text-slate-500 uppercase">Positions</div>
            <div className="text-cyan-300 font-mono font-semibold">{summary.totalPositions.toLocaleString()}</div>
          </div>
          <div className="flex-1 bg-slate-800/50 rounded px-2 py-1.5">
            <div className="text-[10px] text-slate-500 uppercase">Raw Msgs</div>
            <div className="text-cyan-300 font-mono font-semibold">{summary.totalRawMessages.toLocaleString()}</div>
          </div>
          <div className="flex-1 bg-slate-800/50 rounded px-2 py-1.5">
            <div className="text-[10px] text-slate-500 uppercase">Avg Duration</div>
            <div className="text-cyan-300 font-mono font-semibold">{formatDuration(summary.avgFlightDurationMs)}</div>
          </div>
        </div>

        {/* Time distribution chart */}
        {timeData.length > 0 && (
          <TimeDistributionChart
            timeData={timeData}
            tickFormatter={tickFormatter}
            onZoom={onZoom}
            granularity={granularity}
            onGranularityChange={onGranularityChange}
            metric={timeMetric}
            onMetricChange={onTimeMetricChange}
            stackedData={timeMetric === "raw_messages" ? stackedData : []}
            typeFilter={typeFilter}
          />
        )}

        {/* Raw message type distribution */}
        {typeTotals.length > 0 && <MessageTypeDistribution filter={typeFilter} />}

        {/* Activity heatmap */}
        {heatmapCells && heatmapCells.length > 0 && startMs != null && endMs != null && (
          <ActivityHeatmap cells={heatmapCells} startMs={startMs} endMs={endMs} tzName={tzName} />
        )}

        {/* Altitude histogram */}
        {hasAltData && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] text-slate-500 uppercase">Altitude Distribution</div>
              {flightSummaries && flightSummaries.length > 0 && (
                <div className="flex gap-0.5" data-testid="altitude-mode-toggle">
                  {(["aircraft", "flights"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setAltMode(m)}
                      data-testid={`altitude-mode-${m}`}
                      className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                        altMode === m
                          ? "bg-cyan-900/60 text-cyan-300"
                          : "text-slate-500 hover:text-slate-400"
                      }`}
                    >
                      {m === "aircraft" ? "Aircraft" : "Flights"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={altBins} margin={{ top: 4, right: 4, bottom: 0, left: -20 }} barCategoryGap="18%">
                <FadeGradient id={altFadeId} color="#818cf8" />
                <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray={GRID_DASH} />
                <XAxis
                  dataKey="label"
                  tick={AXIS_TICK}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  interval={1}
                />
                <YAxis
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={softCursor}
                  contentStyle={frostedTooltipStyle}
                  labelStyle={{ color: "#94a3b8" }}
                  itemStyle={{ color: "#a5b4fc" }}
                  formatter={(value: number | undefined) => [`${value ?? 0} ${altMode === "flights" ? "flights" : "aircraft"}`, "Count"]}
                  labelFormatter={(label: unknown) => `${String(label)} ft`}
                />
                <Bar dataKey="count" fill="#818cf8" shape={glassBar({ color: "#818cf8", fill: `url(#${altFadeId})`, fillOpacity: 1 })} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Detection range radar */}
        {detectionSectors && detectionSectors.some((s) => s.position_count > 0) && (
          <DetectionRangeSection sectors={detectionSectors} />
        )}
      </div>
    </details>
  );
}

// --- Time distribution chart with drag-to-zoom ---

const TIME_METRICS: { value: TimeDistributionMetric; label: string }[] = [
  { value: "aircraft", label: "Aircraft" },
  { value: "flights", label: "Flights" },
  { value: "positions", label: "Messages" },
  { value: "raw_messages", label: "Raw Msgs" },
];

interface TimeChartProps {
  timeData: { label: string; count: number; bucketMs: number }[];
  tickFormatter: (value: number) => string;
  onZoom?: (startMs: number, endMs: number) => void;
  granularity?: TimeGranularity;
  onGranularityChange?: (g: TimeGranularity) => void;
  metric?: TimeDistributionMetric;
  onMetricChange?: (m: TimeDistributionMetric) => void;
  /** Per-type breakdown of the same buckets; non-empty only for the Raw Msgs metric. */
  stackedData?: StackedTypeDatum[];
  /** Types present in the range, in fixed order (drives stack order and legend). */
  /** The shared MSG-type filter (present types, visible types, toggles). */
  typeFilter?: TypeFilter;
}

function TimeDistributionChart({ timeData, tickFormatter, onZoom, granularity, onGranularityChange, metric, onMetricChange, stackedData = [], typeFilter }: TimeChartProps) {
  const [refAreaLeft, setRefAreaLeft] = useState<number | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<number | null>(null);
  const [stackPref, setStackPref] = useLocalStorage<boolean>("adsb-dbhist-raw-by-type", true);
  const presentTypes = typeFilter?.present ?? [];
  const visibleTypes = typeFilter?.visible ?? [];
  const canStack = stackedData.length > 0 && presentTypes.length > 0;
  const stacked = canStack && stackPref;
  // Stacked rows carry bucketMs/count too, so zoom and the X axis work on either.
  const chartData: { bucketMs: number; count: number }[] = stacked ? stackedData : timeData;
  const fadeId = useSvgId("time-fade");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMouseDown(e: any) {
    if (!onZoom || !e?.activePayload?.[0]) return;
    setRefAreaLeft(e.activePayload[0].payload.bucketMs);
    setRefAreaRight(null);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleMouseMove(e: any) {
    if (!onZoom || refAreaLeft === null || !e?.activePayload?.[0]) return;
    setRefAreaRight(e.activePayload[0].payload.bucketMs);
  }

  function handleMouseUp() {
    if (!onZoom || refAreaLeft === null || refAreaRight === null) {
      setRefAreaLeft(null);
      setRefAreaRight(null);
      return;
    }
    const left = Math.min(refAreaLeft, refAreaRight);
    const right = Math.max(refAreaLeft, refAreaRight);
    setRefAreaLeft(null);
    setRefAreaRight(null);
    if (left !== right) {
      onZoom(left, right);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] text-slate-500 uppercase">Time Distribution</div>
        {onMetricChange && metric && (
          <div className="flex gap-0.5" data-testid="dbhist-metric-toggle">
            {TIME_METRICS.map((m) => (
              <button
                key={m.value}
                onClick={() => onMetricChange(m.value)}
                data-testid={`dbhist-metric-${m.value}`}
                className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                  metric === m.value
                    ? "bg-cyan-900/60 text-cyan-300"
                    : "text-slate-500 hover:text-slate-400"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        {onZoom && !onGranularityChange && !onMetricChange && (
          <div className="text-[9px] text-slate-600 italic">Drag to zoom</div>
        )}
      </div>
      {onGranularityChange && granularity && (
        <div className="flex items-center gap-1 mb-1" data-testid="dbhist-granularity">
          <span className="text-[9px] text-slate-600">Bucket:</span>
          <div className="flex gap-0.5">
            {GRANULARITIES.map((g) => (
              <button
                key={g.value}
                onClick={() => onGranularityChange(g.value)}
                data-testid={`dbhist-gran-${g.value}`}
                className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                  granularity === g.value
                    ? "bg-cyan-900/60 text-cyan-300"
                    : "text-slate-500 hover:text-slate-400"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {canStack && (
        <div className="flex items-start gap-2 mb-1">
          <button
            onClick={() => setStackPref(!stackPref)}
            data-testid="dbhist-stack-toggle"
            aria-pressed={stacked}
            title="Stack raw messages by SBS-1 transmission type"
            className={`shrink-0 px-1.5 py-0.5 text-[9px] rounded transition-colors ${
              stacked ? "bg-cyan-900/60 text-cyan-300" : "text-slate-500 hover:text-slate-400"
            }`}
          >
            By type
          </button>
          {stacked && (
            <TypeLegend
              types={presentTypes}
              visible={visibleTypes}
              onToggle={typeFilter!.onToggle}
              onToggleAll={typeFilter!.onToggleAll}
              testIdPrefix="dbhist-type-legend"
            />
          )}
        </div>
      )}
      <ResponsiveContainer width="100%" height={120}>
        <BarChart
          data={chartData}
          margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <FadeGradient id={fadeId} color="#06b6d4" />
          <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray={GRID_DASH} />
          <XAxis
            dataKey="bucketMs"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={tickFormatter}
            tick={AXIS_TICK}
            axisLine={{ stroke: "#334155" }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
          />
          {stacked ? (
            <Tooltip
              cursor={softCursor}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              content={(p: any) => <StackedTypeTooltip {...p} types={visibleTypes} tickFormatter={tickFormatter} />}
            />
          ) : (
            <Tooltip
              cursor={softCursor}
              contentStyle={frostedTooltipStyle}
              labelStyle={{ color: "#94a3b8" }}
              itemStyle={{ color: "#22d3ee" }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              labelFormatter={(value: any) => tickFormatter(Number(value))}
            />
          )}
          {stacked ? (
            visibleTypes.map((t, i) => (
              <Bar
                key={t.key}
                dataKey={t.key}
                name={t.label}
                stackId="type"
                fill={t.color}
                shape={glassBar({
                  color: t.color,
                  fillOpacity: GLASS_STACK_OPACITY,
                  // Only the top segment of the stack gets rounded corners.
                  radius: i === visibleTypes.length - 1 ? BAR_RADIUS : 0,
                  // 1px surface gap between segments (not under the bottom one).
                  gap: i > 0 ? 1 : 0,
                })}
                // Off: the stack is re-laid-out on every filter click, and a filter should be instant.
                isAnimationActive={false}
              />
            ))
          ) : (
            <Bar dataKey="count" fill="#06b6d4" shape={glassBar({ color: "#06b6d4", fill: `url(#${fadeId})`, fillOpacity: 1 })} />
          )}
          {refAreaLeft !== null && refAreaRight !== null && (
            <ReferenceArea
              x1={refAreaLeft}
              x2={refAreaRight}
              fill="#06b6d4"
              fillOpacity={0.2}
              stroke="#06b6d4"
              strokeOpacity={0.5}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// --- Raw message types ---

/** The shared MSG-type filter, owned by DBHistoryAnalytics. */
interface TypeFilter {
  /** Types with messages in the range, fixed order. */
  present: MessageTypeTotal[];
  /** Present minus hidden; never empty. */
  visible: MessageTypeTotal[];
  onToggle: (key: MessageTypeKey) => void;
  onToggleAll: (key: MessageTypeKey) => void;
}

/** Legend whose entries filter the stack: click toggles a type, double-click isolates / shows all. No hover effects. */
function TypeLegend({
  types,
  visible,
  onToggle,
  onToggleAll,
  testIdPrefix,
}: {
  /** Distinguishes the two places the filter appears, e.g. "msgtype-filter". */
  testIdPrefix: string;
  types: MessageTypeInfo[];
  visible: MessageTypeInfo[];
  onToggle: (key: MessageTypeKey) => void;
  onToggleAll: (key: MessageTypeKey) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-x-1 gap-y-0.5" data-testid={testIdPrefix}>
      {types.map((t) => {
        const on = visible.some((v) => v.key === t.key);
        return (
          <li key={t.key}>
            <button
              type="button"
              onClick={() => onToggle(t.key)}
              onDoubleClick={() => onToggleAll(t.key)}
              data-testid={`${testIdPrefix}-${t.key}`}
              aria-pressed={on}
              title={`${t.description} — click to ${on ? "hide" : "show"}, double-click to ${
                visible.length === types.length ? "show only this type" : "show all"
              }`}
              className={`flex items-center gap-1 px-1 rounded text-[9px] select-none transition-colors hover:bg-slate-800 ${
                on ? "text-slate-300" : "text-slate-600 line-through"
              }`}
            >
              <span
                className="inline-block w-2 h-2 rounded-[2px]"
                style={on ? { backgroundColor: t.color } : { boxShadow: `inset 0 0 0 1px ${t.color}` }}
              />
              {t.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface StackedTooltipProps {
  active?: boolean;
  payload?: { payload: StackedTypeDatum }[];
  types: MessageTypeInfo[];
  tickFormatter: (value: number) => string;
}

/** Lists only the non-zero types of the hovered bucket, top of the stack first, plus the total. */
function StackedTypeTooltip({ active, payload, types, tickFormatter }: StackedTooltipProps) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  const rows = types.filter((t) => d[t.key] > 0).reverse();
  // `types` is the visible set, so the total matches the drawn bar; say so when types are hidden.
  const shown = types.reduce((sum, t) => sum + d[t.key], 0);
  return (
    <div className="rounded-md border border-slate-400/25 bg-slate-900/70 backdrop-blur-md px-2 py-1 text-[11px] shadow-lg shadow-black/30">
      <div className="text-slate-400 mb-0.5">{tickFormatter(d.bucketMs)}</div>
      {rows.map((t) => (
        <div key={t.key} className="flex items-center gap-1.5 text-slate-300">
          <span className="inline-block w-2 h-2 rounded-[2px]" style={{ backgroundColor: t.color }} />
          <span className="flex-1">{t.label}</span>
          <span className="font-mono">{d[t.key].toLocaleString()}</span>
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t border-slate-600/50 mt-0.5 pt-0.5 text-slate-200">
        <span>Total</span>
        <span className="font-mono">
          {shown.toLocaleString()}
          {shown !== d.count && <span className="text-slate-500"> of {d.count.toLocaleString()}</span>}
        </span>
      </div>
    </div>
  );
}

const PIE_SIZE = 120;
const PIE_R = 57.5;
/** Donut hole: ~60% of the radius leaves room for the centre readout. */
const PIE_INNER_R = 35;
/** How far a hovered slice lifts out along its bisector, in px. */
const PIE_LIFT = 3;

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function typeTitle(t: MessageTypeTotal): string {
  return `${t.description}\n${t.count.toLocaleString()} messages (${t.pct.toFixed(1)}%)`;
}

/** Small pressed/unpressed switch, styled like the other analytics toggles. */
function ToggleChip({ on, onClick, testId, title, children }: {
  on: boolean;
  onClick: () => void;
  testId: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={on}
      title={title}
      className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
        on ? "bg-cyan-900/60 text-cyan-300" : "text-slate-500 hover:text-slate-400"
      }`}
    >
      {children}
    </button>
  );
}

/** Count and/or percentage cells, each optional. */
function TypeValues({ t, showCount, showPct }: { t: MessageTypeTotal; showCount: boolean; showPct: boolean }) {
  return (
    <>
      {showCount && <span className="text-slate-300 font-mono text-right">{t.count.toLocaleString()}</span>}
      {showPct && <span className="text-slate-500 font-mono text-right">{`${t.pct.toFixed(1)}%`}</span>}
    </>
  );
}

/**
 * Each type's share of all raw messages in the range, as direct-labeled bars or
 * a pie with a key. Counts and percentages can each be switched off.
 */
function MessageTypeDistribution({ filter }: { filter: TypeFilter }) {
  // Shares are over the visible types, so the donut still sums to 100%.
  const totals = useMemo(() => rebaseShares(filter.visible), [filter.visible]);
  const [showBars, setShowBars] = useLocalStorage<boolean>("adsb-dbhist-msgtype-show-bars", true);
  const [showPie, setShowPie] = useLocalStorage<boolean>("adsb-dbhist-msgtype-show-pie", false);
  // Independent displays, but never neither: the last one on refuses to switch off.
  const toggleBars = () => { if (!showBars || showPie) setShowBars(!showBars); };
  const togglePie = () => { if (!showPie || showBars) setShowPie(!showPie); };
  const [showCount, setShowCount] = useLocalStorage<boolean>("adsb-dbhist-msgtype-show-count", true);
  const [showPct, setShowPct] = useLocalStorage<boolean>("adsb-dbhist-msgtype-show-pct", true);
  const [hovered, setHovered] = useState<MessageTypeKey | null>(null);

  const valueCols = `${showCount ? " auto" : ""}${showPct ? " 40px" : ""}`;
  const total = totals.reduce((sum, t) => sum + t.count, 0);
  const hoveredTotal = totals.find((t) => t.key === hovered) ?? null;
  const c = PIE_SIZE / 2;

  return (
    <div data-testid="msgtype-distribution">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] text-slate-500 uppercase">Message Types</div>
        <div className="flex items-center gap-1.5">
          <div className="flex gap-0.5">
            <ToggleChip on={showBars} onClick={toggleBars} testId="msgtype-show-bars" title="Show bars">
              Bars
            </ToggleChip>
            <ToggleChip on={showPie} onClick={togglePie} testId="msgtype-show-pie" title="Show pie chart">
              Pie
            </ToggleChip>
          </div>
          <div className="flex gap-0.5">
            <ToggleChip on={showCount} onClick={() => setShowCount(!showCount)} testId="msgtype-show-count" title="Show message counts">
              #
            </ToggleChip>
            <ToggleChip on={showPct} onClick={() => setShowPct(!showPct)} testId="msgtype-show-pct" title="Show percentages">
              %
            </ToggleChip>
          </div>
        </div>
      </div>

      <div className="mb-1.5">
        <TypeLegend
          types={filter.present}
          visible={filter.visible}
          onToggle={filter.onToggle}
          onToggleAll={filter.onToggleAll}
          testIdPrefix="msgtype-filter"
        />
      </div>

      {showBars && (
        <MessageTypeBars
          totals={totals}
          showCount={showCount}
          showPct={showPct}
          valueCols={valueCols}
          onHover={setHovered}
        />
      )}
      {showPie && (
        <div className={`flex items-center gap-3 ${showBars ? "mt-2" : ""}`}>
          <svg
            width={PIE_SIZE}
            height={PIE_SIZE}
            viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}
            className="shrink-0"
            data-testid="msgtype-pie"
            role="img"
            aria-label="Message type distribution"
            onMouseLeave={() => setHovered(null)}
          >
            {buildPieSlices(totals, c, c, PIE_R, PIE_INNER_R).map((s) => {
              const lifted = hovered === s.key && !s.fullCircle;
              const common = {
                // Translucent fill; the surface-coloured stroke is the gap between slices.
                fillOpacity: 0.85,
                stroke: CHART_SURFACE,
                strokeWidth: 1.5,
                transform: lifted
                  ? `translate(${PIE_LIFT * Math.sin(s.midAngle)} ${-PIE_LIFT * Math.cos(s.midAngle)})`
                  : undefined,
                style: { transition: "transform 150ms" },
                className: "cursor-default",
                "data-testid": `msgtype-slice-${s.key}`,
                onMouseEnter: () => setHovered(s.key),
              };
              return s.fullCircle ? (
                // A lone 100% type: a ring drawn as a thick stroke on a circle.
                <circle
                  key={s.key}
                  cx={c}
                  cy={c}
                  r={(PIE_R + PIE_INNER_R) / 2}
                  fill="none"
                  {...common}
                  stroke={s.color}
                  strokeOpacity={0.85}
                  strokeWidth={PIE_R - PIE_INNER_R}
                >
                  <title>{typeTitle(s)}</title>
                </circle>
              ) : (
                <path key={s.key} d={s.path} fill={s.color} {...common}>
                  <title>{typeTitle(s)}</title>
                </path>
              );
            })}
            <g data-testid="msgtype-donut-center" pointerEvents="none" textAnchor="middle">
              {hoveredTotal ? (
                <>
                  <text x={c} y={c - 1} fill="#e2e8f0" fontSize={15} fontWeight={600} fontFamily="ui-monospace, monospace">
                    {showPct || !showCount ? `${hoveredTotal.pct.toFixed(1)}%` : compactNumber.format(hoveredTotal.count)}
                  </text>
                  <text x={c} y={c + 12} fill="#94a3b8" fontSize={10}>
                    {hoveredTotal.label.split(" ")[0]}
                  </text>
                </>
              ) : (
                <>
                  <text x={c} y={c - 1} fill="#e2e8f0" fontSize={15} fontWeight={600} fontFamily="ui-monospace, monospace">
                    {compactNumber.format(total)}
                  </text>
                  <text x={c} y={c + 12} fill="#94a3b8" fontSize={10}>
                    msgs
                  </text>
                </>
              )}
            </g>
          </svg>
          <ul className="flex-1 min-w-0 space-y-0.5" data-testid="msgtype-pie-key" onMouseLeave={() => setHovered(null)}>
            {totals.map((t) => (
              <li
                key={t.key}
                className="grid items-center gap-1.5 text-[9px] rounded hover:bg-slate-800/60 transition-opacity"
                style={{ gridTemplateColumns: `8px 1fr${valueCols}` }}
                title={typeTitle(t)}
                onMouseEnter={() => setHovered(t.key)}
              >
                <span className="w-2 h-2 rounded-[2px]" style={{ backgroundColor: t.color }} />
                <span className="text-slate-400 truncate">{t.label}</span>
                <TypeValues t={t} showCount={showCount} showPct={showPct} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Horizontal glass bars scaled to the largest type. Direct-labeled, so no legend. */
function MessageTypeBars({ totals, showCount, showPct, valueCols, onHover }: {
  totals: MessageTypeTotal[];
  showCount: boolean;
  showPct: boolean;
  valueCols: string;
  /** Drives the donut's centre readout; no dimming (the filter row is the selection tool). */
  onHover: (key: MessageTypeKey | null) => void;
}) {
  const max = Math.max(...totals.map((t) => t.count));
  return (
    <ul className="space-y-0.5" onMouseLeave={() => onHover(null)}>
      {totals.map((t) => (
        <li
          key={t.key}
          data-testid={`msgtype-row-${t.key}`}
          className="grid items-center gap-1.5 text-[9px] rounded hover:bg-slate-800/60"
          style={{ gridTemplateColumns: `84px 1fr${valueCols}` }}
          title={typeTitle(t)}
          onMouseEnter={() => onHover(t.key)}
        >
          <span className="text-slate-400 truncate">{t.label}</span>
          <span className="h-2 rounded-r bg-slate-800/40 overflow-hidden">
            <span
              className="block h-full rounded-r"
              style={{
                width: `${(t.count / max) * 100}%`,
                // Translucent fill with a solid leading edge, like the column charts.
                backgroundColor: `color-mix(in srgb, ${t.color} ${GLASS_FILL_OPACITY * 100}%, transparent)`,
                boxShadow: `inset -2px 0 0 ${t.color}`,
              }}
            />
          </span>
          <TypeValues t={t} showCount={showCount} showPct={showPct} />
        </li>
      ))}
    </ul>
  );
}

// --- Detection range section ---

const RADAR_MODES: { value: RadarMode; label: string }[] = [
  { value: "polar", label: "Polar" },
  { value: "polygon", label: "Polygon" },
];

function DetectionRangeSection({ sectors }: { sectors: DetectionRangeSector[] }) {
  const [mode, setMode] = useState<RadarMode>("polar");

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] text-slate-500 uppercase">Detection Range</div>
        <div className="flex gap-0.5" data-testid="radar-mode-toggle">
          {RADAR_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                mode === m.value
                  ? "bg-cyan-900/60 text-cyan-300"
                  : "text-slate-500 hover:text-slate-400"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <DetectionRadar sectors={sectors} mode={mode} />
    </div>
  );
}

// --- Activity heatmap ---

const HEATMAP_METRICS: { value: HeatmapMetric; label: string }[] = [
  { value: "aircraft", label: "Aircraft" },
  { value: "flights", label: "Flights" },
  { value: "messages", label: "Messages" },
  { value: "raw_messages", label: "Raw Msgs" },
];

const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => i);

/** Interpolate a value [0, 1] into a color from transparent dark → cyan → amber. */
function heatmapColor(t: number): string {
  if (t === 0) return "transparent";
  // 0→0.5: dark-slate → cyan
  if (t <= 0.5) {
    const s = t * 2; // 0→1
    const r = Math.round(15 + s * (6 - 15));
    const g = Math.round(23 + s * (182 - 23));
    const b = Math.round(42 + s * (212 - 42));
    return `rgba(${r}, ${g}, ${b}, ${0.3 + s * 0.5})`;
  }
  // 0.5→1: cyan → amber
  const s = (t - 0.5) * 2; // 0→1
  const r = Math.round(6 + s * (245 - 6));
  const g = Math.round(182 + s * (158 - 182));
  const b = Math.round(212 + s * (11 - 212));
  return `rgba(${r}, ${g}, ${b}, ${0.8 + s * 0.2})`;
}

function ActivityHeatmap({
  cells,
  startMs,
  endMs,
  tzName,
}: {
  cells: HourlyHeatmapCell[];
  startMs: number;
  endMs: number;
  tzName?: string;
}) {
  const [metric, setMetric] = useState<HeatmapMetric>("aircraft");
  const [hoveredCell, setHoveredCell] = useState<{ row: number; col: number } | null>(null);

  const grid = useMemo(
    () => buildHeatmapGrid(cells, startMs, endMs, metric, tzName),
    [cells, startMs, endMs, metric, tzName],
  );

  const cellLookup = useMemo(() => buildHeatmapCellLookup(cells), [cells]);

  // Compute max value for normalisation
  const maxVal = useMemo(() => {
    let max = 0;
    for (const row of grid) {
      for (const v of row.hours) {
        if (v > max) max = v;
      }
    }
    return max;
  }, [grid]);

  if (grid.length === 0) return null;

  return (
    <div data-testid="heatmap-section">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] text-slate-500 uppercase">Activity Heatmap</div>
        <div className="flex gap-0.5" data-testid="heatmap-metric-toggle">
          {HEATMAP_METRICS.map((m) => (
            <button
              key={m.value}
              onClick={() => setMetric(m.value)}
              data-testid={`heatmap-metric-${m.value}`}
              className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                metric === m.value
                  ? "bg-cyan-900/60 text-cyan-300"
                  : "text-slate-500 hover:text-slate-400"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto overflow-y-auto max-h-[280px]">
        {/* CSS grid: 1 label column + 24 hour columns */}
        <div
          className="inline-grid gap-px"
          style={{
            gridTemplateColumns: `48px repeat(24, 12px)`,
          }}
        >
          {/* Header row */}
          <div className="text-[8px] text-slate-600" />
          {HOUR_LABELS.map((h) => (
            <div key={h} className="text-[7px] text-slate-600 text-center leading-tight">
              {h}
            </div>
          ))}

          {/* Data rows */}
          {grid.map((row, ri) => (
            <React.Fragment key={row.dayMs}>
              <div className="text-[8px] text-slate-500 truncate pr-1 leading-[14px]">
                {row.dayLabel}
              </div>
              {row.hours.map((val, hi) => {
                const t = maxVal > 0 ? val / maxVal : 0;
                const isHovered = hoveredCell?.row === ri && hoveredCell?.col === hi;
                const cell = cellLookup.get(`${row.dayMs}-${hi}`);
                const tooltipLines = [
                  `${row.dayLabel} ${hi}:00–${hi}:59`,
                  `${(cell?.aircraft_count ?? 0).toLocaleString()} aircraft`,
                  `${(cell?.flight_count ?? 0).toLocaleString()} flights`,
                  `${(cell?.message_count ?? 0).toLocaleString()} messages`,
                  `${(cell?.raw_message_count ?? 0).toLocaleString()} raw msgs`,
                ];
                return (
                  <div
                    key={hi}
                    className="w-3 h-[14px] rounded-[1px] cursor-pointer transition-opacity"
                    style={{
                      backgroundColor: heatmapColor(t),
                      outline: isHovered ? "1px solid #94a3b8" : "none",
                    }}
                    title={tooltipLines.join("\n")}
                    onMouseEnter={() => setHoveredCell({ row: ri, col: hi })}
                    onMouseLeave={() => setHoveredCell(null)}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
