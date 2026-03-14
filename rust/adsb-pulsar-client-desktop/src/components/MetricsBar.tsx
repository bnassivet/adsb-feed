"use client";
import type { MetricsWithRates } from "@/hooks/useMetrics";
import { formatBytes } from "@/lib/format";

interface Props {
  metrics: MetricsWithRates;
  recordPositions?: boolean;
  recordRaw?: boolean;
  onToggleRecordPositions?: () => void;
  onToggleRecordRaw?: () => void;
}

export function MetricsBar({ metrics, recordPositions, recordRaw, onToggleRecordPositions, onToggleRecordRaw }: Props) {
  return (
    <div className="flex items-center gap-6 px-4 py-2 bg-slate-900 border-t border-slate-700 text-xs text-slate-400">
      <span>
        <span className="text-slate-500">hits/s:</span>{" "}
        <span className="text-slate-200 font-mono">
          {metrics.hits_per_sec.toFixed(1)}
        </span>
      </span>
      <span>
        <span className="text-slate-500">msgs/s:</span>{" "}
        <span className="text-slate-200 font-mono">
          {metrics.throughput_msg_per_sec.toFixed(1)}
        </span>
      </span>
      <span>
        <span className="text-slate-500">sent:</span>{" "}
        <span className="text-slate-200 font-mono">
          {metrics.messages_sent.toLocaleString()}
        </span>
      </span>
      <span>
        <span className="text-slate-500">recv:</span>{" "}
        <span className="text-slate-200 font-mono">
          {formatBytes(metrics.bytes_received)}
        </span>
      </span>
      <span>
        <span className="text-slate-500">errors:</span>{" "}
        <span
          className={`font-mono ${metrics.errors > 0 ? "text-red-400" : "text-slate-200"}`}
        >
          {metrics.errors}
        </span>
      </span>
      <span>
        <span className="text-slate-500">queue:</span>{" "}
        <span
          className={`font-mono ${metrics.retry_queue_size > 0 ? "text-yellow-400" : "text-slate-200"}`}
        >
          {metrics.retry_queue_size}
        </span>
      </span>
      <span>
        <span className="text-slate-500">uptime:</span>{" "}
        <span className="text-slate-200 font-mono">
          {formatUptime(metrics.elapsed_secs)}
        </span>
      </span>
      {recordPositions !== undefined && (
        <button
          onClick={onToggleRecordPositions}
          className="flex items-center gap-1 hover:text-slate-200 transition cursor-pointer"
          title={recordPositions ? "Recording positions — click to pause" : "Positions recording paused — click to resume"}
        >
          <span className={`inline-block w-2 h-2 rounded-full ${recordPositions ? "bg-red-500" : "bg-slate-600"}`} />
          <span className={`font-mono ${recordPositions ? "text-red-400" : "text-slate-600"}`}>
            REC Pos
          </span>
        </button>
      )}
      {recordRaw !== undefined && (
        <button
          onClick={onToggleRecordRaw}
          className="flex items-center gap-1 hover:text-slate-200 transition cursor-pointer"
          title={recordRaw ? "Recording raw messages — click to pause" : "Raw recording paused — click to resume"}
        >
          <span className={`inline-block w-2 h-2 rounded-full ${recordRaw ? "bg-red-500" : "bg-slate-600"}`} />
          <span className={`font-mono ${recordRaw ? "text-red-400" : "text-slate-600"}`}>
            REC Raw
          </span>
        </button>
      )}
    </div>
  );
}

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}
