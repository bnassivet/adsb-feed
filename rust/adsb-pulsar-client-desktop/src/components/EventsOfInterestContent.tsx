"use client";
import { useState, useCallback, useEffect } from "react";
import type { EventOfInterest } from "@/lib/types";
import { ask } from "@tauri-apps/plugin-dialog";
import { formatEventTime, timeAgoLong } from "@/lib/format";

const SOURCE_COLORS: Record<string, string> = {
  user: "bg-amber-800/40 text-amber-200 border-amber-700/30",
  detector: "bg-cyan-800/40 text-cyan-200 border-cyan-700/30",
  news_feed: "bg-green-800/40 text-green-200 border-green-700/30",
};

function sourceBadgeClass(source: string): string {
  return SOURCE_COLORS[source] ?? "bg-slate-700/40 text-slate-300 border-slate-600/30";
}

export interface EventsOfInterestContentProps {
  events: EventOfInterest[];
  loading: boolean;
  onEditEvent: (event: EventOfInterest) => void;
  onDeleteEvent: (id: string) => Promise<void>;
  onDeleteEvents?: (ids: string[]) => Promise<void>;
  hiddenEventIds?: Set<string>;
  onToggleEventVisibility?: (id: string) => void;
}

export function EventsOfInterestContent({
  events,
  loading,
  onEditEvent,
  onDeleteEvent,
  onDeleteEvents,
  hiddenEventIds,
  onToggleEventVisibility,
}: EventsOfInterestContentProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Clear selection when events change (e.g., after bulk delete or refresh)
  useEffect(() => {
    setSelectedIds(new Set());
  }, [events]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDelete = useCallback(
    async (event: EventOfInterest) => {
      const confirmed = await ask(
        `Delete event "${event.title}"?`,
        { title: "Delete Event", kind: "warning" }
      );
      if (confirmed) {
        await onDeleteEvent(event.id);
      }
    },
    [onDeleteEvent]
  );

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const confirmed = await ask(
      `Delete ${ids.length} event${ids.length > 1 ? "s" : ""}?`,
      { title: "Delete Events", kind: "warning" }
    );
    if (!confirmed) return;
    if (onDeleteEvents) {
      await onDeleteEvents(ids);
    } else {
      for (const id of ids) {
        await onDeleteEvent(id);
      }
    }
  }, [selectedIds, onDeleteEvent, onDeleteEvents]);

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      {selectedIds.size > 0 && (
        <div className="px-3 py-1.5 bg-red-900/30 border-b border-red-800/50 flex items-center justify-between">
          <span className="text-[10px] text-red-300">
            {selectedIds.size} selected
          </span>
          <button
            onClick={handleBulkDelete}
            className="px-2 py-0.5 text-[10px] bg-red-700 hover:bg-red-600 text-red-100 rounded transition"
          >
            Delete {selectedIds.size}
          </button>
        </div>
      )}
      {loading && (
        <div className="p-3 text-xs text-slate-500">Loading...</div>
      )}
      {!loading && events.length === 0 && (
        <div className="p-3 text-xs text-slate-500">
          No events yet. Click &quot;+ New&quot; or right-click the map.
        </div>
      )}
      {events.map((event) => {
        const isHidden = hiddenEventIds?.has(event.id) ?? false;
        return (
          <div
            key={event.id}
            data-testid="event-row"
            className={`px-3 py-2 border-b border-slate-800 hover:bg-slate-800/50 cursor-pointer group${isHidden ? " opacity-50" : ""}`}
            onClick={() => {
              if (event.source === "user") onEditEvent(event);
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <input
                  type="checkbox"
                  checked={selectedIds.has(event.id)}
                  onChange={(e) => {
                    e.stopPropagation();
                    toggleSelect(event.id);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-3 h-3 shrink-0 accent-amber-500"
                />
                <span className="text-xs font-medium text-slate-200 truncate">
                  {event.title}
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {onToggleEventVisibility && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleEventVisibility(event.id);
                    }}
                    title={isHidden ? "Show on map" : "Hide from map"}
                    className="p-0.5 text-slate-500 hover:text-slate-300 transition"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      {isHidden ? (
                        <>
                          <path d="M2 2L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          <path d="M3.5 5.5C2.3 6.5 1.5 8 1.5 8s2.5 5 6.5 5c1 0 1.9-.3 2.7-.7M12.5 10.5C13.7 9.5 14.5 8 14.5 8s-2.5-5-6.5-5c-1 0-1.9.3-2.7.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </>
                      ) : (
                        <>
                          <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.5" />
                          <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
                        </>
                      )}
                    </svg>
                  </button>
                )}
                <span
                  className={`px-1.5 py-0.5 text-[10px] rounded border ${sourceBadgeClass(event.source)}`}
                >
                  {event.source}
                </span>
                {event.category && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-700/40 text-slate-300 border border-slate-600/30">
                    {event.category}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-[10px] text-slate-500">
                {formatEventTime(event.timestamp_ms)} · {timeAgoLong(event.timestamp_ms)}
                {event.end_timestamp_ms != null && " (range)"}
                {event.latitude != null && " · point"}
                {event.bbox_north != null && " · area"}
              </span>
              {event.source === "user" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(event);
                  }}
                  className="text-[10px] text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition"
                  title="Delete event"
                >
                  delete
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
