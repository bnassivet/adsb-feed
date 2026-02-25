"use client";
import { useState, useCallback, useMemo, useEffect } from "react";
import { Map } from "@/components/Map";
import { AircraftTable } from "@/components/AircraftTable";
import { MetricsBar } from "@/components/MetricsBar";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatus";
import { ResizeHandle } from "@/components/ResizeHandle";
import { LeftPanel } from "@/components/LeftPanel";
import { AircraftDetailsPanel } from "@/components/AircraftDetailsPanel";
import { DBHistoryPanel } from "@/components/DBHistoryPanel";
import { DBHistoryContent } from "@/components/DBHistoryContent";
import { useAircraftTracks } from "@/hooks/useAircraftTracks";
import { useSimulatedTracks } from "@/hooks/useSimulatedTracks";
import { useMetrics } from "@/hooks/useMetrics";
import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { startFeed, stopFeed } from "@/lib/commands";
import { exportTracksToFile, importTracksFromFile } from "@/lib/file-io";
import { DEFAULT_FILTERS } from "@/lib/types";
import type { Filters, DensityMetric, AltitudeColorMode } from "@/lib/types";
import Link from "next/link";

const MIN_TABLE_HEIGHT = 150;
const MAX_TABLE_HEIGHT_VH = 0.5; // 50vh

