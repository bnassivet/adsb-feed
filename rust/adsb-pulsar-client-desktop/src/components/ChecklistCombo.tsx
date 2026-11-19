"use client";
import { useState } from "react";

export interface ChecklistOption<K> {
  value: K;
  label: string;
  count: number;
}

export interface ChecklistComboProps<K extends string | number> {
  /** Names the button for assistive tech, e.g. "Area types". */
  label: string;
  /** Plural used in the summary, e.g. "types" → "2 of 3 types". */
  noun: string;
  options: ChecklistOption<K>[];
  /**
   * Hidden values. May name values absent from `options`: a choice made
   * elsewhere is kept until it is undone, not dropped when the data changes.
   */
  hidden: K[];
  onHiddenChange: (hidden: K[]) => void;
}

const compare = <K extends string | number>(a: K, b: K) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <K extends string | number>(xs: Iterable<K>) => [...new Set(xs)].sort(compare);

/**
 * A combo of checkboxes: the closed button summarises, the open list edits.
 * Stores what is *hidden*, so values that appear later are shown by default.
 */
export function ChecklistCombo<K extends string | number>({ label, noun, options, hidden, onHiddenChange }: ChecklistComboProps<K>) {
  const [open, setOpen] = useState(false);
  const hiddenSet = new Set<K>(hidden);
  const present = options.map((o) => o.value);
  const shown = options.filter((o) => !hiddenSet.has(o.value)).length;
  const summary = shown === options.length ? `All ${noun}` : `${shown} of ${options.length} ${noun}`;
  const toggle = (v: K) => onHiddenChange(hiddenSet.has(v) ? hidden.filter((h) => h !== v) : sorted([...hidden, v]));
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-label={`${label}: ${summary}`}
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
            <button type="button" onClick={() => onHiddenChange(hidden.filter((h) => !present.includes(h)))} className="text-sky-400 hover:underline">
              All
            </button>
            <button type="button" onClick={() => onHiddenChange(sorted([...hidden, ...present]))} className="text-sky-400 hover:underline">
              None
            </button>
          </div>
          {options.map((o) => (
            <label key={String(o.value)} className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={!hiddenSet.has(o.value)} onChange={() => toggle(o.value)} className="accent-indigo-500" />
              <span>{`${o.label} (${o.count})`}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
