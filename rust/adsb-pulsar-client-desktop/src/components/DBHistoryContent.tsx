"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getStorageStats, getAircraftSummary, getFlightSummaryArrow, getTrajectoryBatchArrow, getTimeDistribution, getDetectionRange, getHourlyHeatmap, getRawMessageCount } from "@/lib/commands";
import { arrowToTracks, arrowToFlightSummaries } from "@/lib/arrow-utils";
import type { AircraftSummary, AircraftTrack, DetectionRangeSector, FlightSummary, HourlyHeatmapCell, StorageStats, TimeDistributionBucket, TimeDistributionMetric, TimeGranularity, TimeRangePreset } from "@/lib/types";
import { useDisplayTz } from "@/hooks/useDisplayTz";
import { formatBytes } from "@/lib/format";
import { granularityToNumBuckets } from "@/lib/db-history-analytics";
import { DBHistoryAnalytics } from "./DBHistoryAnalytics";
import { StatusTimeline } from "./StatusTimeline";
import { browseReducer, initialBrowseState } from "@/lib/browse-reducer";

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
  /** Add selected tracks to analysis mode (additive). */
  onAddToAnalysis?: (tracks: AircraftTrack[]) => void;
  /** Switch the dashboard to analysis mode after loading. */
  onSwitchToAnalysis?: () => void;
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
  onAddToAnalysis,
  onSwitchToAnalysis,
}: Props) {
  const { formatTime, resolvedTzName } = useDisplayTz();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [browse, dispatch] = useReducer(browseReducer, initialBrowseState);
  const { browsing, loading, batchLoading, summaries, flightSummaries, timeBuckets, detectionSectors, heatmapCells, rawMessageCount, selectedFlights } = browse;

  // Virtualizer for flight list
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flightSummaries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58, // ~58px per row (callsign + hex + time + altitude lines)
    overscan: 10,
  });

  // Controlled time range state
  const now = Date.now();
  const [preset, setPreset] = useState<TimeRangePreset>("24h");
  const [startMs, setStartMs] = useState(() => now - PRESET_DURATIONS["24h"]);
  const [endMs, setEndMs] = useState(() => now);
  const [granularity, setGranularity] = useState<TimeGranularity>("1h");
  const [timeMetric, setTimeMetric] = useState<TimeDistributionMetric>("positions");

  useEffect(() => {
    getStorageStats().then((result) => {
      if (typeof result === "string") {
        setUnavailable(true);
      } else {
        setStats(result as StorageStats);
      }
    });
  }, []);

  const doBrowse = useCallback(async (start: number, end: number, gran: TimeGranularity = granularity, met: TimeDistributionMetric = timeMetric) => {
    dispatch({ type: "START_BROWSE" });
    onBrowse?.(start, end);

    const numBuckets = granularityToNumBuckets(gran, end - start);
    const hasReceiver = receiverLat != null && receiverLon != null;

    const promises: [
      Promise<AircraftSummary[] | string>,
      Promise<FlightSummary[] | string>,
      Promise<TimeDistributionBucket[] | string>,
      Promise<DetectionRangeSector[] | string>,
      Promise<HourlyHeatmapCell[] | string>,
      Promise<number | string>,
    ] = [
      getAircraftSummary(start, end),
      getFlightSummaryArrow({ start_ms: start, end_ms: end })
        .then(bytes => typeof bytes === "string" ? bytes : arrowToFlightSummaries(bytes as number[])),
      getTimeDistribution({ start_ms: start, end_ms: end, num_buckets: numBuckets, metric: met }),
      hasReceiver
        ? getDetectionRange({
            receiver_lat: receiverLat!,
            receiver_lon: receiverLon!,
            start_ms: start,
            end_ms: end,
          })
        : Promise.resolve([]),
      getHourlyHeatmap({ start_ms: start, end_ms: end }),
      getRawMessageCount(start, end),
    ];

    const [summaryResults, flightResults, timeResults, rangeResults, heatmapResults, rawCountResult] = await Promise.all(promises);

    const sums = typeof summaryResults === "string" ? [] : (summaryResults as AircraftSummary[]);
    const flights = typeof flightResults === "string" ? [] : (flightResults as FlightSummary[]);
    const buckets = typeof timeResults === "string" ? [] : (timeResults as TimeDistributionBucket[]);
    const sectors = typeof rangeResults === "string" ? [] : (rangeResults as DetectionRangeSector[]);
    const heatmap = typeof heatmapResults === "string" ? [] : (heatmapResults as HourlyHeatmapCell[]);
    const rawCount = typeof rawCountResult === "number" ? rawCountResult : 0;

    dispatch({
      type: "BROWSE_RESULTS",
      summaries: sums,
      flightSummaries: flights,
      timeBuckets: buckets,
      detectionSectors: sectors,
      heatmapCells: heatmap,
      rawMessageCount: rawCount,
    });
    onSummariesLoaded?.(sums);
  }, [granularity, timeMetric, onBrowse, onSummariesLoaded, receiverLat, receiverLon]);

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

  function handleTimeMetricChange(m: TimeDistributionMetric) {
    setTimeMetric(m);
    if (browsing) {
      doBrowse(startMs, endMs, granularity, m);
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

  async function handleLoadTrajectory(flight: FlightSummary) {
    const bytes = await getTrajectoryBatchArrow([
      [{ hex_ident: flight.hex_ident, start_ms: flight.first_seen_ms, end_ms: flight.last_seen_ms }, flight.flight_id],
    ]);
    if (typeof bytes === "string" || !Array.isArray(bytes) || bytes.length === 0) return;
    const tracks = arrowToTracks(bytes, [flight]);
    if (tracks.length > 0) onLoadTracks(tracks);
  }

  function toggleSelection(flightId: string) {
    dispatch({ type: "TOGGLE_FLIGHT", flightId });
  }

  function toggleSelectAll() {
    dispatch({ type: "TOGGLE_ALL" });
  }

  async function fetchSelectedTracks(): Promise<AircraftTrack[]> {
    const selected = flightSummaries.filter(f => selectedFlights.has(f.flight_id));
    if (selected.length === 0) return [];

    // Single IPC call with Arrow binary — 1 Mutex acquisition, ~4x less data
    const queries: [{ hex_ident: string; start_ms?: number | null; end_ms?: number | null }, string][] =
      selected.map(f => [
        { hex_ident: f.hex_ident, start_ms: f.first_seen_ms, end_ms: f.last_seen_ms },
        f.flight_id,
      ]);

    const bytes = await getTrajectoryBatchArrow(queries);
    if (typeof bytes === "string" || !Array.isArray(bytes)) return [];
    return arrowToTracks(bytes, selected);
  }

  async function handleBatchLoadToLive() {
    dispatch({ type: "SET_BATCH_LOADING", loading: true });
    const tracks = await fetchSelectedTracks();
    if (tracks.length > 0) onLoadTracks(tracks);
    dispatch({ type: "SET_BATCH_LOADING", loading: false });
  }

  async function handleBatchLoadToAnalysis() {
    if (!onAddToAnalysis) return;
    dispatch({ type: "SET_BATCH_LOADING", loading: true });
    const tracks = await fetchSelectedTracks();
    if (tracks.length > 0) {
      onAddToAnalysis(tracks);
      onSwitchToAnalysis?.();
    }
    dispatch({ type: "SET_BATCH_LOADING", loading: false });
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
      {/* Stats — foldable section */}
      <details open className="group border-b border-slate-800" data-testid="dbhist-stats-section">
        <summary className="flex items-center gap-1.5 cursor-pointer select-none px-3 py-1.5 text-xs font-semibold text-slate-400 list-none [&::-webkit-details-marker]:hidden">
          <span className="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
          <span className="flex-1 text-[10px] uppercase tracking-wide text-slate-500">DB Stats</span>
          <button
            onClick={(e) => { e.preventDefault(); handleRefreshStats(); }}
            disabled={refreshing}
            aria-label="Refresh stats"
            title="Refresh stats"
            className="text-slate-500 hover:text-slate-300 transition disabled:opacity-40 leading-none"
          >
            {refreshing ? "…" : "↻"}
          </button>
        </summary>
        <div className="px-3 pb-1.5 text-xs text-slate-400 space-y-0.5">
          <div className="flex justify-between" data-testid="dbhist-row-count">
            <span>Records</span>
            <span className="text-slate-300">{stats.row_count.toLocaleString()}</span>
          </div>
          <div className="flex justify-between" data-testid="dbhist-flight-count">
            <span>Flights</span>
            <span className="text-slate-300">{stats.flight_count.toLocaleString()}</span>
          </div>
          <div className="flex justify-between" data-testid="dbhist-flight-size">
            <span>Flights size</span>
            <span className="text-slate-300">{formatBytes(stats.flight_size_bytes)}</span>
          </div>
          <div className="flex justify-between" data-testid="dbhist-raw-count">
            <span>Raw msgs</span>
            <span className="text-slate-300">{stats.raw_message_count.toLocaleString()}</span>
          </div>
          <div className="flex justify-between" data-testid="dbhist-raw-size">
            <span>Raw size</span>
            <span className="text-slate-300">{formatBytes(stats.raw_db_size_bytes)}</span>
          </div>
          <div className="flex justify-between" data-testid="dbhist-db-size">
            <span>Total size</span>
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
      </details>

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
          {flightSummaries.length === 0 && !loading && (
            <p className="text-xs text-slate-500 italic">No aircraft found.</p>
          )}

          {flightSummaries.length > 0 && (
            <details className="group" data-testid="dbhist-track-list">
              <summary className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-semibold text-slate-400 list-none [&::-webkit-details-marker]:hidden">
                <span className="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
                <span className="flex-1">Flights ({flightSummaries.length})</span>
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

              {/* Select All / batch actions */}
              <div className="mt-1 flex items-center gap-1.5 px-2">
                <label className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer select-none" data-testid="dbhist-select-all">
                  <input
                    type="checkbox"
                    checked={selectedFlights.size === flightSummaries.length && flightSummaries.length > 0}
                    onChange={toggleSelectAll}
                    className="accent-cyan-500"
                  />
                  {selectedFlights.size === flightSummaries.length ? "Deselect all" : "Select all"}
                </label>
                {selectedFlights.size > 0 && (
                  <span className="text-[10px] text-slate-500">({selectedFlights.size})</span>
                )}
                <div className="ml-auto flex gap-1">
                  <button
                    onClick={handleBatchLoadToLive}
                    disabled={selectedFlights.size === 0 || batchLoading}
                    data-testid="dbhist-load-to-live"
                    className="px-1.5 py-0.5 text-[10px] rounded transition disabled:opacity-30 text-blue-400 hover:bg-blue-900/30"
                    title="Load selected trajectories to Live overlay"
                  >
                    {batchLoading ? "…" : "→ Live"}
                  </button>
                  {onAddToAnalysis && (
                    <button
                      onClick={handleBatchLoadToAnalysis}
                      disabled={selectedFlights.size === 0 || batchLoading}
                      data-testid="dbhist-load-to-analysis"
                      className="px-1.5 py-0.5 text-[10px] rounded transition disabled:opacity-30 text-cyan-400 hover:bg-cyan-900/30"
                      title="Load selected trajectories to Analysis mode (additive)"
                    >
                      {batchLoading ? "…" : "→ Analysis"}
                    </button>
                  )}
                </div>
              </div>

              <div ref={scrollRef} className="mt-1 max-h-48 overflow-y-auto">
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const f = flightSummaries[virtualRow.index];
                    return (
                      <div
                        key={f.flight_id}
                        data-index={virtualRow.index}
                        ref={virtualizer.measureElement}
                        style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                        className="flex items-start gap-1.5 px-2 py-1.5 text-xs rounded hover:bg-cyan-900/30 transition border border-transparent hover:border-cyan-800/40"
                      >
                        <input
                          type="checkbox"
                          checked={selectedFlights.has(f.flight_id)}
                          onChange={() => toggleSelection(f.flight_id)}
                          data-testid={`dbhist-check-${f.flight_id}`}
                          className="accent-cyan-500 mt-0.5 shrink-0"
                        />
                        <button
                          onClick={() => handleLoadTrajectory(f)}
                          data-testid={`dbhist-load-${f.flight_id}`}
                          className="text-left flex-1 min-w-0"
                          title={`Load trajectory for ${f.flight_id}`}
                        >
                          <div className="flex justify-between items-center">
                            <span className="text-cyan-200 font-mono font-semibold">
                              {f.callsign ?? f.hex_ident}
                            </span>
                            <span className="text-slate-500 text-[10px]">
                              {f.position_count} pts
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            {f.hex_ident}
                            <span className="ml-2">
                              {formatTime(f.first_seen_ms)} – {formatTime(f.last_seen_ms)}
                            </span>
                          </div>
                          {f.min_altitude !== null && f.max_altitude !== null && (
                            <div className="text-[10px] text-slate-500">
                              {f.min_altitude.toLocaleString()}-{f.max_altitude.toLocaleString()} ft
                            </div>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
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
              rawMessageCount={rawMessageCount}
              timeMetric={timeMetric}
              onTimeMetricChange={handleTimeMetricChange}
              flightSummaries={flightSummaries}
            />
          )}

        </div>
      )}

      {/* Status Timeline — always visible, independent of browse state */}
      <details className="group" data-testid="dbhist-status-timeline">
        <summary className="flex items-center gap-1.5 cursor-pointer select-none px-3 py-1.5 text-xs font-semibold text-slate-400 list-none [&::-webkit-details-marker]:hidden">
          <span className="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
          Status Timeline
        </summary>
        <div className="mt-1 px-3">
          <StatusTimeline />
        </div>
      </details>
    </div>
  );
}
