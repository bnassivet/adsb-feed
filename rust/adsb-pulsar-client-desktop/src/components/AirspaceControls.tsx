"use client";
import { useState } from "react";
import type { AirspaceStatus, AirspaceTypeCount } from "@/lib/airspace";

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
  /** Slider, 0–1: scales outlines and fills (fills are halved again at night). */
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  /** List the airspaces under the cursor in a box on the map. */
  showHoverInfo: boolean;
  onToggleHoverInfo: () => void;
  /** Types present near the receiver, with counts (before the type filter). */
  types: AirspaceTypeCount[];
  /**
   * Types the user hid. May name types absent from `types`: a choice made
   * elsewhere is kept until it is undone, not dropped when the data changes.
   */
  hiddenTypes: number[];
  onHiddenTypesChange: (hidden: number[]) => void;
}

const sorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);

/** A combo of checkboxes: the closed button summarises, the open list edits. */
function TypeFilter({ types, hiddenTypes, onHiddenTypesChange }: Pick<AirspaceControlsProps, "types" | "hiddenTypes" | "onHiddenTypesChange">) {
  const [open, setOpen] = useState(false);
  const hidden = new Set(hiddenTypes);
  const present = types.map((t) => t.type);
  const shown = types.filter((t) => !hidden.has(t.type)).length;
  const summary = shown === types.length ? "All types" : `${shown} of ${types.length} types`;
  const toggle = (type: number) =>
    onHiddenTypesChange(hidden.has(type) ? hiddenTypes.filter((t) => t !== type) : sorted([...hiddenTypes, type]));
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-label={`Area types: ${summary}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-left text-slate-300 hover:border-slate-500"
      >
        <span>{summary}</span>
        <span className="text-[9px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 rounded border border-slate-700 bg-slate-900 p-1.5">
          <div className="mb-0.5 flex gap-2">
            <button type="button" onClick={() => onHiddenTypesChange(hiddenTypes.filter((t) => !present.includes(t)))} className="text-sky-400 hover:underline">
              All
            </button>
            <button type="button" onClick={() => onHiddenTypesChange(sorted([...hiddenTypes, ...present]))} className="text-sky-400 hover:underline">
              None
            </button>
          </div>
          {types.map((t) => (
            <label key={t.type} className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={!hidden.has(t.type)} onChange={() => toggle(t.type)} className="accent-indigo-500" />
              <span>{`${t.label} (${t.count})`}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The Filters panel's airspace section. The AIRAC cycle is always shown, and
 * an expired cycle is an alert rather than a footnote: outdated airspace is a
 * safety issue, not a cosmetic one.
 */
export function AirspaceControls({ show, onToggle, count, status, loading, error, onReload, opacity, onOpacityChange, showHoverInfo, onToggleHoverInfo, types, hiddenTypes, onHiddenTypesChange }: AirspaceControlsProps) {
  const percent = Math.round(opacity * 100);
  const problems = error ? [error, ...status.errors] : status.errors;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
        <input type="checkbox" checked={show} onChange={onToggle} className="accent-indigo-500" />
        <span>Airspaces (OpenAIP)</span>
      </label>
      {show && (
        <div className="ml-5 flex flex-col gap-1 text-[11px] text-slate-500">
          <label className="flex items-center gap-2">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={percent}
              onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
              aria-label="Airspace opacity"
              className="flex-1 accent-indigo-500"
            />
            <span className="w-8 text-right tabular-nums">{percent}%</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={showHoverInfo} onChange={onToggleHoverInfo} className="accent-indigo-500" />
            <span>Info on hover</span>
          </label>
          {types.length > 0 && <TypeFilter types={types} hiddenTypes={hiddenTypes} onHiddenTypesChange={onHiddenTypesChange} />}
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
