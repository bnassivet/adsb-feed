"use client";
import type { Filters, DensityMetric, DensityTooltipMode, AltitudeColorMode, EventFilterMode } from "@/lib/types";
import { RangeSlider } from "@/components/RangeSlider";
import type { ReactNode } from "react";

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
  densityAltitudeMin: number;
  densityAltitudeMax: number;
  onDensityAltitudeChange: (min: number, max: number) => void;
  densityTooltipMode: DensityTooltipMode;
  onDensityTooltipModeChange: (mode: DensityTooltipMode) => void;
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
  includeImportedInDensity: boolean;
  onToggleIncludeImportedInDensity: () => void;
  showReceiver: boolean;
  onToggleReceiver: () => void;
  hasReceiverLocation: boolean;
  historySliderMin: number;
  historySliderMax: number;
  historySliderRange: number;
  onHistoryTimeChange: (min: number, max: number) => void;
  showEvents: boolean;
  onToggleEvents: () => void;
  eventsCount: number;
  eventFilterMode: EventFilterMode;
  onEventFilterModeChange: (mode: EventFilterMode) => void;
  eventUpcomingDays: number;
  onEventUpcomingDaysChange: (days: number) => void;
  eventTimeRangeStart: number;
  eventTimeRangeEnd: number;
  onEventTimeRangeChange: (startMs: number, endMs: number) => void;
}

function msToDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Section({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen || undefined} className="group border-t border-slate-700 pt-2">
      <summary className="flex items-center gap-1.5 cursor-pointer select-none text-xs font-semibold text-slate-400 list-none [&::-webkit-details-marker]:hidden">
        <span className="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
        {title}
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {children}
      </div>
    </details>
  );
}

