"use client";
import { useState, useCallback, useMemo } from "react";
import { Map } from "@/components/Map";
import { AircraftTable } from "@/components/AircraftTable";
import { MetricsBar } from "@/components/MetricsBar";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatus";
import { FiltersPanel } from "@/components/Filters";
import { ResizeHandle } from "@/components/ResizeHandle";
import { useAircraftTracks } from "@/hooks/useAircraftTracks";
import { useMetrics } from "@/hooks/useMetrics";
import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { startFeed, stopFeed } from "@/lib/commands";
import { DEFAULT_FILTERS } from "@/lib/types";
import type { Filters, DensityMetric } from "@/lib/types";
import Link from "next/link";

const MIN_TABLE_HEIGHT = 150;
const MAX_TABLE_HEIGHT_VH = 0.5; // 50vh

export default function Dashboard() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [error, setError] = useState<string | null>(null);
  const [mapTheme, setMapTheme] = useLocalStorage<"light" | "dark">("adsb-map-theme", "dark");
  const [tableHeight, setTableHeight] = useLocalStorage<number>("adsb-table-height", 256);
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>("adsb-sidebar-open", true);
  const [trajectoryStyle] = useLocalStorage<"line" | "dots">("adsb-trajectory-style", "line");
  const [showHistory, setShowHistory] = useLocalStorage<boolean>("adsb-show-history", false);
  const [showDensity, setShowDensity] = useLocalStorage<boolean>("adsb-show-density", false);
  const [densityMetric, setDensityMetric] = useLocalStorage<DensityMetric>("adsb-density-metric", "positions");

  const { tracks, history } = useAircraftTracks(filters);
  const metrics = useMetrics();
  const status = useConnectionStatus();
  const isRunning = status.is_running;

  const visibleHistory = showHistory ? history : [];
  const densityTracks = useMemo(
    () => (showDensity ? [...tracks, ...history] : []),
    [showDensity, tracks, history],
  );

  function handleToggleTheme() {
    setMapTheme(mapTheme === "dark" ? "light" : "dark");
  }

  function handleToggleHistory() {
    setShowHistory((prev: boolean) => !prev);
  }

  function handleToggleDensity() {
    setShowDensity((prev: boolean) => !prev);
  }

  const handleResize = useCallback(
    (deltaY: number) => {
      setTableHeight((prev: number) => {
        const maxH = typeof window !== "undefined" ? window.innerHeight * MAX_TABLE_HEIGHT_VH : 500;
        return Math.max(MIN_TABLE_HEIGHT, Math.min(maxH, prev - deltaY));
      });
    },
    [setTableHeight],
  );

  const handleResizeEnd = useCallback(() => {
    // Value already persisted via useLocalStorage setter
  }, []);

  async function handleStart() {
    try {
      setError(null);
      await startFeed();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStop() {
    try {
      setError(null);
      await stopFeed();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Header bar */}
      <header className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-700">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-slate-200">
            ADS-B Aircraft Tracker
          </h1>
          <ConnectionStatusIndicator
            label="Socket"
            status={status.socket_status}
          />
          <ConnectionStatusIndicator
            label="Pulsar"
            status={status.pulsar_status}
          />
          <button
            onClick={() => setSidebarOpen((prev: boolean) => !prev)}
            className="p-1 rounded hover:bg-slate-700 transition text-slate-400 hover:text-slate-200"
            title={sidebarOpen ? "Hide filters panel" : "Show filters panel"}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="2" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <line x1="6" y1="2" x2="6" y2="16" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-xs text-red-400 max-w-xs truncate">
              {error}
            </span>
          )}
          {isRunning ? (
            <button
              onClick={handleStop}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleStart}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition"
            >
              Start
            </button>
          )}
          <Link
            href="/settings"
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
          >
            Settings
          </Link>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="w-56 bg-slate-900 border-r border-slate-700 overflow-y-auto flex-shrink-0">
            <FiltersPanel
              filters={filters}
              onChange={setFilters}
              trackCount={tracks.length}
              showHistory={showHistory}
              onToggleHistory={handleToggleHistory}
              historyCount={history.length}
              showDensity={showDensity}
              onToggleDensity={handleToggleDensity}
              densityMetric={densityMetric}
              onDensityMetricChange={setDensityMetric}
            />
          </aside>
        )}

        {/* Map + Table */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Map — takes remaining space */}
          <div className="flex-1 min-h-0">
            <Map tracks={tracks} historyTracks={visibleHistory} mapTheme={mapTheme} onToggleTheme={handleToggleTheme} trajectoryStyle={trajectoryStyle} densityTracks={densityTracks} densityMetric={densityMetric} showDensity={showDensity} />
          </div>

          {/* Resize handle */}
          <ResizeHandle onResize={handleResize} onResizeEnd={handleResizeEnd} />

          {/* Table — explicit height, resizable */}
          <div
            className="bg-slate-900 overflow-hidden flex-shrink-0"
            style={{ height: tableHeight }}
          >
            <AircraftTable tracks={tracks} historyTracks={visibleHistory} />
          </div>
        </main>
      </div>

      {/* Footer metrics */}
      <MetricsBar metrics={metrics} />
    </div>
  );
}
