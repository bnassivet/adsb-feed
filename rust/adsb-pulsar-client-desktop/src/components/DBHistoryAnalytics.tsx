"use client";
import React, { useCallback, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea } from "recharts";
import type { AircraftSummary, DetectionRangeSector, HeatmapMetric, HourlyHeatmapCell, TimeDistributionBucket, TimeDistributionMetric, TimeGranularity } from "@/lib/types";
import type { RadarMode } from "@/lib/detection-radar";
import {
  buildAltitudeBins,
  buildHeatmapGrid,
  computeDbHistorySummary,
  formatTimeChartData,
  formatAdaptiveTimeLabel,
} from "@/lib/db-history-analytics";
import { DetectionRadar } from "./DetectionRadar";

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
}

const GRANULARITIES: { value: TimeGranularity; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export function DBHistoryAnalytics({ summaries, timeBuckets, tzName, detectionSectors, rangeMs, onZoom, granularity, onGranularityChange, heatmapCells, startMs, endMs, rawMessageCount, timeMetric, onTimeMetricChange }: Props) {
  const summary = useMemo(() => computeDbHistorySummary(summaries, rawMessageCount ?? 0), [summaries, rawMessageCount]);
  const altBins = useMemo(() => buildAltitudeBins(summaries), [summaries]);
  const timeData = useMemo(() => formatTimeChartData(timeBuckets, tzName, rangeMs), [timeBuckets, tzName, rangeMs]);
  const hasAltData = altBins.some((b) => b.count > 0);

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
            <div className="text-[10px] text-slate-500 uppercase">Tracks</div>
            <div className="text-cyan-300 font-mono font-semibold">{summary.totalTracks}</div>
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
            <div className="text-cyan-300 font-mono font-semibold">{formatDuration(summary.avgDurationMs)}</div>
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
          />
        )}

        {/* Activity heatmap */}
        {heatmapCells && heatmapCells.length > 0 && startMs != null && endMs != null && (
          <ActivityHeatmap cells={heatmapCells} startMs={startMs} endMs={endMs} tzName={tzName} />
        )}

        {/* Altitude histogram */}
        {hasAltData && (
          <div>
            <div className="text-[10px] text-slate-500 uppercase mb-1">Altitude Distribution</div>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={altBins} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#64748b", fontSize: 9 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  interval={1}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: 4, fontSize: 11 }}
                  labelStyle={{ color: "#94a3b8" }}
                  itemStyle={{ color: "#818cf8" }}
                  formatter={(value: number | undefined) => [`${value ?? 0} aircraft`, "Count"]}
                  labelFormatter={(label: unknown) => `${String(label)} ft`}
                />
                <Bar dataKey="count" fill="#818cf8" opacity={0.7} radius={[2, 2, 0, 0]} />
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
  { value: "positions", label: "Positions" },
  { value: "aircraft", label: "Aircraft" },
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
}

function TimeDistributionChart({ timeData, tickFormatter, onZoom, granularity, onGranularityChange, metric, onMetricChange }: TimeChartProps) {
  const [refAreaLeft, setRefAreaLeft] = useState<number | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<number | null>(null);

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
      <ResponsiveContainer width="100%" height={120}>
        <BarChart
          data={timeData}
          margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <XAxis
            dataKey="bucketMs"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={tickFormatter}
            tick={{ fill: "#64748b", fontSize: 9 }}
            axisLine={{ stroke: "#334155" }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 9 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: 4, fontSize: 11 }}
            labelStyle={{ color: "#94a3b8" }}
            itemStyle={{ color: "#06b6d4" }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            labelFormatter={(value: any) => tickFormatter(Number(value))}
          />
          <Bar dataKey="count" fill="#06b6d4" opacity={0.7} radius={[2, 2, 0, 0]} />
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
  { value: "messages", label: "Messages" },
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
                return (
                  <div
                    key={hi}
                    className="w-3 h-[14px] rounded-[1px] cursor-pointer transition-opacity"
                    style={{
                      backgroundColor: heatmapColor(t),
                      outline: isHovered ? "1px solid #94a3b8" : "none",
                    }}
                    title={`${row.dayLabel} ${hi}:00–${hi}:59 — ${val.toLocaleString()} ${metric === "aircraft" ? "aircraft" : "messages"}`}
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

