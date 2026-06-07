"use client";
/**
 * Chat card rendering aircraft summary table from getAircraftSummary tool call.
 */
import type { AircraftSummary } from "@/lib/types";
import { ChatCard } from "./ChatCard";

interface TruncatedResult {
  total: number;
  showing: number;
  data: AircraftSummary[];
  note: string;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function AircraftSummaryTable({ status, result }: Props) {
  let aircraft: AircraftSummary[] = [];
  let total = 0;
  let note = "";

  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        aircraft = parsed;
        total = parsed.length;
      } else {
        const tr = parsed as TruncatedResult;
        aircraft = tr.data;
        total = tr.total;
        note = tr.note;
      }
    } catch { /* ignore */ }
  }

  return (
    <ChatCard title={`Aircraft Summary (${total})`} icon="✈️" status={status}>
      {aircraft.length > 0 && (
        <div className="space-y-1">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700">
                  <th className="text-left py-1 pr-2">Hex</th>
                  <th className="text-left py-1 pr-2">Callsign</th>
                  <th className="text-right py-1 pr-2">Pos</th>
                  <th className="text-right py-1 pr-2">Alt</th>
                  <th className="text-right py-1">Seen</th>
                </tr>
              </thead>
              <tbody>
                {aircraft.map((a) => (
                  <tr key={a.hex_ident} className="text-slate-200 border-b border-slate-700/50">
                    <td className="py-0.5 pr-2 font-mono text-violet-300">{a.hex_ident}</td>
                    <td className="py-0.5 pr-2">{a.callsign ?? "—"}</td>
                    <td className="py-0.5 pr-2 text-right font-mono">{a.position_count}</td>
                    <td className="py-0.5 pr-2 text-right font-mono">
                      {a.min_altitude != null && a.max_altitude != null
                        ? `${a.min_altitude.toLocaleString()}–${a.max_altitude.toLocaleString()} ft`
                        : "—"}
                    </td>
                    <td className="py-0.5 text-right text-slate-400">
                      {formatTime(a.first_seen_ms)}–{formatTime(a.last_seen_ms)}
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
