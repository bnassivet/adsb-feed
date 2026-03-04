"use client";
import { useCallback, useEffect, useState } from "react";
import { getStorageStats, getAircraftSummary, getTrajectory, getTimeDistribution, getDetectionRange, getHourlyHeatmap } from "@/lib/commands";
import { recordsToTrack } from "@/lib/history-convert";
import type { AircraftSummary, AircraftTrack, DetectionRangeSector, HourlyHeatmapCell, StorageStats, TimeDistributionBucket, TimeGranularity, TimeRangePreset } from "@/lib/types";
import { useDisplayTz } from "@/hooks/useDisplayTz";
import { formatBytes } from "@/lib/format";
import { granularityToNumBuckets } from "@/lib/db-history-analytics";
import { DBHistoryAnalytics } from "./DBHistoryAnalytics";

interface Props {
  onLoadTracks: (tracks: AircraftTrack[]) => void;
  onClearTracks: () => void;
  dbHistoryCount: number;
  /** Called when summaries are fetched (for analytics) */
  onSummariesLoaded?: (summaries: AircraftSummary[]) => void;
  /** Called with time range when browse is triggered (for time distribution query) */
  onBrowse?: (startMs: number, endMs: number) => void;
  /** Receiver location for detection range analysis. */
  receiverLat?: number | null;
  receiverLon?: number | null;
}

/** Preset durations in ms. */
const PRESET_DURATIONS: Record<Exclude<TimeRangePreset, "custom">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "48h": 48 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "2w": 14 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  "3m": 90 * 24 * 60 * 60 * 1000,
};

const PRESETS: TimeRangePreset[] = ["24h", "48h", "1w", "2w", "1m", "3m", "custom"];

