"use client";
/**
 * Chat card rendering feed performance metrics from getFeedMetrics tool call.
 */
import { formatBytes } from "@/lib/format";
import type { MetricsSnapshot } from "@/lib/types";
import { ChatCard } from "./ChatCard";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-100 font-mono">{value}</span>
    </div>
  );
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${secs % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function FeedMetricsCard({ status, result }: Props) {
  let metrics: MetricsSnapshot | null = null;
  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result);
      // Guard against malformed results (e.g. LLM-generated instead of tool-executed)
      if (parsed && typeof parsed.messages_received === "number") {
        metrics = parsed;
      }
    } catch { /* ignore */ }
  }

  return (
    <ChatCard title="Feed Metrics" icon="📊" status={status}>
      {metrics && (
        <div className="space-y-1 text-xs">
          <Stat label="Messages received" value={metrics.messages_received.toLocaleString()} />
          <Stat label="Messages parsed" value={metrics.messages_parsed.toLocaleString()} />
          <Stat label="Messages sent" value={metrics.messages_sent.toLocaleString()} />
          <Stat label="Errors" value={metrics.errors.toLocaleString()} />
          <Stat label="Bytes received" value={formatBytes(metrics.bytes_received)} />
          <Stat label="Throughput" value={`${metrics.throughput_msg_per_sec.toFixed(1)} msg/s`} />
          <Stat label="Uptime" value={formatUptime(metrics.elapsed_secs)} />
          <Stat label="Reconnections" value={metrics.reconnection_attempts} />
        </div>
      )}
    </ChatCard>
  );
}
