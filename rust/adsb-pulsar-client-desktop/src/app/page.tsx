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
import { startFeed, stopFeed, getConfig } from "@/lib/commands";
import { exportTracksToFile, importTracksFromFile } from "@/lib/file-io";
import { sortTracks } from "@/lib/sort-tracks";
import { DEFAULT_FILTERS } from "@/lib/types";
import type { ActiveMode, Config, Filters, DensityMetric, DensityTooltipMode, AltitudeColorMode } from "@/lib/types";
import type { SelectEvent } from "@/components/AircraftTable";
import { ModeTabs } from "@/components/ModeTabs";
import Link from "next/link";

const MIN_TABLE_HEIGHT = 150;
const MAX_TABLE_HEIGHT_VH = 0.5; // 50vh

export default function Dashboard() {
  const [activeMode, setActiveMode] = useLocalStorage<ActiveMode>("adsb-active-mode", "live");
  const [liveFilters, setLiveFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [analysisFilters, setAnalysisFilters] = useState<Filters>(DEFAULT_FILTERS);
  const activeFilters = activeMode === "live" ? liveFilters : analysisFilters;
  const setActiveFilters = activeMode === "live" ? setLiveFilters : setAnalysisFilters;
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
  const [densityAltitudeMin, setDensityAltitudeMin] = useLocalStorage<number>("adsb-density-alt-min", 0);
  const [densityAltitudeMax, setDensityAltitudeMax] = useLocalStorage<number>("adsb-density-alt-max", 50000);
  const [densityTooltipMode, setDensityTooltipMode] = useLocalStorage<DensityTooltipMode>("adsb-density-tooltip-mode", "compact");
  const [showReceiver, setShowReceiver] = useLocalStorage<boolean>("adsb-show-receiver", true);

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

  const [appConfig, setAppConfig] = useState<Config | null>(null);
  useEffect(() => {
    getConfig().then(setAppConfig).catch(() => {});
  }, []);
  const receiverLocation = useMemo(() => {
    if (appConfig?.receiver_latitude != null && appConfig?.receiver_longitude != null) {
      return { lat: appConfig.receiver_latitude, lng: appConfig.receiver_longitude, alt: appConfig.receiver_altitude };
    }
    return undefined;
  }, [appConfig]);

  const [selectedHexIdents, setSelectedHexIdents] = useState<Set<string>>(new Set());
  const [lastSelectedHexIdent, setLastSelectedHexIdent] = useState<string | null>(null);
  const [sortKey] = useState<"callsign">("callsign");
  const [sortAsc] = useState(true);

  const {
    tracks, history, imported, dbHistory, analysis,
    importTracks, clearImported, loadDbHistoryTracks, clearDbHistory,
    addAnalysisTracks, removeAnalysisTrack, clearAnalysis,
  } = useAircraftTracks(activeFilters);
  const [showImported, setShowImported] = useLocalStorage<boolean>("adsb-show-imported", true);
  const simulatedTracks = useSimulatedTracks(showSimulation);
  const allTracks = useMemo(() => [...tracks, ...simulatedTracks], [tracks, simulatedTracks]);
  const metrics = useMetrics();
  const status = useConnectionStatus();
  const isRunning = status.is_running;

  const visibleHistory = showHistory ? history : [];
  const visibleImported = showImported ? imported : [];
  const visibleDbHistory = showDbHistory ? dbHistory : [];

  // Mode-conditional arrays for Map and Table
  const isLive = activeMode === "live";
  const mapTracks = isLive ? allTracks : [];
  const mapHistory = isLive ? visibleHistory : [];
  const mapImported = isLive ? visibleImported : [];
  const mapDbHistory = isLive ? visibleDbHistory : analysis;
  const tableTracks = isLive ? allTracks : analysis;
  const tableHistory = isLive ? visibleHistory : [];
  const tableImported = isLive ? visibleImported : [];
  const tableDbHistory = isLive ? visibleDbHistory : [];

  const selectedTrack = useMemo(
    () =>
      mapTracks.find(t => t.hex_ident === lastSelectedHexIdent) ??
      mapHistory.find(t => t.hex_ident === lastSelectedHexIdent) ??
      mapDbHistory.find(t => t.hex_ident === lastSelectedHexIdent) ??
      mapImported.find(t => t.hex_ident === lastSelectedHexIdent) ??
      null,
    [lastSelectedHexIdent, mapTracks, mapHistory, mapDbHistory, mapImported],
  );

  // Flat visible order for shift-range selection — mirrors table section order
  const flatVisibleOrder = useMemo(
    () => [
      ...sortTracks(tableTracks, sortKey, sortAsc),
      ...sortTracks(tableHistory, sortKey, sortAsc),
      ...sortTracks(tableDbHistory, sortKey, sortAsc),
      ...sortTracks(tableImported, sortKey, sortAsc),
    ].map(t => t.hex_ident),
    [tableTracks, tableHistory, tableDbHistory, tableImported, sortKey, sortAsc],
  );

  // Multi-select handler: plain click = single, ctrl/cmd = toggle, shift = range
  const handleSelectTrack = useCallback((hexIdent: string | null, event?: SelectEvent) => {
    if (hexIdent === null) {
      // Map click on empty space — deselect all
      setSelectedHexIdents(new Set());
      setLastSelectedHexIdent(null);
      return;
    }
    if (event && (event.ctrlKey || event.metaKey)) {
      // Toggle individual item
      setSelectedHexIdents(prev => {
        const next = new Set(prev);
        if (next.has(hexIdent)) {
          next.delete(hexIdent);
        } else {
          next.add(hexIdent);
        }
        return next;
      });
      setLastSelectedHexIdent(hexIdent);
    } else if (event?.shiftKey && lastSelectedHexIdent) {
      // Range selection
      const anchorIdx = flatVisibleOrder.indexOf(lastSelectedHexIdent);
      const targetIdx = flatVisibleOrder.indexOf(hexIdent);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        setSelectedHexIdents(new Set(flatVisibleOrder.slice(start, end + 1)));
      } else {
        setSelectedHexIdents(new Set([hexIdent]));
        setLastSelectedHexIdent(hexIdent);
      }
      // Keep lastSelectedHexIdent unchanged (anchor stays) for shift
    } else {
      // Plain click — single selection
      setSelectedHexIdents(new Set([hexIdent]));
      setLastSelectedHexIdent(hexIdent);
    }
  }, [lastSelectedHexIdent, flatVisibleOrder]);

  // Auto-deselect when selected tracks disappear from current mode
  useEffect(() => {
    if (selectedHexIdents.size === 0) return;
    const allHexes = new Set([
      ...mapTracks.map(t => t.hex_ident),
      ...mapHistory.map(t => t.hex_ident),
      ...mapDbHistory.map(t => t.hex_ident),
      ...mapImported.map(t => t.hex_ident),
    ]);
    const remaining = new Set([...selectedHexIdents].filter(h => allHexes.has(h)));
    if (remaining.size < selectedHexIdents.size) {
      setSelectedHexIdents(remaining);
    }
    if (lastSelectedHexIdent && !allHexes.has(lastSelectedHexIdent)) {
      setLastSelectedHexIdent(null);
    }
  }, [selectedHexIdents, lastSelectedHexIdent, mapTracks, mapHistory, mapDbHistory, mapImported]);

  const isImportedSelection = mapImported.some(t => t.hex_ident === lastSelectedHexIdent);
  const isDbHistorySelection = mapDbHistory.some(t => t.hex_ident === lastSelectedHexIdent);

  const densityTracks = useMemo(
    () => {
      if (!showDensity) return [];
      if (isLive) return [...allTracks, ...history, ...(includeImportedInDensity ? imported : [])];
      return analysis;
    },
    [showDensity, isLive, allTracks, history, includeImportedInDensity, imported, analysis],
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

  const handleDensityAltitudeChange = useCallback((min: number, max: number) => {
    setDensityAltitudeMin(min);
    setDensityAltitudeMax(max);
  }, [setDensityAltitudeMin, setDensityAltitudeMax]);

  function handleToggleReceiver() {
    setShowReceiver((prev: boolean) => !prev);
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
          filters={activeFilters}
          onChange={setActiveFilters}
          trackCount={isLive ? allTracks.length : analysis.length}
          showHistory={showHistory}
          onToggleHistory={handleToggleHistory}
          historyCount={history.length}
          showDensity={showDensity}
          onToggleDensity={handleToggleDensity}
          densityMetric={densityMetric}
          onDensityMetricChange={setDensityMetric}
          densityAltitudeMin={densityAltitudeMin}
          densityAltitudeMax={densityAltitudeMax}
          onDensityAltitudeChange={handleDensityAltitudeChange}
          densityTooltipMode={densityTooltipMode}
          onDensityTooltipModeChange={setDensityTooltipMode}
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
          showReceiver={showReceiver}
          onToggleReceiver={handleToggleReceiver}
          hasReceiverLocation={receiverLocation != null}
        />

        {/* Map + Table */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Map row — flex row so details panel sits right of map */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex-1 min-w-0">
              <Map tracks={mapTracks} historyTracks={mapHistory} importedTracks={mapImported} dbHistoryTracks={mapDbHistory} mapTheme={mapTheme} onToggleTheme={handleToggleTheme} trajectoryStyle={trajectoryStyle} densityTracks={densityTracks} densityMetric={densityMetric} densityAltitudeMin={densityAltitudeMin} densityAltitudeMax={densityAltitudeMax} densityTooltipMode={densityTooltipMode} showDensity={showDensity} liveColorMode={liveColorMode} historyColorMode={historyColorMode} selectedHexIdents={selectedHexIdents} onSelectTrack={handleSelectTrack} receiverLocation={showReceiver ? receiverLocation : undefined} />
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
                  receiverLat={receiverLocation?.lat}
                  receiverLon={receiverLocation?.lng}
                  onAddToAnalysis={addAnalysisTracks}
                  onSwitchToAnalysis={() => setActiveMode("analysis")}
                />
              </DBHistoryPanel>
            )}
          </div>

          {/* Resize handle */}
          <ResizeHandle onResize={handleResize} onResizeEnd={handleResizeEnd} />

          {/* Mode tabs */}
          <ModeTabs
            activeMode={activeMode}
            onModeChange={setActiveMode}
            liveCount={allTracks.length}
            analysisCount={analysis.length}
            onClearAnalysis={clearAnalysis}
          />

          {/* Table — explicit height, resizable */}
          <div
            className="bg-slate-900 overflow-hidden flex-shrink-0"
            style={{ height: tableHeight }}
          >
            <AircraftTable
              tracks={tableTracks}
              historyTracks={tableHistory}
              importedTracks={tableImported}
              dbHistoryTracks={tableDbHistory}
              selectedHexIdents={selectedHexIdents}
              lastSelectedHexIdent={lastSelectedHexIdent}
              onSelectTrack={handleSelectTrack}
              onRemoveTrack={!isLive ? removeAnalysisTrack : undefined}
            />
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
            receiverLat={receiverLocation?.lat}
            receiverLon={receiverLocation?.lng}
          />
        </DBHistoryPanel>
      )}
    </div>
  );
}
