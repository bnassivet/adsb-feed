"use client";
/**
 * Chat card rendering trajectory data from getTrajectory tool call.
 * Shows a summary of the position history (count, time span, altitude range).
 */
import type { PositionRecord } from "@/lib/types";
import { ChatCard } from "./ChatCard";

interface TruncatedResult {
  total: number;
  showing: number;
  data: PositionRecord[];
  note: string;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function TrajectoryCard({ status, result }: Props) {
  let positions: PositionRecord[] = [];
  let total = 0;
  let note = "";

  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        positions = parsed;
        total = parsed.length;
      } else {
        const tr = parsed as TruncatedResult;
        positions = tr.data;
        total = tr.total;
        note = tr.note;
      }
    } catch { /* ignore */ }
  }

  const altitudes = positions.map((p) => p.altitude).filter((a): a is number => a != null);
  const minAlt = altitudes.length ? Math.min(...altitudes) : null;
  const maxAlt = altitudes.length ? Math.max(...altitudes) : null;
  const firstTs = positions.length ? positions[0].timestamp_ms : null;
  const lastTs = positions.length ? positions[positions.length - 1].timestamp_ms : null;
  const hex = positions.length ? positions[0].hex_ident : "—";

  return (
    <ChatCard title={`Trajectory — ${hex}`} icon="📍" status={status}>
      {positions.length > 0 && (
        <div className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-slate-400">Positions</span>
            <span className="text-slate-100 font-mono">{total.toLocaleString()}</span>
          </div>
          {firstTs && lastTs && (
            <div className="flex justify-between">
              <span className="text-slate-400">Time span</span>
              <span className="text-slate-100 font-mono">
                {formatTime(firstTs)} — {formatTime(lastTs)}
              </span>
            </div>
          )}
          {minAlt != null && maxAlt != null && (
            <div className="flex justify-between">
              <span className="text-slate-400">Altitude</span>
              <span className="text-slate-100 font-mono">
                {minAlt.toLocaleString()} – {maxAlt.toLocaleString()} ft
              </span>
            </div>
          )}
          {note && <p className="text-slate-400 mt-1">{note}</p>}
        </div>
      )}
    </ChatCard>
  );
}