export default function Dashboard() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [error, setError] = useState<string | null>(null);
  const [mapTheme, setMapTheme] = useLocalStorage<"light" | "dark">("adsb-map-theme", "dark");
  const [tableHeight, setTableHeight] = useLocalStorage<number>("adsb-table-height", 256);
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>("adsb-sidebar-open", true);
  const [sidebarWidth, setSidebarWidth] = useLocalStorage<number>("adsb-sidebar-width", 224);
  const [trajectoryStyle] = useLocalStorage<"line" | "dots">("adsb-trajectory-style", "line");
  const [detailsPanelOpen, setDetailsPanelOpen] = useLocalStorage<boolean>("adsb-details-panel-open", true);
  const [detailsPanelWidth, setDetailsPanelWidth] = useLocalStorage<number>("adsb-details-panel-width", 280);
  const [showHistory, setShowHistory] = useLocalStorage<boolean>("adsb-show-history", false);
  const [showDensity, setShowDensity] = useLocalStorage<boolean>("adsb-show-density", false);
  const [densityMetric, setDensityMetric] = useLocalStorage<DensityMetric>("adsb-density-metric", "positions");
  const [showSimulation, setShowSimulation] = useLocalStorage<boolean>("adsb-show-simulation", false);
  const [liveColorMode, setLiveColorMode] = useLocalStorage<AltitudeColorMode>("adsb-live-color-mode", "track");
  const [historyColorMode, setHistoryColorMode] = useLocalStorage<AltitudeColorMode>("adsb-history-color-mode", "track");
  const [includeImportedInDensity, setIncludeImportedInDensity] = useLocalStorage<boolean>("adsb-include-imported-density", false);

  // DB History Panel state
  const [dbHistoryOpen, setDbHistoryOpen] = useLocalStorage<boolean>("adsb-dbhistory-open", false);
  const [dbHistoryDockedExpanded, setDbHistoryDockedExpanded] = useLocalStorage<boolean>("adsb-dbhistory-docked-expanded", true);
  const [dbHistoryWidth, setDbHistoryWidth] = useLocalStorage<number>("adsb-dbhistory-width", 360);
  const [dbHistoryFloating, setDbHistoryFloating] = useLocalStorage<boolean>("adsb-dbhistory-floating", false);
  const [dbHistoryFloatX, setDbHistoryFloatX] = useLocalStorage<number>("adsb-dbhistory-float-x", 100);
  const [dbHistoryFloatY, setDbHistoryFloatY] = useLocalStorage<number>("adsb-dbhistory-float-y", 80);
  const [dbHistoryFloatW, setDbHistoryFloatW] = useLocalStorage<number>("adsb-dbhistory-float-w", 400);
  const [dbHistoryFloatH, setDbHistoryFloatH] = useLocalStorage<number>("adsb-dbhistory-float-h", 600);
  const [showDbHistory, setShowDbHistory] = useLocalStorage<boolean>("adsb-show-dbhistory", true);

  const [selectedHexIdent, setSelectedHexIdent] = useState<string | null>(null);

  const { tracks, history, imported, dbHistory, importTracks, clearImported, loadDbHistoryTracks, clearDbHistory } = useAircraftTracks(filters);
  const [showImported, setShowImported] = useLocalStorage<boolean>("adsb-show-imported", true);
  const simulatedTracks = useSimulatedTracks(showSimulation);
  const allTracks = useMemo(() => [...tracks, ...simulatedTracks], [tracks, simulatedTracks]);
  const metrics = useMetrics();
  const status = useConnectionStatus();
  const isRunning = status.is_running;

  const visibleHistory = showHistory ? history : [];
  const visibleImported = showImported ? imported : [];
  const visibleDbHistory = showDbHistory ? dbHistory : [];
  const selectedTrack = useMemo(
    () =>
      allTracks.find(t => t.hex_ident === selectedHexIdent) ??
      visibleHistory.find(t => t.hex_ident === selectedHexIdent) ??
      visibleDbHistory.find(t => t.hex_ident === selectedHexIdent) ??
      visibleImported.find(t => t.hex_ident === selectedHexIdent) ??
      null,
    [selectedHexIdent, allTracks, visibleHistory, visibleDbHistory, visibleImported],
  );

  // Toggle selection: clicking same track deselects, clicking different selects
  const handleSelectTrack = useCallback((hexIdent: string | null) => {
    setSelectedHexIdent(prev => prev === hexIdent ? null : hexIdent);
  }, []);

  // Auto-deselect when selected track disappears (TTL expiry)
  useEffect(() => {
    if (!selectedHexIdent) return;
    const exists =
      allTracks.some(t => t.hex_ident === selectedHexIdent) ||
      visibleHistory.some(t => t.hex_ident === selectedHexIdent) ||
      visibleDbHistory.some(t => t.hex_ident === selectedHexIdent) ||
      visibleImported.some(t => t.hex_ident === selectedHexIdent);
    if (!exists) setSelectedHexIdent(null);
  }, [selectedHexIdent, allTracks, visibleHistory, visibleDbHistory, visibleImported]);

  const isImportedSelection = visibleImported.some(t => t.hex_ident === selectedHexIdent);
  const isDbHistorySelection = visibleDbHistory.some(t => t.hex_ident === selectedHexIdent);

  const densityTracks = useMemo(
    () => (showDensity ? [...allTracks, ...history, ...(includeImportedInDensity ? imported : [])] : []),
    [showDensity, allTracks, history, includeImportedInDensity, imported],
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

  function handleToggleSimulation() {
    setShowSimulation((prev: boolean) => !prev);
  }

  function handleToggleImported() {
    setShowImported((prev: boolean) => !prev);
  }

  function handleToggleIncludeImportedInDensity() {
    setIncludeImportedInDensity((prev: boolean) => !prev);
  }

  async function handleExport() {
    try {
      setError(null);
      await exportTracksToFile(tracks, history);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleImport() {
    try {
      setError(null);
      const importedTracks = await importTracksFromFile();
      if (importedTracks) importTracks(importedTracks);
    } catch (e) {
      setError(String(e));
    }
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
          <button
            onClick={() => setDbHistoryOpen((prev: boolean) => !prev)}
            className={`px-2 py-1 text-xs rounded transition ${dbHistoryOpen ? "bg-cyan-800/40 text-cyan-200 border border-cyan-700/30" : "text-slate-400 hover:text-slate-200 hover:bg-slate-700"}`}
            title={dbHistoryOpen ? "Hide DB History panel" : "Show DB History panel"}
          >
            DB History
          </button>
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-xs text-red-400 max-w-xs truncate">
              {error}
            </span>
          )}
          <button
            onClick={handleExport}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
            title="Export tracks to GeoJSON"
          >
            Export
          </button>
          <button
            onClick={handleImport}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
            title="Import tracks from GeoJSON"
          >
            Import
          </button>
          {imported.length > 0 && (
            <button
              onClick={clearImported}
              className="px-3 py-1.5 bg-slate-700 hover:bg-red-600 text-slate-400 hover:text-white text-sm rounded transition"
              title="Clear imported tracks"
            >
              Clear import
            </button>
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
        <LeftPanel
          isOpen={sidebarOpen}
          width={sidebarWidth}
          onToggle={() => setSidebarOpen((prev: boolean) => !prev)}
          onWidthChange={setSidebarWidth}
          filters={filters}
          onChange={setFilters}
          trackCount={allTracks.length}
          showHistory={showHistory}
          onToggleHistory={handleToggleHistory}
          historyCount={history.length}
          showDensity={showDensity}
          onToggleDensity={handleToggleDensity}
          densityMetric={densityMetric}
          onDensityMetricChange={setDensityMetric}
          showSimulation={showSimulation}
          onToggleSimulation={handleToggleSimulation}
          simulationCount={simulatedTracks.length}
          liveColorMode={liveColorMode}
          onLiveColorModeChange={setLiveColorMode}
          historyColorMode={historyColorMode}
          onHistoryColorModeChange={setHistoryColorMode}
          importedCount={imported.length}
          showImported={showImported}
          onToggleImported={handleToggleImported}
          onClearImported={clearImported}
          includeImportedInDensity={includeImportedInDensity}
          onToggleIncludeImportedInDensity={handleToggleIncludeImportedInDensity}
        />

        {/* Map + Table */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Map row — flex row so details panel sits right of map */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex-1 min-w-0">
              <Map tracks={allTracks} historyTracks={visibleHistory} importedTracks={visibleImported} dbHistoryTracks={visibleDbHistory} mapTheme={mapTheme} onToggleTheme={handleToggleTheme} trajectoryStyle={trajectoryStyle} densityTracks={densityTracks} densityMetric={densityMetric} showDensity={showDensity} liveColorMode={liveColorMode} historyColorMode={historyColorMode} selectedHexIdent={selectedHexIdent} onSelectTrack={handleSelectTrack} />
            </div>
            {selectedTrack && (
              <AircraftDetailsPanel
                track={selectedTrack}
                isOpen={detailsPanelOpen}
                width={detailsPanelWidth}
                onToggle={() => setDetailsPanelOpen((p: boolean) => !p)}
                onWidthChange={setDetailsPanelWidth}
                isImported={isImportedSelection}
                isDbHistory={isDbHistorySelection}
              />
            )}
            {/* DB History panel — docked mode (in flex row) */}
            {dbHistoryOpen && !dbHistoryFloating && (
              <DBHistoryPanel
                isOpen={dbHistoryOpen}
                onToggle={() => setDbHistoryOpen(false)}
                width={dbHistoryWidth}
                onWidthChange={setDbHistoryWidth}
                dockedExpanded={dbHistoryDockedExpanded}
                onDockedExpandedChange={setDbHistoryDockedExpanded}
                floating={false}
                onFloatingChange={setDbHistoryFloating}
                floatX={dbHistoryFloatX}
                floatY={dbHistoryFloatY}
                floatW={dbHistoryFloatW}
                floatH={dbHistoryFloatH}
                onFloatPosChange={(x, y) => { setDbHistoryFloatX(x); setDbHistoryFloatY(y); }}
                onFloatSizeChange={(w, h) => { setDbHistoryFloatW(w); setDbHistoryFloatH(h); }}
              >
                <DBHistoryContent
                  onLoadTracks={loadDbHistoryTracks}
                  onClearTracks={clearDbHistory}
                  dbHistoryCount={dbHistory.length}
                />
              </DBHistoryPanel>
            )}
          </div>

          {/* Resize handle */}
          <ResizeHandle onResize={handleResize} onResizeEnd={handleResizeEnd} />

          {/* Table — explicit height, resizable */}
          <div
            className="bg-slate-900 overflow-hidden flex-shrink-0"
            style={{ height: tableHeight }}
          >
            <AircraftTable tracks={allTracks} historyTracks={visibleHistory} importedTracks={visibleImported} dbHistoryTracks={visibleDbHistory} selectedHexIdent={selectedHexIdent} onSelectTrack={handleSelectTrack} />
          </div>
        </main>
      </div>

      {/* Footer metrics */}
      <MetricsBar metrics={metrics} />

      {/* DB History panel — floating mode (portal-like, fixed position) */}
      {dbHistoryOpen && dbHistoryFloating && (
        <DBHistoryPanel
          isOpen={dbHistoryOpen}
          onToggle={() => setDbHistoryOpen(false)}
          width={dbHistoryWidth}
          onWidthChange={setDbHistoryWidth}
          dockedExpanded={dbHistoryDockedExpanded}
          onDockedExpandedChange={setDbHistoryDockedExpanded}
          floating={true}
          onFloatingChange={setDbHistoryFloating}
          floatX={dbHistoryFloatX}
          floatY={dbHistoryFloatY}
          floatW={dbHistoryFloatW}
          floatH={dbHistoryFloatH}
          onFloatPosChange={(x, y) => { setDbHistoryFloatX(x); setDbHistoryFloatY(y); }}
          onFloatSizeChange={(w, h) => { setDbHistoryFloatW(w); setDbHistoryFloatH(h); }}
        >
          <DBHistoryContent
            onLoadTracks={loadDbHistoryTracks}
            onClearTracks={clearDbHistory}
            dbHistoryCount={dbHistory.length}
          />
        </DBHistoryPanel>
      )}
    </div>
  );
}
