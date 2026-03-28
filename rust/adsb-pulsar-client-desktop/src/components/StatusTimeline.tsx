"use client";
import { useCallback, useEffect, useState } from "react";
import { getStatusTimeline } from "@/lib/commands";
import type {
  StatusEvent,
  StatusEventType,
  StatusEventStatus,
  TimeRangePreset,
} from "@/lib/types";

const STATUS_COLORS: Record<StatusEventStatus, string> = {
  AppStart: "bg-green-500",
  Started: "bg-green-500",
  Connected: "bg-green-500",
  Reclaimed: "bg-green-500",
  Error: "bg-red-500",
  ConnectionLost: "bg-red-500",
  Degraded: "bg-orange-500",
  Connecting: "bg-yellow-500",
  Disconnected: "bg-slate-500",
  Stopped: "bg-slate-500",
  Released: "bg-blue-500",
};

const TYPE_LABELS: Record<StatusEventType, string> = {
  feed: "Feed",
  socket: "Socket",
  pulsar: "Pulsar",
  storage: "Storage",
};

const FILTER_TYPES: StatusEventType[] = ["feed", "socket", "pulsar", "storage"];

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

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatEventTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatEventDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function StatusTimeline() {
  const [events, setEvents] = useState<StatusEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState<StatusEventType | null>(null);

  // Own time range state
  const [preset, setPreset] = useState<TimeRangePreset>("24h");
  const [startMs, setStartMs] = useState(() => Date.now() - PRESET_DURATIONS["24h"]);
  const [endMs, setEndMs] = useState(() => Date.now());

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getStatusTimeline({
        start_ms: startMs,
        end_ms: endMs,
        event_type: typeFilter,
        limit: 200,
      });
      if (Array.isArray(result)) {
        setEvents(result);
      }
    } catch {
      setEvents([]);
    }
    setLoading(false);
  }, [startMs, endMs, typeFilter]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  function handlePresetClick(p: TimeRangePreset) {
    setPreset(p);
    if (p !== "custom") {
      const newEnd = Date.now();
      setStartMs(newEnd - PRESET_DURATIONS[p]);
      setEndMs(newEnd);
    }
  }

  function handleCustomBrowse() {
    fetchEvents();
  }

  return (
    <div className="flex flex-col gap-1" data-testid="status-timeline">
      {/* Time range presets */}
      <div className="flex flex-wrap gap-0.5" data-testid="status-timeline-presets">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => handlePresetClick(p)}
            data-testid={`status-preset-${p}`}
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

      {/* Custom datetime inputs */}
      {preset === "custom" && (
        <div className="flex flex-col gap-1" data-testid="status-custom-inputs">
          <div className="flex flex-wrap gap-1.5">
            <label className="flex-1 min-w-[130px] text-[10px] text-slate-400">
              Start
              <input
                type="datetime-local"
                value={toDatetimeLocal(startMs)}
                onChange={(e) => setStartMs(new Date(e.target.value).getTime())}
                className="block w-full mt-0.5 px-1 py-0.5 text-[10px] bg-slate-800 border border-slate-600 rounded text-slate-200"
                data-testid="status-custom-start"
              />
            </label>
            <label className="flex-1 min-w-[130px] text-[10px] text-slate-400">
              End
              <input
                type="datetime-local"
                value={toDatetimeLocal(endMs)}
                onChange={(e) => setEndMs(new Date(e.target.value).getTime())}
                className="block w-full mt-0.5 px-1 py-0.5 text-[10px] bg-slate-800 border border-slate-600 rounded text-slate-200"
                data-testid="status-custom-end"
              />
            </label>
          </div>
          <button
            onClick={handleCustomBrowse}
            className="self-start px-2 py-0.5 text-[10px] rounded bg-cyan-900/60 text-cyan-300 hover:bg-cyan-800/60 transition-colors"
            data-testid="status-custom-browse"
          >
            Browse
          </button>
        </div>
      )}

      {/* Type filter pills */}
      <div className="flex flex-wrap gap-0.5" data-testid="status-timeline-filters">
        <button
          onClick={() => setTypeFilter(null)}
          className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
            typeFilter === null
              ? "bg-cyan-900/60 text-cyan-300"
              : "text-slate-500 hover:text-slate-400"
          }`}
          data-testid="status-filter-all"
        >
          All
        </button>
        {FILTER_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
              typeFilter === t
                ? "bg-cyan-900/60 text-cyan-300"
                : "text-slate-500 hover:text-slate-400"
            }`}
            data-testid={`status-filter-${t}`}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Timeline */}
      {loading && (
        <p className="text-xs text-slate-500 italic" data-testid="status-timeline-loading">Loading...</p>
      )}

      {!loading && events.length === 0 && (
        <p className="text-xs text-slate-500 italic" data-testid="status-timeline-empty">No status events in this time range.</p>
      )}

      {!loading && events.length > 0 && (
        <div className="max-h-64 overflow-y-auto" data-testid="status-timeline-list">
          {events.map((event, i) => {
            const prevEvent = i < events.length - 1 ? events[i + 1] : null;
            const durationMs = prevEvent ? event.timestamp_ms - prevEvent.timestamp_ms : null;
            const dotColor = STATUS_COLORS[event.status] ?? "bg-slate-500";

            return (
              <div key={`${event.timestamp_ms}-${event.event_type}-${event.status}-${i}`} className="flex gap-2 py-1">
                {/* Timeline dot + line */}
                <div className="flex flex-col items-center w-3 shrink-0">
                  <div className={`w-2 h-2 rounded-full ${dotColor} shrink-0 mt-1`} data-testid="status-dot" />
                  {i < events.length - 1 && (
                    <div className="w-px flex-1 bg-slate-700 mt-0.5" />
                  )}
                </div>

                {/* Event content */}
                <div className="flex-1 min-w-0 pb-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] px-1 py-0.5 rounded bg-slate-800 text-slate-400 font-mono" data-testid="status-type-badge">
                      {TYPE_LABELS[event.event_type]}
                    </span>
                    <span className="text-xs text-slate-200" data-testid="status-text">
                      {event.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    <span data-testid="status-time">
                      {formatEventDate(event.timestamp_ms)} {formatEventTime(event.timestamp_ms)}
                    </span>
                    {event.source_id && (
                      <span className="ml-2 text-slate-600">{event.source_id}</span>
                    )}
                  </div>
                  {event.detail && (
                    <div className="text-[10px] text-slate-500 mt-0.5" data-testid="status-detail">
                      {event.detail}
                    </div>
                  )}
                  {durationMs != null && durationMs > 0 && (
                    <div className="text-[10px] text-slate-600 mt-0.5" data-testid="status-duration">
                      {formatDuration(durationMs)} later
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { formatDuration };
