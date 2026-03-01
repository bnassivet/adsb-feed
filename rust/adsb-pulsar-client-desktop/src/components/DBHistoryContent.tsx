"use client";
import { useEffect, useRef, useState } from "react";
import { getStorageStats, getAircraftSummary, getTrajectory, getTimeDistribution, getDetectionRange } from "@/lib/commands";
import { recordsToTrack } from "@/lib/history-convert";
import type { AircraftSummary, AircraftTrack, DetectionRangeSector, StorageStats, TimeDistributionBucket } from "@/lib/types";
import { useDisplayTz } from "@/hooks/useDisplayTz";
import { formatBytes } from "@/lib/format";
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
  const [loading, setLoading] = useState(false);

  const now = Date.now();
  const [startDefault, setStartDefault] = useState(() => toDatetimeLocal(now - 24 * 60 * 60 * 1000));
  const [endDefault, setEndDefault] = useState(() => toDatetimeLocal(now));
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getStorageStats().then((result) => {
      if (typeof result === "string") {
        setUnavailable(true);
      } else {
        const s = result as StorageStats;
        setStats(s);
        if (s.oldest_timestamp_ms !== null) {
          setStartDefault(toDatetimeLocal(s.oldest_timestamp_ms));
        }
        if (s.newest_timestamp_ms !== null) {
          setEndDefault(toDatetimeLocal(s.newest_timestamp_ms));
        }
      }
    });
  }, []);

  function getTimeRange(): [number, number] {
    const startStr = startRef.current?.value ?? startDefault;
    const endStr = endRef.current?.value ?? endDefault;
    return [new Date(startStr).getTime(), new Date(endStr).getTime()];
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

  async function handleBrowse() {
    if (!browsing) setBrowsing(true);
    setLoading(true);
    const [startMs, endMs] = getTimeRange();
    onBrowse?.(startMs, endMs);

    const hasReceiver = receiverLat != null && receiverLon != null;

    const promises: [
      Promise<AircraftSummary[] | string>,
      Promise<TimeDistributionBucket[] | string>,
      Promise<DetectionRangeSector[] | string>,
    ] = [
      getAircraftSummary(startMs, endMs),
      getTimeDistribution({ start_ms: startMs, end_ms: endMs, num_buckets: 24 }),
      hasReceiver
        ? getDetectionRange({
            receiver_lat: receiverLat!,
            receiver_lon: receiverLon!,
            start_ms: startMs,
            end_ms: endMs,
          })
        : Promise.resolve([]),
    ];

    const [summaryResults, timeResults, rangeResults] = await Promise.all(promises);

    const sums = typeof summaryResults === "string" ? [] : (summaryResults as AircraftSummary[]);
    const buckets = typeof timeResults === "string" ? [] : (timeResults as TimeDistributionBucket[]);
    const sectors = typeof rangeResults === "string" ? [] : (rangeResults as DetectionRangeSector[]);
    setSummaries(sums);
    setTimeBuckets(buckets);
    setDetectionSectors(sectors);
    onSummariesLoaded?.(sums);
    setLoading(false);
  }

  async function handleLoadTrajectory(summary: AircraftSummary) {
    const [startMs, endMs] = getTimeRange();
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

      {/* Browse button */}
      <div className="px-3 py-1">
        <button
          onClick={handleBrowse}
          data-testid="dbhist-browse-btn"
          className="w-full px-2 py-1 text-xs bg-cyan-800/40 hover:bg-cyan-700/40 text-cyan-200 rounded transition border border-cyan-700/30"
        >
          Browse DB History
        </button>
      </div>

      {/* Time range + aircraft list */}
      {browsing && (
        <div className="flex flex-col gap-1 px-3 pb-2">
          <label className="text-xs text-slate-400">
            Start
            <input
              type="datetime-local"
              ref={startRef}
              defaultValue={startDefault}
              className="block w-full mt-0.5 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200"
            />
          </label>
          <label className="text-xs text-slate-400">
            End
            <input
              type="datetime-local"
              ref={endRef}
              defaultValue={endDefault}
              className="block w-full mt-0.5 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200"
            />
          </label>
          <button
            onClick={handleBrowse}
            disabled={loading}
            className="px-2 py-0.5 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded transition disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>

          {summaries.length === 0 && !loading && (
            <p className="text-xs text-slate-500 italic">No aircraft found.</p>
          )}

          {summaries.length > 0 && (
            <details open className="group" data-testid="dbhist-track-list">
              <summary className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-semibold text-slate-400 list-none [&::-webkit-details-marker]:hidden">
                <span className="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
                Aircraft ({summaries.length})
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
            />
          )}

          {/* Clear DB History button */}
          {dbHistoryCount > 0 && (
            <button
              onClick={onClearTracks}
              data-testid="dbhist-clear-btn"
              className="mt-1 px-2 py-0.5 text-xs text-slate-500 hover:text-red-400 hover:bg-red-900/20 rounded transition"
            >
              Clear DB History ({dbHistoryCount})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