/** Returns a datetime-local string (YYYY-MM-DDTHH:MM) from ms epoch. */
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DBHistoryContent({
  onLoadTracks,
  onClearTracks,
  dbHistoryCount,
  onSummariesLoaded,
  onBrowse,
  receiverLat,
  receiverLon,
}: Props) {
  const { formatTime, resolvedTzName } = useDisplayTz();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [summaries, setSummaries] = useState<AircraftSummary[]>([]);
  const [timeBuckets, setTimeBuckets] = useState<TimeDistributionBucket[]>([]);
  const [detectionSectors, setDetectionSectors] = useState<DetectionRangeSector[]>([]);
  const [heatmapCells, setHeatmapCells] = useState<HourlyHeatmapCell[]>([]);
  const [loading, setLoading] = useState(false);

  // Controlled time range state
  const now = Date.now();
  const [preset, setPreset] = useState<TimeRangePreset>("24h");
  const [startMs, setStartMs] = useState(() => now - PRESET_DURATIONS["24h"]);
  const [endMs, setEndMs] = useState(() => now);
  const [granularity, setGranularity] = useState<TimeGranularity>("1h");

  useEffect(() => {
    getStorageStats().then((result) => {
      if (typeof result === "string") {
        setUnavailable(true);
      } else {
        setStats(result as StorageStats);
      }
    });
  }, []);

  const doBrowse = useCallback(async (start: number, end: number, gran: TimeGranularity = granularity) => {
    if (!browsing) setBrowsing(true);
    setLoading(true);
    onBrowse?.(start, end);

    const numBuckets = granularityToNumBuckets(gran, end - start);
    const hasReceiver = receiverLat != null && receiverLon != null;

    const promises: [
      Promise<AircraftSummary[] | string>,
      Promise<TimeDistributionBucket[] | string>,
      Promise<DetectionRangeSector[] | string>,
      Promise<HourlyHeatmapCell[] | string>,
    ] = [
      getAircraftSummary(start, end),
      getTimeDistribution({ start_ms: start, end_ms: end, num_buckets: numBuckets }),
      hasReceiver
        ? getDetectionRange({
            receiver_lat: receiverLat!,
            receiver_lon: receiverLon!,
            start_ms: start,
            end_ms: end,
          })
        : Promise.resolve([]),
      getHourlyHeatmap({ start_ms: start, end_ms: end }),
    ];

    const [summaryResults, timeResults, rangeResults, heatmapResults] = await Promise.all(promises);

    const sums = typeof summaryResults === "string" ? [] : (summaryResults as AircraftSummary[]);
    const buckets = typeof timeResults === "string" ? [] : (timeResults as TimeDistributionBucket[]);
    const sectors = typeof rangeResults === "string" ? [] : (rangeResults as DetectionRangeSector[]);
    const heatmap = typeof heatmapResults === "string" ? [] : (heatmapResults as HourlyHeatmapCell[]);
    setSummaries(sums);
    setTimeBuckets(buckets);
    setDetectionSectors(sectors);
    setHeatmapCells(heatmap);
    onSummariesLoaded?.(sums);
    setLoading(false);
  }, [browsing, granularity, onBrowse, onSummariesLoaded, receiverLat, receiverLon]);

  function handlePresetClick(p: TimeRangePreset) {
    setPreset(p);
    if (p !== "custom") {
      const newEnd = Date.now();
      const newStart = newEnd - PRESET_DURATIONS[p];
      setStartMs(newStart);
      setEndMs(newEnd);
      doBrowse(newStart, newEnd);
    }
  }

  function handleBrowse() {
    doBrowse(startMs, endMs);
  }

  function handleRefreshBrowse() {
    if (preset !== "custom") {
      // Re-anchor to "now" so the window slides forward
      const newEnd = Date.now();
      const newStart = newEnd - PRESET_DURATIONS[preset];
      setStartMs(newStart);
      setEndMs(newEnd);
      doBrowse(newStart, newEnd);
    } else {
      doBrowse(startMs, endMs);
    }
  }

  function handleZoom(zoomStart: number, zoomEnd: number) {
    setPreset("custom");
    setStartMs(zoomStart);
    setEndMs(zoomEnd);
    doBrowse(zoomStart, zoomEnd);
  }

  function handleGranularityChange(g: TimeGranularity) {
    setGranularity(g);
    if (browsing) {
      doBrowse(startMs, endMs, g);
    }
  }

  async function handleRefreshStats() {
    setRefreshing(true);
    const result = await getStorageStats();
    if (typeof result === "string") {
      setUnavailable(true);
    } else {
      setStats(result as StorageStats);
    }
    setRefreshing(false);
  }

  async function handleLoadTrajectory(summary: AircraftSummary) {
    const records = await getTrajectory({
      hex_ident: summary.hex_ident,
      start_ms: startMs,
      end_ms: endMs,
    });
    if (typeof records === "string" || !Array.isArray(records) || records.length === 0) return;
    const track = recordsToTrack(records);
    onLoadTracks([track]);
  }

  if (unavailable) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500 italic" data-testid="dbhist-unavailable">
        History unavailable
      </div>
    );
  }

  if (!stats) {
    return <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Stats strip */}
      <div className="px-3 py-1.5 text-xs text-slate-400 border-b border-slate-800 space-y-0.5">
        <div className="flex justify-between items-center">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">DB Stats</span>
          <button
            onClick={handleRefreshStats}
            disabled={refreshing}
            aria-label="Refresh stats"
            title="Refresh stats"
            className="text-slate-500 hover:text-slate-300 transition disabled:opacity-40 leading-none"
          >
            {refreshing ? "…" : "↻"}
          </button>
        </div>
        <div className="flex justify-between" data-testid="dbhist-row-count">
          <span>Records</span>
          <span className="text-slate-300">{stats.row_count.toLocaleString()}</span>
        </div>
        <div className="flex justify-between" data-testid="dbhist-db-size">
          <span>Size</span>
          <span className="text-slate-300">{formatBytes(stats.db_size_bytes)}</span>
        </div>
        <div className="flex justify-between">
          <span>Oldest</span>
          <span className="text-slate-300">{stats.oldest_timestamp_ms !== null ? formatTime(stats.oldest_timestamp_ms) : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span>Newest</span>
          <span className="text-slate-300">{stats.newest_timestamp_ms !== null ? formatTime(stats.newest_timestamp_ms) : "—"}</span>
        </div>
      </div>

      {/* Preset time range pills */}
      <div className="px-3 py-1">
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase">Time Range</span>
          {browsing && (
            <button
              onClick={handleRefreshBrowse}
              disabled={loading}
              data-testid="dbhist-refresh-btn"
              aria-label="Refresh time range"
              title="Refresh time range"
              className="text-slate-500 hover:text-slate-300 transition disabled:opacity-40 text-xs leading-none"
            >
              {loading ? "…" : "↻"}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-0.5" data-testid="dbhist-presets">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => handlePresetClick(p)}
              data-testid={`dbhist-preset-${p}`}
              className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                preset === p
                  ? "bg-cyan-900/60 text-cyan-300"
                  : "text-slate-500 hover:text-slate-400"
              }`}
            >
              {p === "custom" ? "Custom" : p}
            </button>
          ))}
        </div>
      </div>

      {/* Custom datetime inputs — only visible when preset is "custom" */}
      {preset === "custom" && (
        <div className="px-3 pb-1 flex flex-col gap-1" data-testid="dbhist-custom-inputs">
          <div className="flex flex-wrap gap-1.5">
            <label className="flex-1 min-w-[140px] text-xs text-slate-400">
              Start
              <input
                type="datetime-local"
                value={toDatetimeLocal(startMs)}
                onChange={(e) => setStartMs(new Date(e.target.value).getTime())}
                className="block w-full mt-0.5 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200"
              />
            </label>
            <label className="flex-1 min-w-[140px] text-xs text-slate-400">
              End
              <input
                type="datetime-local"
                value={toDatetimeLocal(endMs)}
                onChange={(e) => setEndMs(new Date(e.target.value).getTime())}
                className="block w-full mt-0.5 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200"
              />
            </label>
          </div>
          <button
            onClick={handleBrowse}
            disabled={loading}
            data-testid="dbhist-browse-btn"
            className="px-2 py-0.5 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded transition disabled:opacity-50"
          >
            {loading ? "Loading…" : "Browse"}
          </button>
        </div>
      )}

      {/* Results area */}
      {browsing && (
        <div className="flex flex-col gap-1 px-3 pb-2">
          {summaries.length === 0 && !loading && (
            <p className="text-xs text-slate-500 italic">No aircraft found.</p>
          )}

          {summaries.length > 0 && (
            <details open className="group" data-testid="dbhist-track-list">
              <summary className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-semibold text-slate-400 list-none [&::-webkit-details-marker]:hidden">
                <span className="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
                <span className="flex-1">Aircraft ({summaries.length})</span>
                {dbHistoryCount > 0 && (
                  <button
                    onClick={(e) => { e.preventDefault(); onClearTracks(); }}
                    data-testid="dbhist-clear-btn"
                    className="text-[10px] text-slate-500 hover:text-red-400 hover:bg-red-900/20 px-1.5 py-0.5 rounded transition"
                    title="Clear loaded tracks from map"
                  >
                    Clear tracks ({dbHistoryCount})
                  </button>
                )}
              </summary>
              <div className="mt-1 flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                {summaries.map((s) => (
                  <button
                    key={s.hex_ident}
                    onClick={() => handleLoadTrajectory(s)}
                    data-testid={`dbhist-load-${s.hex_ident}`}
                    className="text-left px-2 py-1.5 text-xs rounded hover:bg-cyan-900/30 transition border border-transparent hover:border-cyan-800/40"
                    title={`Load trajectory for ${s.hex_ident}`}
                  >
                    <div className="flex justify-between items-center">
                      <span className="text-cyan-200 font-mono font-semibold">
                        {s.callsign ?? s.hex_ident}
                      </span>
                      <span className="text-slate-500 text-[10px]">
                        {s.position_count} pts
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      {s.hex_ident}
                      {s.min_altitude !== null && s.max_altitude !== null && (
                        <span className="ml-2">
                          {s.min_altitude.toLocaleString()}-{s.max_altitude.toLocaleString()} ft
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </details>
          )}

          {/* Analytics charts */}
          {(summaries.length > 0 || timeBuckets.length > 0) && (
            <DBHistoryAnalytics
              summaries={summaries}
              timeBuckets={timeBuckets}
              tzName={resolvedTzName}
              detectionSectors={detectionSectors}
              rangeMs={endMs - startMs}
              onZoom={handleZoom}
              granularity={granularity}
              onGranularityChange={handleGranularityChange}
              heatmapCells={heatmapCells}
              startMs={startMs}
              endMs={endMs}
            />
          )}

        </div>
      )}
    </div>
  );
}
