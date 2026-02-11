"use client";
import type { ConnectionStatus as CS } from "@/lib/types";

function statusColor(s: CS): string {
  switch (s.status) {
    case "Connected":
      return "bg-green-500";
    case "Connecting":
      return "bg-yellow-500 animate-pulse";
    case "Disconnected":
      return "bg-gray-500";
    case "Degraded":
      return "bg-orange-500 animate-pulse";
    case "ConnectionLost":
      return "bg-red-500";
    case "Error":
      return "bg-red-500";
  }
}

function statusLabel(s: CS): string {
  switch (s.status) {
    case "ConnectionLost":
      return "Connection Lost";
    case "Error":
      return `Error: ${s.message}`;
    default:
      return s.status;
  }
}

interface Props {
  label: string;
  status: CS;
}

export function ConnectionStatusIndicator({ label, status }: Props) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <div className={`w-2.5 h-2.5 rounded-full ${statusColor(status)}`} />
      <span className="text-slate-400">{label}:</span>
      <span className="text-slate-200">{statusLabel(status)}</span>
    </div>
  );
}
