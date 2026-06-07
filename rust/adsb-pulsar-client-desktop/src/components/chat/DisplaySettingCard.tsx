"use client";
/**
 * Chat card rendering display setting changes from UI control tool calls.
 * Parses JSON result and renders key-value pairs showing what changed.
 */
import { ChatCard } from "./ChatCard";

interface Props {
  setting: string;
  status: "in_progress" | "executing" | "complete";
  result?: string;
}

/** Format a value for display: booleans as on/off, strings as-is. */
function formatValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

export function DisplaySettingCard({ setting, status, result }: Props) {
  let entries: [string, unknown][] = [];
  if (status === "complete" && result) {
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed === "object" && parsed !== null) {
        entries = Object.entries(parsed);
      }
    } catch { /* ignore */ }
  }

  return (
    <ChatCard title={setting} icon="⚙️" status={status}>
      {entries.length > 0 && (
        <div className="space-y-1 text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="flex justify-between gap-2">
              <span className="text-slate-400">{key}</span>
              <span className="text-green-300 font-medium">{formatValue(value)}</span>
            </div>
          ))}
        </div>
      )}
    </ChatCard>
  );
}
