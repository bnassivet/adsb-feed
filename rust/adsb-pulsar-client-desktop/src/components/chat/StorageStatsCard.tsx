"use client";
/**
 * Chat card rendering database storage statistics from getStorageStats tool call.
 */
import { formatBytes } from "@/lib/format";
import type { StorageStats } from "@/lib/types";
import { ChatCard } from "./ChatCard";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-100 font-mono">{value}</span>
    </div>
  );
}

function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-GB", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function StorageStatsCard({ status, result }: Props) {
  let stats: StorageStats | null = null;
  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed.row_count === "number") {
        stats = parsed;
      }
    } catch { /* ignore */ }
  }

  return (
    <ChatCard title="Database Statistics" icon="💾" status={status}>
      {stats && (
        <div className="space-y-1 text-xs">
          <Stat label="Positions" value={stats.row_count.toLocaleString()} />
          <Stat label="Positions size" value={formatBytes(stats.db_size_bytes)} />
          <Stat label="Raw messages" value={stats.raw_message_count.toLocaleString()} />
          <Stat label="Raw size" value={formatBytes(stats.raw_db_size_bytes)} />
          <Stat label="Flights" value={stats.flight_count.toLocaleString()} />
          <Stat label="Flights size" value={formatBytes(stats.flight_size_bytes)} />
          <Stat label="Status events" value={stats.status_event_count.toLocaleString()} />
          <div className="border-t border-slate-700 pt-1 mt-1">
            <Stat label="Oldest" value={formatDate(stats.oldest_timestamp_ms)} />
            <Stat label="Newest" value={formatDate(stats.newest_timestamp_ms)} />
          </div>
        </div>
      )}
    </ChatCard>
  );
}
