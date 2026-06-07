"use client";
/**
 * Chat card rendering flight summary table from getFlightSummary tool call.
 */
import type { FlightSummary } from "@/lib/types";
import { ChatCard } from "./ChatCard";

interface TruncatedResult {
  total: number;
  showing: number;
  data: FlightSummary[];
  note: string;
}

function formatDuration(startMs: number, endMs: number): string {
  const secs = Math.floor((endMs - startMs) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function FlightSummaryTable({ status, result }: Props) {
  let flights: FlightSummary[] = [];
  let total = 0;
  let note = "";

  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        flights = parsed;
        total = parsed.length;
      } else {
        const tr = parsed as TruncatedResult;
        flights = tr.data;
        total = tr.total;
        note = tr.note;
      }
    } catch { /* ignore */ }
  }

  return (
    <ChatCard title={`Flights (${total})`} icon="🛫" status={status}>
      {flights.length > 0 && (
        <div className="space-y-1">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700">
                  <th className="text-left py-1 pr-2">Flight</th>
                  <th className="text-left py-1 pr-2">Callsign</th>
                  <th className="text-right py-1 pr-2">Pos</th>
                  <th className="text-right py-1 pr-2">Duration</th>
                  <th className="text-right py-1">Alt range</th>
                </tr>
              </thead>
              <tbody>
                {flights.map((f) => (
                  <tr key={f.flight_id} className="text-slate-200 border-b border-slate-700/50">
                    <td className="py-0.5 pr-2 font-mono text-violet-300">{f.hex_ident}</td>
                    <td className="py-0.5 pr-2">{f.callsign ?? "—"}</td>
                    <td className="py-0.5 pr-2 text-right font-mono">{f.position_count}</td>
                    <td className="py-0.5 pr-2 text-right font-mono">
                      {formatDuration(f.first_seen_ms, f.last_seen_ms)}
                    </td>
                    <td className="py-0.5 text-right font-mono">
                      {f.min_altitude != null && f.max_altitude != null
                        ? `${f.min_altitude.toLocaleString()}–${f.max_altitude.toLocaleString()} ft`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {note && <p className="text-xs text-slate-400 mt-1">{note}</p>}
        </div>
      )}
    </ChatCard>
  );
}
