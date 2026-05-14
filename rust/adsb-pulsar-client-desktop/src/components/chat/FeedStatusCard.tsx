"use client";
/**
 * Chat card rendering feed connection status from getFeedStatus tool call.
 */
import type { StatusResponse, ConnectionStatus } from "@/lib/types";
import { ChatCard } from "./ChatCard";

function statusColor(cs: ConnectionStatus): string {
  switch (cs.status) {
    case "Connected": return "text-green-400";
    case "Connecting": return "text-yellow-400";
    case "Degraded": return "text-orange-400";
    default: return "text-red-400";
  }
}

function statusLabel(cs: ConnectionStatus): string {
  if (cs.status === "Error") return `Error: ${cs.message}`;
  return cs.status;
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function FeedStatusCard({ status, result }: Props) {
  let feed: StatusResponse | null = null;
  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed.is_running === "boolean") {
        feed = parsed;
      }
    } catch { /* ignore */ }
  }

  return (
    <ChatCard title="Feed Status" icon="📡" status={status}>
      {feed && (
        <div className="space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${feed.is_running ? "bg-green-400" : "bg-red-400"}`} />
            <span className="text-slate-200 font-medium">
              {feed.is_running ? "Running" : "Stopped"}
            </span>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">Socket</span>
              <span className={statusColor(feed.socket_status)}>
                {statusLabel(feed.socket_status)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Pulsar</span>
              <span className={statusColor(feed.pulsar_status)}>
                {statusLabel(feed.pulsar_status)}
              </span>
            </div>
          </div>
        </div>
      )}
    </ChatCard>
  );
}