export function FiltersPanel({ filters, onChange, trackCount, showHistory, onToggleHistory, historyCount, showDensity, onToggleDensity, densityMetric, onDensityMetricChange, densityAltitudeMin, densityAltitudeMax, onDensityAltitudeChange, densityTooltipMode, onDensityTooltipModeChange, showSimulation, onToggleSimulation, simulationCount, liveColorMode, onLiveColorModeChange, historyColorMode, onHistoryColorModeChange, importedCount, showImported, onToggleImported, onClearImported, includeImportedInDensity, onToggleIncludeImportedInDensity, showReceiver, onToggleReceiver, hasReceiverLocation, historySliderMin, historySliderMax, historySliderRange, onHistoryTimeChange, showEvents, onToggleEvents, eventsCount, eventFilterMode, onEventFilterModeChange, eventUpcomingDays, onEventUpcomingDaysChange, eventTimeRangeStart, eventTimeRangeEnd, onEventTimeRangeChange }: Props) {
  return (
    <div className="flex flex-col gap-2 p-4">

      {/* ── Search & Filters ── */}
      <Section title="Search & Filters" defaultOpen>
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Callsign / Hex
          </label>
          <input
            type="text"
            value={filters.callsign}
            onChange={(e) => onChange({ ...filters, callsign: e.target.value })}
            placeholder="Search... (comma-separated)"
            className="w-full px-2 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-slate-200 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <RangeSlider
          min={0}
          max={50000}
          step={1000}
          valueMin={filters.altitudeMin}
          valueMax={filters.altitudeMax}
          onChange={(lo, hi) => onChange({ ...filters, altitudeMin: lo, altitudeMax: hi })}
          formatLabel={(v) => `${v.toLocaleString()} ft`}
        />

        <RangeSlider
          min={0}
          max={600}
          step={10}
          valueMin={filters.speedMin}
          valueMax={filters.speedMax}
          onChange={(lo, hi) => onChange({ ...filters, speedMin: lo, speedMax: hi })}
          formatLabel={(v) => `${v} kts`}
        />

        {importedCount > 0 && (
          <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filters.includeImportedInFilter}
              onChange={() =>
                onChange({
                  ...filters,
                  includeImportedInFilter: !filters.includeImportedInFilter,
                })
              }
              className="accent-indigo-500"
            />
            Include Imported in filters
          </label>
        )}

        <div className="text-xs text-slate-400">
          Tracking:{" "}
          <span className="text-slate-200 font-mono">{trackCount}</span>{" "}
          aircraft
        </div>
      </Section>

      {/* ── Display Layers ── */}
      <Section title="Display Layers" defaultOpen>
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
          {showHistory && historySliderRange > 0 && (
            <div className="ml-5 mt-1">
              <RangeSlider
                min={0}
                max={historySliderRange}
                step={1}
                valueMin={historySliderMin}
                valueMax={historySliderMax}
                onChange={onHistoryTimeChange}
                formatLabel={(v) =>
                  v >= historySliderRange ? "now" : `${historySliderRange - v}h ago`
                }
              />
            </div>
          )}
        </div>

        {hasReceiverLocation && (
          <div>
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showReceiver}
                onChange={onToggleReceiver}
                className="accent-pink-500"
              />
              <span>Show receiver</span>
            </label>
          </div>
        )}

        <div>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showEvents}
              onChange={onToggleEvents}
              className="accent-amber-500"
            />
            <span>
              Show events{" "}
              <span className="text-slate-500 font-mono">({eventsCount})</span>
            </span>
          </label>
          {showEvents && (
            <div className="ml-5 mt-1 flex flex-col gap-1">
              <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                <input
                  type="radio"
                  name="event-filter-mode"
                  checked={eventFilterMode === "all"}
                  onChange={() => onEventFilterModeChange("all")}
                  className="accent-amber-500"
                />
                All events
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                <input
                  type="radio"
                  name="event-filter-mode"
                  checked={eventFilterMode === "upcoming"}
                  onChange={() => onEventFilterModeChange("upcoming")}
                  className="accent-amber-500"
                />
                Upcoming
              </label>
              {eventFilterMode === "upcoming" && (
                <div className="ml-5 flex items-center gap-1.5 text-xs text-slate-500">
                  <span>Next</span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={eventUpcomingDays}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v >= 1) onEventUpcomingDaysChange(v);
                    }}
                    className="w-14 px-1.5 py-0.5 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200 text-center"
                  />
                  <span>days</span>
                </div>
              )}
              <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                <input
                  type="radio"
                  name="event-filter-mode"
                  checked={eventFilterMode === "range"}
                  onChange={() => onEventFilterModeChange("range")}
                  className="accent-amber-500"
                />
                Time range
              </label>
              {eventFilterMode === "range" && (
                <div className="ml-5 mt-1 flex flex-col gap-1">
                  <input
                    type="datetime-local"
                    className="w-full px-2 py-1 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200"
                    value={msToDatetimeLocal(eventTimeRangeStart)}
                    onChange={(e) => onEventTimeRangeChange(new Date(e.target.value).getTime(), eventTimeRangeEnd)}
                  />
                  <input
                    type="datetime-local"
                    className="w-full px-2 py-1 bg-slate-700 border border-slate-600 rounded text-xs text-slate-200"
                    value={msToDatetimeLocal(eventTimeRangeEnd)}
                    onChange={(e) => onEventTimeRangeChange(eventTimeRangeStart, new Date(e.target.value).getTime())}
                  />
                </div>
              )}
            </div>
          )}
        </div>

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
      </Section>

      {/* ── Density Overlay ── */}
      <Section title="Density Overlay">
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
              <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                <input
                  type="radio"
                  name="density-metric"
                  checked={densityMetric === "altitude_min"}
                  onChange={() => onDensityMetricChange("altitude_min")}
                  className="accent-purple-500"
                />
                Min altitude
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                <input
                  type="radio"
                  name="density-metric"
                  checked={densityMetric === "altitude_max"}
                  onChange={() => onDensityMetricChange("altitude_max")}
                  className="accent-purple-500"
                />
                Max altitude
              </label>
              <div className="mt-1 pt-1 border-t border-slate-700/50">
                <RangeSlider
                  min={0}
                  max={50000}
                  step={1000}
                  valueMin={densityAltitudeMin}
                  valueMax={densityAltitudeMax}
                  onChange={onDensityAltitudeChange}
                  formatLabel={(v) => `${v.toLocaleString()} ft`}
                />
              </div>
              <div className="mt-1 pt-1 border-t border-slate-700/50 flex items-center gap-2">
                <span className="text-[10px] text-slate-500">Tooltip:</span>
                <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer">
                  <input
                    type="radio"
                    name="density-tooltip-mode"
                    checked={densityTooltipMode === "compact"}
                    onChange={() => onDensityTooltipModeChange("compact")}
                    className="accent-purple-500"
                  />
                  Compact
                </label>
                <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer">
                  <input
                    type="radio"
                    name="density-tooltip-mode"
                    checked={densityTooltipMode === "extended"}
                    onChange={() => onDensityTooltipModeChange("extended")}
                    className="accent-purple-500"
                  />
                  Extended
                </label>
              </div>
              {importedCount > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer mt-1 pt-1 border-t border-slate-700/50">
                  <input
                    type="checkbox"
                    checked={includeImportedInDensity}
                    onChange={onToggleIncludeImportedInDensity}
                    className="accent-purple-500"
                  />
                  Include imported
                </label>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* ── Simulation ── */}
      <Section title="Simulation">
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
      </Section>

    </div>
  );
}
