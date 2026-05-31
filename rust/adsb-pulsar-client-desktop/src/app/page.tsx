"use client";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Map as AircraftMap } from "@/components/Map";
import { AircraftTable } from "@/components/AircraftTable";
import { MetricsBar } from "@/components/MetricsBar";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatus";
import { ResizeHandle } from "@/components/ResizeHandle";
import { LeftPanel } from "@/components/LeftPanel";
import { AircraftDetailsPanel } from "@/components/AircraftDetailsPanel";
import { DBHistoryPanel } from "@/components/DBHistoryPanel";
import { DBHistoryContent } from "@/components/DBHistoryContent";
import { AIChatPanel } from "@/components/AIChatPanel";
import { AIChatContent } from "@/components/AIChatContent";
import { useChatThreadId } from "@/hooks/useChatThreadId";
import { EventsOfInterestPanel } from "@/components/EventsOfInterestPanel";
import { EventsOfInterestContent } from "@/components/EventsOfInterestContent";
import { EventFormDialog } from "@/components/EventFormDialog";
import { MapContextMenu } from "@/components/MapContextMenu";
import { useAircraftTracks } from "@/hooks/useAircraftTracks";
import { useSimulatedTracks } from "@/hooks/useSimulatedTracks";
import { useMetrics } from "@/hooks/useMetrics";
import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { useRecordingState } from "@/hooks/useRecordingState";
import { useEventsOfInterest } from "@/hooks/useEventsOfInterest";
import { useCopilotTools } from "@/hooks/useCopilotTools";
import { useCopilotContext } from "@/hooks/useCopilotContext";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { startFeed, stopFeed, getConfig, getStorageStatus, releaseStorage, reclaimStorage, exportDatabase, previewImportDatabase, importDatabase, swapDatabase, getStorageStats } from "@/lib/commands";
import { exportTracksToFile, importTracksFromFile } from "@/lib/file-io";
import { listen } from "@tauri-apps/api/event";
import { ask, message, save, open } from "@tauri-apps/plugin-dialog";
import { sortTracks, type SortKey } from "@/lib/sort-tracks";
import { filterHistoryByTimeRange } from "@/lib/history-time-filter";
import { DEFAULT_FILTERS, trackKey } from "@/lib/types";
import type { AircraftTrack, ActiveMode, Config, Filters, DensityMetric, DensityTooltipMode, AltitudeColorMode, TrackSection, StorageAvailability, CreateEventOfInterest, UpdateEventOfInterest, EventOfInterest, EventFilterMode, MapPickResult } from "@/lib/types";
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

  // Events of Interest state
  const [eventsOpen, setEventsOpen] = useLocalStorage<boolean>("adsb-events-open", false);
  const [eventsDockedExpanded, setEventsDockedExpanded] = useLocalStorage<boolean>("adsb-events-docked-expanded", true);
  const [eventsWidth, setEventsWidth] = useLocalStorage<number>("adsb-events-width", 340);
  const [eventsFloating, setEventsFloating] = useLocalStorage<boolean>("adsb-events-floating", true);
  const [eventsPanelX, setEventsPanelX] = useLocalStorage<number>("adsb-events-panel-x", 100);
  const [eventsPanelY, setEventsPanelY] = useLocalStorage<number>("adsb-events-panel-y", 80);
  const [eventsPanelW, setEventsPanelW] = useLocalStorage<number>("adsb-events-panel-w", 360);
  const [eventsPanelH, setEventsPanelH] = useLocalStorage<number>("adsb-events-panel-h", 400);
  const [eventFormOpen, setEventFormOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<EventOfInterest | undefined>(undefined);
  const [eventFormInitialLat, setEventFormInitialLat] = useState<number | null>(null);
  const [eventFormInitialLng, setEventFormInitialLng] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; lat: number; lng: number } | null>(null);
  const [mapPickingMode, setMapPickingMode] = useState<"point" | "area" | null>(null);
  const [mapPickResult, setMapPickResult] = useState<MapPickResult | null>(null);
  // AI Chat Panel state
  const [aiChatOpen, setAiChatOpen] = useLocalStorage<boolean>("adsb-aichat-open", false);
  const chatThreadId = useChatThreadId(aiChatOpen);
  const [aiChatDockedExpanded, setAiChatDockedExpanded] = useLocalStorage<boolean>("adsb-aichat-docked-expanded", true);
  const [aiChatWidth, setAiChatWidth] = useLocalStorage<number>("adsb-aichat-width", 360);
  const [aiChatFloating, setAiChatFloating] = useLocalStorage<boolean>("adsb-aichat-floating", true);
  const [aiChatFloatX, setAiChatFloatX] = useLocalStorage<number>("adsb-aichat-float-x", 120);
  const [aiChatFloatY, setAiChatFloatY] = useLocalStorage<number>("adsb-aichat-float-y", 60);
  const [aiChatFloatW, setAiChatFloatW] = useLocalStorage<number>("adsb-aichat-float-w", 400);
  const [aiChatFloatH, setAiChatFloatH] = useLocalStorage<number>("adsb-aichat-float-h", 520);

  const [showEvents, setShowEvents] = useLocalStorage<boolean>("adsb-show-events", true);
  const [eventFilterMode, setEventFilterMode] = useLocalStorage<EventFilterMode>("adsb-event-filter-mode", "all");
  const [eventUpcomingDays, setEventUpcomingDays] = useLocalStorage<number>("adsb-event-upcoming-days", 7);
  const [eventTimeRangeStart, setEventTimeRangeStart] = useLocalStorage<number>("adsb-event-time-start", Date.now());
  const [eventTimeRangeEnd, setEventTimeRangeEnd] = useLocalStorage<number>("adsb-event-time-end", Date.now() + 86400000);

  const [showImported, setShowImported] = useLocalStorage<boolean>("adsb-show-imported", true);

  const { events: eventsOfInterest, loading: eventsLoading, createEvent, updateEvent, removeEvent, removeEvents } = useEventsOfInterest();

  const status = useConnectionStatus();
  const isRunning = status.is_running;

  // Derive a descriptive connection status string for CopilotKit from the actual socket state
  const copilotConnectionStatus = !isRunning
    ? "disconnected"
    : status.socket_status.status === "Error"
      ? `error: ${(status.socket_status as { status: "Error"; message: string }).message}`
      : status.socket_status.status.toLowerCase();

  // CopilotKit tools registered below (after allTracks, selectedHexIdents, flyTo are available)

  const [hiddenEventIds, setHiddenEventIds] = useState<Set<string>>(new Set());

  const handleToggleEventVisibility = useCallback((id: string) => {
    setHiddenEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allEventsHidden = eventsOfInterest.length > 0 && hiddenEventIds.size >= eventsOfInterest.length;

  const handleToggleAllVisibility = useCallback(() => {
    if (allEventsHidden) {
      setHiddenEventIds(new Set());
    } else {
      setHiddenEventIds(new Set(eventsOfInterest.map(e => e.id)));
    }
  }, [allEventsHidden, eventsOfInterest]);

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
  const [hiddenSections, setHiddenSections] = useState<Map<TrackSection, Set<string>>>(new Map());
  const [sortKey, setSortKey] = useState<SortKey>("callsign");
  const [sortAsc, setSortAsc] = useState(true);
  const handleSort = useCallback((key: SortKey) => {
    setSortAsc(prev => sortKey === key ? !prev : true);
    setSortKey(key);
  }, [sortKey]);

  const {
    tracks, history, imported, dbHistory, analysis,
    importTracks, clearImported, loadDbHistoryTracks, clearDbHistory,
    addAnalysisTracks, removeAnalysisTrack, clearAnalysis,
    trackHistoryHours,
  } = useAircraftTracks(activeFilters);
  // History time range slider — session-only state (resets each session)
  const [historySliderMin, setHistorySliderMin] = useState(0);
  const [historySliderMax, setHistorySliderMax] = useState<number | null>(null);
  const effectiveSliderMax = historySliderMax ?? trackHistoryHours;
  const simulatedTracks = useSimulatedTracks(showSimulation);
  const allTracks = useMemo(() => [...tracks, ...simulatedTracks], [tracks, simulatedTracks]);

  // Map flyTo callback — set by MapInner via prop, called by copilot panMapTo tool
  const flyToRef = useRef<((lat: number, lng: number, zoom: number) => void) | null>(null);
  const flyTo = useCallback((lat: number, lng: number, zoom: number) => {
    flyToRef.current?.(lat, lng, zoom);
  }, []);

  // CopilotKit — register frontend tools (after all state deps available)
  useCopilotTools({
    connectionStatus: copilotConnectionStatus,
    mapTheme,
    sidebarOpen,
    activeMode,
    showHistory,
    showDensity,
    showSimulation,
    showImported,
    showReceiver,
    showEvents,
    liveColorMode,
    historyColorMode,
    densityMetric,
    densityTooltipMode,
    densityAltitudeMin,
    densityAltitudeMax,
    eventFilterMode,
    eventUpcomingDays,
    eventTimeRangeStart,
    eventTimeRangeEnd,
    setMapTheme,
    setSidebarOpen,
    setActiveMode,
    setShowHistory,
    setShowDensity,
    setShowSimulation,
    setShowImported,
    setShowReceiver,
    setShowEvents,
    setLiveColorMode,
    setHistoryColorMode,
    setDensityMetric,
    setDensityTooltipMode,
    setDensityAltitudeMin,
    setDensityAltitudeMax,
    setEventFilterMode,
    setEventUpcomingDays,
    setEventTimeRangeStart,
    setEventTimeRangeEnd,
    tracks: allTracks,
    setSelectedHexIdents,
    setLastSelectedHexIdent,
    activeFilters,
    setActiveFilters,
    flyTo,
  });

  const metrics = useMetrics();
  const { recordPositions, recordRaw, toggleRecordPositions, toggleRecordRaw } = useRecordingState();
  const [storageStatus, setStorageStatus] = useState<StorageAvailability>("unavailable");
  const [isExporting, setIsExporting] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // Fetch initial storage status and listen for changes
  useEffect(() => {
    getStorageStatus().then(setStorageStatus).catch(() => {});
    const unlisten = listen<StorageAvailability>("adsb:storage-status", (event) => {
      setStorageStatus(event.payload);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const handleToggleRecordPositions = useCallback(async () => {
    const action = recordPositions ? "Pause" : "Resume";
    const confirmed = await ask(`${action} recording positions to DuckDB?`, { title: "Recording", kind: "info" });
    if (!confirmed) return;
    toggleRecordPositions();
  }, [recordPositions, toggleRecordPositions]);

  const handleToggleRecordRaw = useCallback(async () => {
    const action = recordRaw ? "Pause" : "Resume";
    const confirmed = await ask(`${action} recording raw messages to DuckDB?`, { title: "Recording", kind: "info" });
    if (!confirmed) return;
    toggleRecordRaw();
  }, [recordRaw, toggleRecordRaw]);

  const handleReleaseStorage = useCallback(async () => {
    const confirmed = await ask("Release the DB connection? Recording will pause and queries will be unavailable until reclaimed.", { title: "Release Storage", kind: "warning" });
    if (!confirmed) return;
    try {
      setError(null);
      await releaseStorage();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleReclaimStorage = useCallback(async () => {
    const confirmed = await ask("Reclaim the DB connection and resume recording?", { title: "Reclaim Storage", kind: "info" });
    if (!confirmed) return;
    try {
      setError(null);
      await reclaimStorage();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleExportDatabase = useCallback(async () => {
    try {
      setError(null);
      let defaultPath = "adsb_export.db";
      try {
        const stats = await getStorageStats();
        const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        if (stats.oldest_timestamp_ms != null && stats.newest_timestamp_ms != null) {
          defaultPath = `adsb_export-${fmtDate(stats.oldest_timestamp_ms)}-${fmtDate(stats.newest_timestamp_ms)}.db`;
        }
      } catch { /* fall back to generic name */ }
      const path = await save({
        defaultPath,
        filters: [{ name: "DuckDB Database", extensions: ["db"] }],
      });
      if (!path) return; // User cancelled
      setIsExporting(true);
      await exportDatabase(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsExporting(false);
    }
  }, []);

  const handleSwapDatabase = useCallback(async () => {
    const confirmed = await ask("Archive the current database as a snapshot and start fresh?", { title: "Swap Database", kind: "warning" });
    if (!confirmed) return;
    try {
      setError(null);
      setIsSwapping(true);
      await swapDatabase();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsSwapping(false);
    }
  }, []);

  const handleImportDatabase = useCallback(async () => {
    try {
      setError(null);
      const path = await open({
        filters: [{ name: "DuckDB Database", extensions: ["db"] }],
        multiple: false,
        directory: false,
      });
      if (!path) return; // User cancelled

      // Preview the external DB
      const preview = await previewImportDatabase(path as string);
      const currentStats = await getStorageStats();

      const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const fmtRange = (oldest: number | null, newest: number | null) =>
        oldest != null && newest != null
          ? `${fmtDate(oldest)} to ${fmtDate(newest)}`
          : "N/A";

      const msg = [
        `External DB:`,
        `  Positions: ${preview.positions.row_count.toLocaleString()} rows (${fmtRange(preview.positions.oldest_timestamp_ms, preview.positions.newest_timestamp_ms)})`,
        `  Raw messages: ${preview.raw_messages.row_count.toLocaleString()} rows (${fmtRange(preview.raw_messages.oldest_timestamp_ms, preview.raw_messages.newest_timestamp_ms)})`,
        ``,
        `Current DB:`,
        `  Positions: ${currentStats.row_count.toLocaleString()} rows (${fmtRange(currentStats.oldest_timestamp_ms, currentStats.newest_timestamp_ms)})`,
        `  Raw messages: ${currentStats.raw_message_count.toLocaleString()} rows`,
        ``,
        `Duplicate records will be skipped. Merge into current database?`,
      ].join("\n");

      const confirmed = await ask(msg, { title: "Import Database", kind: "info" });
      if (!confirmed) return;

      setIsImporting(true);
      const result = await importDatabase(path as string);
      await message(
        `Imported ${result.positions_imported.toLocaleString()} positions and ${result.raw_messages_imported.toLocaleString()} raw messages.`,
        { title: "Import Complete", kind: "info" }
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setIsImporting(false);
    }
  }, []);

  // CopilotKit — provide live app state to the agent
  useCopilotContext({
    connectionStatus: copilotConnectionStatus,
    mapTheme,
    sidebarOpen,
    activeMode,
    showHistory,
    showDensity,
    showSimulation,
    showImported,
    showReceiver,
    showEvents,
    selectedHexIdents,
    lastSelectedHexIdent,
    activeFilters,
    tracks: allTracks,
    storageStatus,
  });

  // Reset slider when trackHistoryHours changes (e.g. user changes setting)
  useEffect(() => {
    setHistorySliderMin(0);
    setHistorySliderMax(null);
  }, [trackHistoryHours]);

  const visibleHistory = useMemo(() => {
    if (!showHistory) return [];
    return filterHistoryByTimeRange(history, trackHistoryHours, historySliderMin, effectiveSliderMax, Date.now());
  }, [showHistory, history, trackHistoryHours, historySliderMin, effectiveSliderMax]);
  const visibleImported = showImported ? imported : [];
  const visibleDbHistory = showDbHistory ? dbHistory : [];

  // Mode-conditional arrays for Map and Table
  const isLive = activeMode === "live";
  const filterBySection = useCallback(
    (section: TrackSection, tracks: typeof allTracks) => {
      const sectionSet = hiddenSections.get(section);
      if (!sectionSet || sectionSet.size === 0) return tracks;
      return tracks.filter(t => !sectionSet.has(trackKey(t)));
    },
    [hiddenSections],
  );
  const EMPTY_TRACKS: AircraftTrack[] = useMemo(() => [], []);
  const mapTracks = useMemo(
    () => isLive ? filterBySection("live", allTracks) : EMPTY_TRACKS,
    [isLive, filterBySection, allTracks, EMPTY_TRACKS],
  );
  const mapHistory = useMemo(
    () => isLive ? filterBySection("history", visibleHistory) : EMPTY_TRACKS,
    [isLive, filterBySection, visibleHistory, EMPTY_TRACKS],
  );
  const mapImported = useMemo(
    () => isLive ? filterBySection("imported", visibleImported) : EMPTY_TRACKS,
    [isLive, filterBySection, visibleImported, EMPTY_TRACKS],
  );
  const mapDbHistory = useMemo(
    () => isLive ? filterBySection("dbHistory", visibleDbHistory) : filterBySection("analysis", analysis),
    [isLive, filterBySection, visibleDbHistory, analysis],
  );
  const tableTracks = useMemo(
    () => isLive ? allTracks : analysis,
    [isLive, allTracks, analysis],
  );
  const tableHistory = useMemo(
    () => isLive ? visibleHistory : EMPTY_TRACKS,
    [isLive, visibleHistory, EMPTY_TRACKS],
  );
  const tableImported = useMemo(
    () => isLive ? visibleImported : EMPTY_TRACKS,
    [isLive, visibleImported, EMPTY_TRACKS],
  );
  const tableDbHistory = useMemo(
    () => isLive ? visibleDbHistory : EMPTY_TRACKS,
    [isLive, visibleDbHistory, EMPTY_TRACKS],
  );

  // O(1) lookup map for all visible tracks — replaces chained .find() and Set rebuilding
  const allMapTracksMap = useMemo(() => {
    const m = new Map<string, AircraftTrack>();
    for (const arr of [mapTracks, mapHistory, mapDbHistory, mapImported]) {
      for (const t of arr) m.set(trackKey(t), t);
    }
    return m;
  }, [mapTracks, mapHistory, mapDbHistory, mapImported]);

  const selectedTrack = useMemo(
    () => (lastSelectedHexIdent ? allMapTracksMap.get(lastSelectedHexIdent) ?? null : null),
    [lastSelectedHexIdent, allMapTracksMap],
  );

  // Memoized sorted arrays — shared by AircraftTable and flatVisibleOrder
  const sortedTableTracks = useMemo(() => sortTracks(tableTracks, sortKey, sortAsc), [tableTracks, sortKey, sortAsc]);
  const sortedTableHistory = useMemo(() => sortTracks(tableHistory, sortKey, sortAsc), [tableHistory, sortKey, sortAsc]);
  const sortedTableDbHistory = useMemo(() => sortTracks(tableDbHistory, sortKey, sortAsc), [tableDbHistory, sortKey, sortAsc]);
  const sortedTableImported = useMemo(() => sortTracks(tableImported, sortKey, sortAsc), [tableImported, sortKey, sortAsc]);

  // Flat visible order for shift-range selection — mirrors table section order
  const flatVisibleOrder = useMemo(
    () => [...sortedTableTracks, ...sortedTableHistory, ...sortedTableDbHistory, ...sortedTableImported].map(t => trackKey(t)),
    [sortedTableTracks, sortedTableHistory, sortedTableDbHistory, sortedTableImported],
  );

  // Multi-select handler: plain click = single, ctrl/cmd = toggle, shift = range
  const handleSelectTrack = useCallback((hexIdent: string | null, event?: SelectEvent) => {
    // Dismiss context menu on any map click
    setContextMenu(null);
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
    const remaining = new Set([...selectedHexIdents].filter(h => allMapTracksMap.has(h)));
    if (remaining.size < selectedHexIdents.size) {
      setSelectedHexIdents(remaining);
    }
    if (lastSelectedHexIdent && !allMapTracksMap.has(lastSelectedHexIdent)) {
      setLastSelectedHexIdent(null);
    }
  }, [selectedHexIdents, lastSelectedHexIdent, allMapTracksMap]);

  // O(1) lookups using Sets built from existing arrays
  const importedKeysSet = useMemo(() => new Set(mapImported.map(t => trackKey(t))), [mapImported]);
  const dbHistoryKeysSet = useMemo(() => new Set(mapDbHistory.map(t => trackKey(t))), [mapDbHistory]);
  const isImportedSelection = lastSelectedHexIdent ? importedKeysSet.has(lastSelectedHexIdent) : false;
  const isDbHistorySelection = lastSelectedHexIdent ? dbHistoryKeysSet.has(lastSelectedHexIdent) : false;

  const densityTracks = useMemo(
    () => {
      if (!showDensity) return [];
      if (isLive) return [
        ...allTracks,
        ...history,
        ...(includeImportedInDensity ? imported : []),
      ];
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

  const handleHistoryTimeChange = useCallback((min: number, max: number) => {
    setHistorySliderMin(min);
    setHistorySliderMax(max);
  }, []);

  const handleDensityAltitudeChange = useCallback((min: number, max: number) => {
    setDensityAltitudeMin(min);
    setDensityAltitudeMax(max);
  }, [setDensityAltitudeMin, setDensityAltitudeMax]);

  function handleToggleReceiver() {
    setShowReceiver((prev: boolean) => !prev);
  }

  function handleToggleEvents() {
    setShowEvents((prev: boolean) => !prev);
  }

  const handleEventTimeRangeChange = useCallback((startMs: number, endMs: number) => {
    setEventTimeRangeStart(startMs);
    setEventTimeRangeEnd(endMs);
  }, [setEventTimeRangeStart, setEventTimeRangeEnd]);

  const filteredEvents = useMemo(() => {
    if (!showEvents) return [];
    let result = eventsOfInterest;
    if (eventFilterMode === "upcoming") {
      const now = Date.now();
      const horizon = now + eventUpcomingDays * 86400000;
      result = result.filter(e =>
        (e.timestamp_ms >= now && e.timestamp_ms <= horizon) ||
        (e.end_timestamp_ms != null && e.end_timestamp_ms >= now && e.timestamp_ms <= horizon)
      );
    } else if (eventFilterMode === "range") {
      result = result.filter(e => {
        const eventEnd = e.end_timestamp_ms ?? e.timestamp_ms;
        return e.timestamp_ms <= eventTimeRangeEnd && eventEnd >= eventTimeRangeStart;
      });
    }
    if (hiddenEventIds.size > 0) {
      result = result.filter(e => !hiddenEventIds.has(e.id));
    }
    return result;
  }, [showEvents, eventFilterMode, eventUpcomingDays, eventTimeRangeStart, eventTimeRangeEnd, eventsOfInterest, hiddenEventIds]);

  // Events of Interest handlers
  const handleNewEvent = useCallback(() => {
    setEditingEvent(undefined);
    setEventFormInitialLat(null);
    setEventFormInitialLng(null);
    setEventFormOpen(true);
  }, []);

  const handleEditEvent = useCallback((event: EventOfInterest) => {
    setEditingEvent(event);
    setEventFormInitialLat(null);
    setEventFormInitialLng(null);
    setEventFormOpen(true);
  }, []);

  const handleEventFormSave = useCallback(async (data: CreateEventOfInterest | UpdateEventOfInterest) => {
    if ("id" in data) {
      await updateEvent(data as UpdateEventOfInterest);
    } else {
      await createEvent(data as CreateEventOfInterest);
    }
    setEventFormOpen(false);
    setEditingEvent(undefined);
  }, [createEvent, updateEvent]);

  const handleEventFormCancel = useCallback(() => {
    setEventFormOpen(false);
    setEditingEvent(undefined);
  }, []);

  const handleMapContextMenu = useCallback((lat: number, lng: number, x: number, y: number) => {
    if (mapPickingMode) return;
    setContextMenu({ x, y, lat, lng });
  }, [mapPickingMode]);

  const handleCreateEventFromMap = useCallback((lat: number, lng: number) => {
    setEditingEvent(undefined);
    setEventFormInitialLat(lat);
    setEventFormInitialLng(lng);
    setEventFormOpen(true);
    setContextMenu(null);
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleStartMapPick = useCallback((mode: "point" | "area") => {
    setMapPickResult(null);
    setMapPickingMode(mode);
  }, []);

  const handleMapPickComplete = useCallback((result: MapPickResult) => {
    setMapPickResult(result);
    setMapPickingMode(null);
  }, []);

  const handleMapPickCancel = useCallback(() => {
    setMapPickingMode(null);
  }, []);

  const handleToggleMapVisibility = useCallback((hexIdent: string, section: TrackSection) => {
    setHiddenSections(prev => {
      const next = new Map(prev);
      const s = new Set(next.get(section) ?? []);
      s.has(hexIdent) ? s.delete(hexIdent) : s.add(hexIdent);
      s.size === 0 ? next.delete(section) : next.set(section, s);
      return next;
    });
  }, []);

  const handleToggleGroupVisibility = useCallback((section: TrackSection, hexIdents: string[]) => {
    setHiddenSections(prev => {
      const next = new Map(prev);
      const sectionSet = next.get(section);
      const allHidden = sectionSet != null && hexIdents.every(h => sectionSet.has(h));
      if (allHidden) {
        next.delete(section);
      } else {
        next.set(section, new Set(hexIdents));
      }
      return next;
    });
  }, []);

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
          <button
            onClick={() => setEventsOpen((prev: boolean) => !prev)}
            className={`px-2 py-1 text-xs rounded transition ${eventsOpen ? "bg-amber-800/40 text-amber-200 border border-amber-700/30" : "text-slate-400 hover:text-slate-200 hover:bg-slate-700"}`}
            title={eventsOpen ? "Hide Events panel" : "Show Events panel"}
          >
            Events{filteredEvents.length > 0 ? ` (${filteredEvents.length})` : ""}
          </button>
          <button
            onClick={() => setAiChatOpen((prev: boolean) => !prev)}
            className={`px-2 py-1 text-xs rounded transition ${aiChatOpen ? "bg-violet-800/40 text-violet-200 border border-violet-700/30" : "text-slate-400 hover:text-slate-200 hover:bg-slate-700"}`}
            title={aiChatOpen ? "Hide AI Chat" : "Show AI Chat"}
          >
            AI Chat
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
          historySliderMin={historySliderMin}
          historySliderMax={effectiveSliderMax}
          historySliderRange={trackHistoryHours}
          onHistoryTimeChange={handleHistoryTimeChange}
          showEvents={showEvents}
          onToggleEvents={handleToggleEvents}
          eventsCount={eventsOfInterest.length}
          eventFilterMode={eventFilterMode}
          onEventFilterModeChange={setEventFilterMode}
          eventUpcomingDays={eventUpcomingDays}
          onEventUpcomingDaysChange={setEventUpcomingDays}
          eventTimeRangeStart={eventTimeRangeStart}
          eventTimeRangeEnd={eventTimeRangeEnd}
          onEventTimeRangeChange={handleEventTimeRangeChange}
        />

        {/* Map + Table */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Map row — flex row so details panel sits right of map */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex-1 min-w-0">
              <AircraftMap tracks={mapTracks} historyTracks={mapHistory} importedTracks={mapImported} dbHistoryTracks={mapDbHistory} mapTheme={mapTheme} onToggleTheme={handleToggleTheme} trajectoryStyle={trajectoryStyle} densityTracks={densityTracks} densityMetric={densityMetric} densityAltitudeMin={densityAltitudeMin} densityAltitudeMax={densityAltitudeMax} densityTooltipMode={densityTooltipMode} showDensity={showDensity} liveColorMode={liveColorMode} historyColorMode={historyColorMode} selectedHexIdents={selectedHexIdents} onSelectTrack={handleSelectTrack} receiverLocation={showReceiver ? receiverLocation : undefined} eventsOfInterest={filteredEvents} onContextMenu={handleMapContextMenu} mapPickingMode={mapPickingMode} onMapPickComplete={handleMapPickComplete} onMapPickCancel={handleMapPickCancel} onFlyToReady={(fn) => { flyToRef.current = fn; }} />
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
            {/* AI Chat panel — docked mode (in flex row) */}
            {aiChatOpen && !aiChatFloating && (
              <AIChatPanel
                isOpen={aiChatOpen}
                onToggle={() => setAiChatOpen(false)}
                width={aiChatWidth}
                onWidthChange={setAiChatWidth}
                dockedExpanded={aiChatDockedExpanded}
                onDockedExpandedChange={setAiChatDockedExpanded}
                floating={false}
                onFloatingChange={setAiChatFloating}
                floatX={aiChatFloatX}
                floatY={aiChatFloatY}
                floatW={aiChatFloatW}
                floatH={aiChatFloatH}
                onFloatPosChange={(x, y) => { setAiChatFloatX(x); setAiChatFloatY(y); }}
                onFloatSizeChange={(w, h) => { setAiChatFloatW(w); setAiChatFloatH(h); }}
              >
                <AIChatContent threadId={chatThreadId} />
              </AIChatPanel>
            )}
            {/* Events panel — docked mode (in flex row) */}
            {eventsOpen && !eventsFloating && (
              <EventsOfInterestPanel
                isOpen={eventsOpen}
                onToggle={() => setEventsOpen(false)}
                onNewEvent={handleNewEvent}
                allHidden={allEventsHidden}
                onToggleAllVisibility={handleToggleAllVisibility}
                width={eventsWidth}
                onWidthChange={setEventsWidth}
                dockedExpanded={eventsDockedExpanded}
                onDockedExpandedChange={setEventsDockedExpanded}
                floating={false}
                onFloatingChange={setEventsFloating}
                floatX={eventsPanelX}
                floatY={eventsPanelY}
                floatW={eventsPanelW}
                floatH={eventsPanelH}
                onFloatPosChange={(x: number, y: number) => { setEventsPanelX(x); setEventsPanelY(y); }}
                onFloatSizeChange={(w: number, h: number) => { setEventsPanelW(w); setEventsPanelH(h); }}
              >
                <EventsOfInterestContent
                  events={eventsOfInterest}
                  loading={eventsLoading}
                  onEditEvent={handleEditEvent}
                  onDeleteEvent={removeEvent}
                  onDeleteEvents={removeEvents}
                  hiddenEventIds={hiddenEventIds}
                  onToggleEventVisibility={handleToggleEventVisibility}
                />
              </EventsOfInterestPanel>
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
            onClearAnalysis={() => {
              clearAnalysis();
              setHiddenSections(prev => { const n = new Map(prev); n.delete("analysis"); return n; });
            }}
          />

          {/* Table — explicit height, resizable */}
          <div
            className="bg-slate-900 overflow-hidden flex-shrink-0"
            style={{ height: tableHeight }}
          >
            <AircraftTable
              tracks={sortedTableTracks}
              historyTracks={sortedTableHistory}
              importedTracks={sortedTableImported}
              dbHistoryTracks={sortedTableDbHistory}
              sortKey={sortKey}
              sortAsc={sortAsc}
              onSort={handleSort}
              selectedHexIdents={selectedHexIdents}
              lastSelectedHexIdent={lastSelectedHexIdent}
              onSelectTrack={handleSelectTrack}
              onRemoveTrack={!isLive ? removeAnalysisTrack : undefined}
              onToggleMapVisibility={handleToggleMapVisibility}
              hiddenSections={hiddenSections}
              onToggleGroupVisibility={handleToggleGroupVisibility}
              liveSectionKey={isLive ? "live" : "analysis"}
            />
          </div>
        </main>
      </div>

      {/* Footer metrics */}
      <MetricsBar
        metrics={metrics}
        recordPositions={recordPositions}
        recordRaw={recordRaw}
        onToggleRecordPositions={handleToggleRecordPositions}
        onToggleRecordRaw={handleToggleRecordRaw}
        storageStatus={storageStatus}
        onReleaseStorage={handleReleaseStorage}
        onReclaimStorage={handleReclaimStorage}
        onSwapDatabase={handleSwapDatabase}
        isSwapping={isSwapping}
        onExportDatabase={handleExportDatabase}
        isExporting={isExporting}
        onImportDatabase={handleImportDatabase}
        isImporting={isImporting}
      />

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

      {/* Events panel — floating mode (portal-like, fixed position) */}
      {eventsOpen && eventsFloating && (
        <EventsOfInterestPanel
          isOpen={eventsOpen}
          onToggle={() => setEventsOpen(false)}
          onNewEvent={handleNewEvent}
          allHidden={allEventsHidden}
          onToggleAllVisibility={handleToggleAllVisibility}
          width={eventsWidth}
          onWidthChange={setEventsWidth}
          dockedExpanded={eventsDockedExpanded}
          onDockedExpandedChange={setEventsDockedExpanded}
          floating={true}
          onFloatingChange={setEventsFloating}
          floatX={eventsPanelX}
          floatY={eventsPanelY}
          floatW={eventsPanelW}
          floatH={eventsPanelH}
          onFloatPosChange={(x: number, y: number) => { setEventsPanelX(x); setEventsPanelY(y); }}
          onFloatSizeChange={(w: number, h: number) => { setEventsPanelW(w); setEventsPanelH(h); }}
        >
          <EventsOfInterestContent
            events={eventsOfInterest}
            loading={eventsLoading}
            onEditEvent={handleEditEvent}
            onDeleteEvent={removeEvent}
            onDeleteEvents={removeEvents}
            hiddenEventIds={hiddenEventIds}
            onToggleEventVisibility={handleToggleEventVisibility}
          />
        </EventsOfInterestPanel>
      )}

      {/* AI Chat panel — floating mode */}
      {aiChatOpen && aiChatFloating && (
        <AIChatPanel
          isOpen={aiChatOpen}
          onToggle={() => setAiChatOpen(false)}
          width={aiChatWidth}
          onWidthChange={setAiChatWidth}
          dockedExpanded={aiChatDockedExpanded}
          onDockedExpandedChange={setAiChatDockedExpanded}
          floating={true}
          onFloatingChange={setAiChatFloating}
          floatX={aiChatFloatX}
          floatY={aiChatFloatY}
          floatW={aiChatFloatW}
          floatH={aiChatFloatH}
          onFloatPosChange={(x, y) => { setAiChatFloatX(x); setAiChatFloatY(y); }}
          onFloatSizeChange={(w, h) => { setAiChatFloatW(w); setAiChatFloatH(h); }}
        >
          <AIChatContent threadId={chatThreadId} />
        </AIChatPanel>
      )}

      {/* Event form dialog (create/edit) */}
      {eventFormOpen && (
        <EventFormDialog
          editEvent={editingEvent}
          initialLat={eventFormInitialLat}
          initialLng={eventFormInitialLng}
          onSave={handleEventFormSave}
          onCancel={handleEventFormCancel}
          isPickingFromMap={mapPickingMode !== null}
          onStartMapPick={handleStartMapPick}
          mapPickResult={mapPickResult}
        />
      )}

      {/* Map context menu */}
      {contextMenu && (
        <MapContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          lat={contextMenu.lat}
          lng={contextMenu.lng}
          onCreateEvent={handleCreateEventFromMap}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  );
}
