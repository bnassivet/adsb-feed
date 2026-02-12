"use client";
import type { Filters } from "@/lib/types";

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
  trackCount: number;
  showHistory: boolean;
  onToggleHistory: () => void;
  historyCount: number;
}

export function FiltersPanel({ filters, onChange, trackCount, showHistory, onToggleHistory, historyCount }: Props) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Filters</h3>
      </div>

      {/* Callsign / Hex search */}
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          Callsign / Hex
        </label>
        <input
          type="text"
          value={filters.callsign}
          onChange={(e) => onChange({ ...filters, callsign: e.target.value })}
          placeholder="Search..."
          className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {/* Altitude range */}
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          Altitude: {filters.altitudeMin.toLocaleString()} -{" "}
          {filters.altitudeMax.toLocaleString()} ft
        </label>
        <div className="flex gap-2">
          <input
            type="range"
            min={0}
            max={50000}
            step={1000}
            value={filters.altitudeMin}
            onChange={(e) =>
              onChange({ ...filters, altitudeMin: Number(e.target.value) })
            }
            className="flex-1 accent-blue-500"
          />
          <input
            type="range"
            min={0}
            max={50000}
            step={1000}
            value={filters.altitudeMax}
            onChange={(e) =>
              onChange({ ...filters, altitudeMax: Number(e.target.value) })
            }
            className="flex-1 accent-blue-500"
          />
        </div>
      </div>

      {/* Speed range */}
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          Speed: {filters.speedMin} - {filters.speedMax} kts
        </label>
        <div className="flex gap-2">
          <input
            type="range"
            min={0}
            max={600}
            step={10}
            value={filters.speedMin}
            onChange={(e) =>
              onChange({ ...filters, speedMin: Number(e.target.value) })
            }
            className="flex-1 accent-blue-500"
          />
          <input
            type="range"
            min={0}
            max={600}
            step={10}
            value={filters.speedMax}
            onChange={(e) =>
              onChange({ ...filters, speedMax: Number(e.target.value) })
            }
            className="flex-1 accent-blue-500"
          />
        </div>
      </div>

      {/* Stats */}
      <div className="pt-2 border-t border-slate-700">
        <div className="text-xs text-slate-400">
          Tracking:{" "}
          <span className="text-slate-200 font-mono">{trackCount}</span>{" "}
          aircraft
        </div>
      </div>

      {/* History toggle */}
      <div>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={onToggleHistory}
            className="accent-blue-500"
          />
          <span>
            Show history{" "}
            <span className="text-slate-500 font-mono">({historyCount} past)</span>
          </span>
        </label>
      </div>
    </div>
  );
}
