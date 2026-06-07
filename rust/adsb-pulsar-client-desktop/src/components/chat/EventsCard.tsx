"use client";
/**
 * Chat card rendering events of interest from getEventsOfInterest tool call.
 */
import type { EventOfInterest } from "@/lib/types";
import { ChatCard } from "./ChatCard";

interface TruncatedResult {
  total: number;
  showing: number;
  data: EventOfInterest[];
  note: string;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface Props {
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

export function EventsCard({ status, result }: Props) {
  let events: EventOfInterest[] = [];
  let total = 0;
  let note = "";

  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        events = parsed;
        total = parsed.length;
      } else {
        const tr = parsed as TruncatedResult;
        events = tr.data;
        total = tr.total;
        note = tr.note;
      }
    } catch { /* ignore */ }
  }

  return (
    <ChatCard title={`Events (${total})`} icon="📌" status={status}>
      {events.length > 0 && (
        <div className="space-y-1">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700">
                  <th className="text-left py-1 pr-2">Title</th>
                  <th className="text-left py-1 pr-2">Category</th>
                  <th className="text-right py-1">Time</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="text-slate-200 border-b border-slate-700/50">
                    <td className="py-0.5 pr-2 font-medium text-violet-300">{e.title}</td>
                    <td className="py-0.5 pr-2 text-slate-400">{e.category ?? "—"}</td>
                    <td className="py-0.5 text-right text-slate-400">
                      {formatTime(e.timestamp_ms)}
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
