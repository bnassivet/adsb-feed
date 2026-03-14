"use client";
import type { MetricsWithRates } from "@/hooks/useMetrics";
import type { StorageAvailability } from "@/lib/types";
import { formatBytes } from "@/lib/format";

interface Props {
  metrics: MetricsWithRates;
  recordPositions?: boolean;
  recordRaw?: boolean;
  onToggleRecordPositions?: () => void;
  onToggleRecordRaw?: () => void;
  storageStatus?: StorageAvailability;
  onReleaseStorage?: () => void;
  onReclaimStorage?: () => void;
  onExportDatabase?: () => void;
  isExporting?: boolean;
}

export function MetricsBar({
  metrics, recordPositions, recordRaw, onToggleRecordPositions, onToggleRecordRaw,
  storageStatus, onReleaseStorage, onReclaimStorage, onExportDatabase, isExporting,
}: Props) {
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
      {storageStatus === "available" && (
        <button
          onClick={onReleaseStorage}
          className="flex items-center gap-1 hover:text-slate-200 transition cursor-pointer"
          title="Release DB connection — allows external tools to access the database file"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.5 1a3.5 3.5 0 0 0-3.5 3.5V7h-5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H9V4.5a2.5 2.5 0 0 1 5 0v1a.5.5 0 0 0 1 0v-1A3.5 3.5 0 0 0 11.5 1z" />
          </svg>
          <span className="font-mono text-slate-400">DB</span>
        </button>
      )}
      {storageStatus === "released" && (
        <button
          onClick={onReclaimStorage}
          className="flex items-center gap-1 hover:text-amber-200 transition cursor-pointer"
          title="Reclaim DB connection — reopen the database for recording and queries"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-amber-400">
            <path d="M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2zm3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
          </svg>
          <span className="font-mono text-amber-400">DB Released</span>
        </button>
      )}
      {storageStatus === "available" && (
        <button
          onClick={onExportDatabase}
          disabled={isExporting}
          className={`flex items-center gap-1 transition cursor-pointer ${isExporting ? "text-slate-600 cursor-wait" : "hover:text-slate-200"}`}
          title="Export database to file — recording continues during export"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z" />
            <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z" />
          </svg>
          <span className="font-mono">{isExporting ? "Exporting..." : "Export DB"}</span>
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
