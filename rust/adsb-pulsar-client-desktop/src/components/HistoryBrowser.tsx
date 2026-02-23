"use client";
import { useEffect, useState } from "react";
import { getStorageStats, getAircraftSummary, getTrajectory } from "@/lib/commands";
import { recordsToTrack } from "@/lib/history-convert";
import type { AircraftSummary, AircraftTrack, StorageStats } from "@/lib/types";

interface Props {
  onImportTracks: (tracks: AircraftTrack[]) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

/** Returns a datetime-local string (YYYY-MM-DDTHH:MM) from ms epoch. */
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function HistoryBrowser({ onImportTracks }: Props) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [summaries, setSummaries] = useState<AircraftSummary[]>([]);
  const [loading, setLoading] = useState(false);

  // Time range inputs — initialized from storage stats once they load
  const now = Date.now();
  const [startVal, setStartVal] = useState(() => toDatetimeLocal(now - 24 * 60 * 60 * 1000));
  const [endVal, setEndVal] = useState(() => toDatetimeLocal(now));

  useEffect(() => {
    getStorageStats().then((result) => {
      if (typeof result === "string") {
        setUnavailable(true);
      } else {
        const s = result as StorageStats;
        setStats(s);
        // Pre-fill the time range to span all available data so Browse shows results immediately
        if (s.oldest_timestamp_ms !== null) {
          setStartVal(toDatetimeLocal(s.oldest_timestamp_ms));
        }
        if (s.newest_timestamp_ms !== null) {
          setEndVal(toDatetimeLocal(s.newest_timestamp_ms));
        }
      }
    });
  }, []);

  async function handleBrowse() {
    if (!browsing) {
      setBrowsing(true);
    }
    setLoading(true);
    const startMs = new Date(startVal).getTime();
    const endMs = new Date(endVal).getTime();
    const results = await getAircraftSummary(startMs, endMs);
    setSummaries(typeof results === "string" ? [] : (results as AircraftSummary[]));
    setLoading(false);
  }

  async function handleLoadTrajectory(summary: AircraftSummary) {
    const startMs = new Date(startVal).getTime();
    const endMs = new Date(endVal).getTime();
    const records = await getTrajectory({
      hex_ident: summary.hex_ident,
      start_ms: startMs,
      end_ms: endMs,
    });
    if (typeof records === "string" || !Array.isArray(records) || records.length === 0) return;
    const track = recordsToTrack(records);
    onImportTracks([track]);
  }

  if (unavailable) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500 italic">
        History unavailable
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Stats strip */}
      <div className="px-3 py-1.5 text-xs text-slate-400 border-b border-slate-800 space-y-0.5">
        <div className="flex justify-between">
          <span>Records</span>
          <span className="text-slate-300">{stats.row_count.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span>Size</span>
          <span className="text-slate-300">{formatBytes(stats.db_size_bytes)}</span>
        </div>
        <div className="flex justify-between">
          <span>Oldest</span>
          <span className="text-slate-300">{formatMs(stats.oldest_timestamp_ms)}</span>
        </div>
        <div className="flex justify-between">
          <span>Newest</span>
          <span className="text-slate-300">{formatMs(stats.newest_timestamp_ms)}</span>
        </div>
      </div>

      {/* Browse button */}
      <div className="px-3 py-1">
        <button
          onClick={handleBrowse}
          className="w-full px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition"
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
              value={startVal}
              onChange={(e) => setStartVal(e.target.value)}
              className="block w-full mt-0.5 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200"
            />
          </label>
          <label className="text-xs text-slate-400">
            End
            <input
              type="datetime-local"
              value={endVal}
              onChange={(e) => setEndVal(e.target.value)}
              className="block w-full mt-0.5 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200"
            />
          </label>
          <button
            onClick={handleBrowse}
            disabled={loading}
            className="px-2 py-0.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded transition disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>

          {summaries.length === 0 && !loading && (
            <p className="text-xs text-slate-500 italic">No aircraft found.</p>
          )}

          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
            {summaries.map((s) => (
              <button
                key={s.hex_ident}
                onClick={() => handleLoadTrajectory(s)}
                className="text-left px-2 py-1 text-xs rounded hover:bg-slate-700 transition"
                title={`Load trajectory for ${s.hex_ident}`}
              >
                <span className="text-slate-200 font-mono">
                  {s.callsign ?? s.hex_ident}
                </span>
                <span className="text-slate-500 ml-1">
                  ({s.position_count} pts)
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
