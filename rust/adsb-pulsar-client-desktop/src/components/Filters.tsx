"use client";
import type { Filters, DensityMetric, AltitudeColorMode } from "@/lib/types";

interface Props {
  filters: Filters;
  onChange: (filters: Filters) => void;
  trackCount: number;
  showHistory: boolean;
  onToggleHistory: () => void;
  historyCount: number;
  showDensity: boolean;
  onToggleDensity: () => void;
  densityMetric: DensityMetric;
  onDensityMetricChange: (metric: DensityMetric) => void;
  showSimulation: boolean;
  onToggleSimulation: () => void;
  simulationCount: number;
  liveColorMode: AltitudeColorMode;
  onLiveColorModeChange: (mode: AltitudeColorMode) => void;
  historyColorMode: AltitudeColorMode;
  onHistoryColorModeChange: (mode: AltitudeColorMode) => void;
  importedCount: number;
  showImported: boolean;
  onToggleImported: () => void;
  onClearImported: () => void;
}

export function FiltersPanel({ filters, onChange, trackCount, showHistory, onToggleHistory, historyCount, showDensity, onToggleDensity, densityMetric, onDensityMetricChange, showSimulation, onToggleSimulation, simulationCount, liveColorMode, onLiveColorModeChange, historyColorMode, onHistoryColorModeChange, importedCount, showImported, onToggleImported, onClearImported }: Props) {
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

      {/* Imported overlay toggle — only visible when imported tracks exist */}
      {importedCount > 0 && (
        <div>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showImported}
              onChange={onToggleImported}
              className="accent-indigo-500"
            />
            <span>
              Show imported{" "}
              <span className="text-indigo-400/60 font-mono">({importedCount})</span>
            </span>
          </label>
          <button
            onClick={onClearImported}
            className="mt-1 ml-5 text-[10px] text-slate-500 hover:text-red-400 transition"
          >
            Clear
          </button>
        </div>
      )}

      {/* Density overlay */}
      <div>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showDensity}
            onChange={onToggleDensity}
            className="accent-purple-500"
          />
          <span>H3 density heatmap</span>
        </label>
        {showDensity && (
          <div className="ml-5 mt-1 flex flex-col gap-1">
            <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
              <input
                type="radio"
                name="density-metric"
                checked={densityMetric === "positions"}
                onChange={() => onDensityMetricChange("positions")}
                className="accent-purple-500"
              />
              Position count
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
              <input
                type="radio"
                name="density-metric"
                checked={densityMetric === "aircraft"}
                onChange={() => onDensityMetricChange("aircraft")}
                className="accent-purple-500"
              />
              Unique aircraft
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
              <input
                type="radio"
                name="density-metric"
                checked={densityMetric === "altitude"}
                onChange={() => onDensityMetricChange("altitude")}
                className="accent-purple-500"
              />
              Mean altitude
            </label>
          </div>
        )}
      </div>

      {/* Color coding */}
      <div>
        <h4 className="text-xs font-semibold text-slate-400 mb-1.5">Color coding</h4>
        <div className="flex flex-col gap-1.5">
          <div>
            <label htmlFor="live-color-mode" className="block text-xs text-slate-500 mb-0.5">Live tracks</label>
            <select
              id="live-color-mode"
              value={liveColorMode}
              onChange={(e) => onLiveColorModeChange(e.target.value as AltitudeColorMode)}
              className="w-full px-2 py-1 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200"
            >
              <option value="track">Track altitude (latest)</option>
              <option value="plot">Plot altitude (per position)</option>
            </select>
          </div>
          <div>
            <label htmlFor="history-color-mode" className="block text-xs text-slate-500 mb-0.5">History tracks</label>
            <select
              id="history-color-mode"
              value={historyColorMode}
              onChange={(e) => onHistoryColorModeChange(e.target.value as AltitudeColorMode)}
              className="w-full px-2 py-1 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200"
            >
              <option value="track">Track altitude (latest)</option>
              <option value="plot">Plot altitude (per position)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Simulation toggle */}
      <div>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showSimulation}
            onChange={onToggleSimulation}
            className="accent-emerald-500"
          />
          <span>
            Demo flights{" "}
            {showSimulation && (
              <span className="text-slate-500 font-mono">({simulationCount} sim)</span>
            )}
          </span>
        </label>
      </div>
    </div>
  );
}
