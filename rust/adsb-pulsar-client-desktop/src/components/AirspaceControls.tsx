"use client";
import type { AirspaceStatus } from "@/lib/airspace";

export interface AirspaceControlsProps {
  /** Whether the airspace layer is drawn. */
  show: boolean;
  onToggle: () => void;
  /** Airspaces drawn (near the receiver, administrative areas left out). */
  count: number;
  status: AirspaceStatus;
  loading: boolean;
  /** The command itself failed. */
  error: string | null;
  onReload: () => void;
}

/**
 * The Filters panel's airspace section. The AIRAC cycle is always shown, and
 * an expired cycle is an alert rather than a footnote: outdated airspace is a
 * safety issue, not a cosmetic one.
 */
export function AirspaceControls({ show, onToggle, count, status, loading, error, onReload }: AirspaceControlsProps) {
  const problems = error ? [error, ...status.errors] : status.errors;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
        <input type="checkbox" checked={show} onChange={onToggle} className="accent-indigo-500" />
        <span>Airspaces (OpenAIP)</span>
      </label>
      {show && (
        <div className="ml-5 flex flex-col gap-1 text-[11px] text-slate-500">
          {loading ? (
            <span>Loading…</span>
          ) : (
            <span>
              {count} airspaces
              {status.cycles.length > 0 && ` · AIRAC ${status.cycles.join(", ")}`}
            </span>
          )}
          {status.expired && (
            <p role="alert" className="text-amber-400">
              Cycle expired: airspace may have changed. Do not rely on it.
            </p>
          )}
          {problems.map((p) => (
            <p key={p} className="text-red-400 break-words">
              {p}
            </p>
          ))}
          {problems.length > 0 && !loading && (
            <button type="button" onClick={onReload} className="self-start text-sky-400 hover:underline">
              Retry
            </button>
          )}
          <span className="text-[10px] text-slate-600">
            Airspaces ©{" "}
            <a href="https://www.openaip.net" target="_blank" rel="noreferrer" className="hover:underline">
              openAIP
            </a>{" "}
            (CC BY-NC-SA 4.0)
          </span>
        </div>
      )}
    </div>
  );
}
