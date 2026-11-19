"use client";
import { ageMinutes, formatAge, type CategoryCount, type CategoryKey } from "@/lib/metar";
import { ChecklistCombo } from "./ChecklistCombo";

export interface MetarControlsProps {
  show: boolean;
  onToggle: () => void;
  /** Stations drawn (after the category filter). */
  count: number;
  fetchedAtMs: number | null;
  /** Minute-resolution clock for the snapshot's age. */
  nowMs: number;
  /** The last refresh failed; the reports shown are the previous ones. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  /** Ask again now. */
  onReload: () => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  showHoverInfo: boolean;
  onToggleHoverInfo: () => void;
  /** Categories present near the receiver (before the filter). */
  categories: CategoryCount[];
  hiddenCategories: CategoryKey[];
  onHiddenCategoriesChange: (hidden: CategoryKey[]) => void;
}

/** The Filters panel's METAR section, laid out like the airspace one. */
export function MetarControls(p: MetarControlsProps) {
  const percent = Math.round(p.opacity * 100);
  const age = p.fetchedAtMs != null ? formatAge(ageMinutes(p.fetchedAtMs, p.nowMs)) : null;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
        <input type="checkbox" checked={p.show} onChange={p.onToggle} className="accent-emerald-500" />
        <span>METAR stations</span>
      </label>
      {p.show && (
        <div className="ml-5 flex flex-col gap-1 text-[11px] text-slate-500">
          <label className="flex items-center gap-2">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={percent}
              onChange={(e) => p.onOpacityChange(Number(e.target.value) / 100)}
              aria-label="METAR opacity"
              className="flex-1 accent-emerald-500"
            />
            <span className="w-8 text-right tabular-nums">{percent}%</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={p.showHoverInfo} onChange={p.onToggleHoverInfo} className="accent-emerald-500" />
            <span>Info on hover</span>
          </label>
          {p.categories.length > 0 && (
            <ChecklistCombo
              label="Flight categories"
              noun="categories"
              options={p.categories}
              hidden={p.hiddenCategories}
              onHiddenChange={p.onHiddenCategoriesChange}
            />
          )}
          <div className="flex items-center justify-between gap-2">
            {p.loading ? (
              <span>Loading…</span>
            ) : (
              <span>
                {p.count} stations{age && ` · updated ${age}`}
              </span>
            )}
            {!p.loading && !p.error && (
              <button type="button" onClick={p.onReload} className="text-sky-400 hover:underline">
                Refresh
              </button>
            )}
          </div>
          {p.stale && age && (
            <p role="alert" className="text-amber-400">
              Refresh failed: showing reports downloaded {age}.
            </p>
          )}
          {p.error && (
            <>
              <p className="text-red-400 break-words">{p.error}</p>
              <button type="button" onClick={p.onReload} className="self-start text-sky-400 hover:underline">
                Retry
              </button>
            </>
          )}
          <span className="text-[10px] text-slate-600">
            METAR:{" "}
            <a href="https://aviationweather.gov" target="_blank" rel="noreferrer" className="hover:underline">
              AviationWeather.gov
            </a>{" "}
            (NOAA)
          </span>
        </div>
      )}
    </div>
  );
}
