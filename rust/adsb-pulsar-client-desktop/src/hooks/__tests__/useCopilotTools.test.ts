import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCopilotTools, type DisplayToolsConfig } from "../useCopilotTools";

// Capture all tool registrations from useFrontendTool calls
const registeredTools = new Map<
  string,
  { handler: Function; parameters?: unknown; description?: string }
>();

// Mirror production v2 semantics: useFrontendTool registers via useEffect with
// deps [name, available, copilotkit, ...extraDeps]. Calling the hook multiple
// times with the same name (e.g. on every render) does NOT replace the handler
// — the first registration wins. Tests that rely on "latest handler wins" are
// lying about production behavior and will hide stale-closure bugs.
vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (opts: {
    name: string;
    handler: Function;
    parameters?: unknown;
    description?: string;
  }) => {
    if (registeredTools.has(opts.name)) return;
    registeredTools.set(opts.name, {
      handler: opts.handler,
      parameters: opts.parameters,
      description: opts.description,
    });
  },
}));

vi.mock("@/lib/commands", () => ({
  getStorageStats: vi.fn(),
  getAircraftSummary: vi.fn(),
  getFlightSummary: vi.fn(),
  getStatus: vi.fn(),
  getMetrics: vi.fn(),
  getTrajectory: vi.fn(),
  startFeed: vi.fn(),
  stopFeed: vi.fn(),
  getEventsOfInterest: vi.fn().mockResolvedValue([
    { id: "e1", title: "Test Event", category: "test", timestamp_ms: 1000 },
  ]),
  createEventOfInterest: vi.fn().mockResolvedValue({
    id: "e2", title: "New Event", category: null, timestamp_ms: 2000,
  }),
}));

function makeConfig(overrides: Partial<DisplayToolsConfig> = {}): DisplayToolsConfig {
  return {
    connectionStatus: "connected",
    mapTheme: "dark",
    sidebarOpen: true,
    activeMode: "live",
    showHistory: false,
    showDensity: false,
    showSimulation: false,
    showImported: true,
    showReceiver: true,
    showEvents: true,
    liveColorMode: "track",
    historyColorMode: "track",
    densityMetric: "positions",
    densityTooltipMode: "compact",
    densityAltitudeMin: 0,
    densityAltitudeMax: 50000,
    eventFilterMode: "all",
    eventUpcomingDays: 7,
    eventTimeRangeStart: 1000,
    eventTimeRangeEnd: 2000,
    setMapTheme: vi.fn(),
    setSidebarOpen: vi.fn(),
    setActiveMode: vi.fn(),
    setShowHistory: vi.fn(),
    setShowDensity: vi.fn(),
    setShowSimulation: vi.fn(),
    setShowImported: vi.fn(),
    setShowReceiver: vi.fn(),
    setShowEvents: vi.fn(),
    setLiveColorMode: vi.fn(),
    setHistoryColorMode: vi.fn(),
    setDensityMetric: vi.fn(),
    setDensityTooltipMode: vi.fn(),
    setDensityAltitudeMin: vi.fn(),
    setDensityAltitudeMax: vi.fn(),
    setEventFilterMode: vi.fn(),
    setEventUpcomingDays: vi.fn(),
    setEventTimeRangeStart: vi.fn(),
    setEventTimeRangeEnd: vi.fn(),
    // Track navigation config
    tracks: [
      { hex_ident: "A1B2C3", callsign: "UAL123", latitude: 48.8, longitude: 2.3, altitude: 35000, ground_speed: 450, track: 90, vertical_rate: 500, squawk: "1200", is_on_ground: false, timestamp: "2024-01-01T00:00:00Z", positions: [[48.8, 2.3, 35000]], first_seen: 1000, last_seen: 3000, message_count: 10 },
      { hex_ident: "D4E5F6", callsign: "BAW456", latitude: 51.5, longitude: -0.1, altitude: 28000, ground_speed: 380, track: 180, vertical_rate: null, squawk: "7700", is_on_ground: false, timestamp: "2024-01-01T00:00:00Z", positions: [[51.5, -0.1, 28000]], first_seen: 1000, last_seen: 2000, message_count: 5 },
      { hex_ident: "G7H8I9", callsign: "RYR789", latitude: 40.6, longitude: -73.8, altitude: 0, ground_speed: 15, track: 350, vertical_rate: null, squawk: "1200", is_on_ground: true, timestamp: "2024-01-01T00:00:00Z", positions: [], first_seen: 500, last_seen: 2500, message_count: 20 },
    ],
    setSelectedHexIdents: vi.fn(),
    setLastSelectedHexIdent: vi.fn(),
    setActiveFilters: vi.fn(),
    activeFilters: { callsign: "", altitudeMin: 0, altitudeMax: 50000, speedMin: 0, speedMax: 600, includeImportedInFilter: false },
    flyTo: vi.fn(),
    ...overrides,
  };
}

function getHandler(name: string): Function {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler;
}

describe("useCopilotTools — display control tools", () => {
  let config: DisplayToolsConfig;

  beforeEach(() => {
    registeredTools.clear();
    config = makeConfig();
    renderHook(() => useCopilotTools(config));
  });

  it("registers all 24 tools", () => {
    expect(registeredTools.size).toBe(24);
  });

  describe("count-question tool descriptions", () => {
    function descOf(name: string): string {
      const desc = registeredTools.get(name)?.description;
      if (!desc) throw new Error(`Tool "${name}" missing description`);
      return desc;
    }

    it("searchLiveFlights is labeled Live and advertises total for active-count questions", () => {
      const desc = descOf("searchLiveFlights");
      expect(desc).toMatch(/\bLive\b/);
      expect(desc).toMatch(/\btotal\b/);
      expect(desc.toLowerCase()).toContain("how many");
    });

    it("getFlightSummary is labeled Historical and advertises total", () => {
      const desc = descOf("getFlightSummary");
      expect(desc).toMatch(/\bHistorical\b/);
      expect(desc).toMatch(/\btotal\b/);
    });

    it("getAircraftSummary is labeled Historical and advertises total", () => {
      const desc = descOf("getAircraftSummary");
      expect(desc).toMatch(/\bHistorical\b/);
      expect(desc).toMatch(/\btotal\b/);
    });

    it("getStorageStats advertises flight_count for in-total questions", () => {
      const desc = descOf("getStorageStats");
      expect(desc).toContain("flight_count");
    });
  });

  describe("getCurrentDateTime", () => {
    it("returns current date, time, timezone, and epoch ms", async () => {
      const before = Date.now();
      const result = JSON.parse(await getHandler("getCurrentDateTime")());
      const after = Date.now();
      expect(result.epochMs).toBeGreaterThanOrEqual(before);
      expect(result.epochMs).toBeLessThanOrEqual(after);
      expect(result.iso8601).toBeDefined();
      expect(result.timezone).toBeDefined();
      expect(result.date).toBeDefined();
      expect(result.time).toBeDefined();
    });
  });

  describe("getConnectionStatus", () => {
    it("returns connection status and display state from config", async () => {
      const result = JSON.parse(await getHandler("getConnectionStatus")());
      expect(result.connectionStatus).toBe("connected");
      expect(result.activeMode).toBe("live");
      expect(result.mapTheme).toBe("dark");
      expect(result.sidebarOpen).toBe(true);
    });
  });

  describe("toggleSidebar", () => {
    it("toggles when no explicit value provided", async () => {
      const result = JSON.parse(await getHandler("toggleSidebar")({}));
      expect(result.sidebarOpen).toBe(false); // was true, toggled
      expect(config.setSidebarOpen).toHaveBeenCalledWith(false);
    });

    it("sets explicit value", async () => {
      const result = JSON.parse(await getHandler("toggleSidebar")({ open: true }));
      expect(result.sidebarOpen).toBe(true);
      expect(config.setSidebarOpen).toHaveBeenCalledWith(true);
    });
  });

  describe("setMapTheme", () => {
    it("sets theme to light", async () => {
      const result = JSON.parse(await getHandler("setMapTheme")({ theme: "light" }));
      expect(result.mapTheme).toBe("light");
      expect(config.setMapTheme).toHaveBeenCalledWith("light");
    });
  });

  describe("setActiveMode", () => {
    it("switches to analysis mode", async () => {
      const result = JSON.parse(await getHandler("setActiveMode")({ mode: "analysis" }));
      expect(result.activeMode).toBe("analysis");
      expect(config.setActiveMode).toHaveBeenCalledWith("analysis");
    });
  });

  describe("toggleDemoFlights", () => {
    it("toggles when no explicit value provided", async () => {
      const result = JSON.parse(await getHandler("toggleDemoFlights")({}));
      expect(result.demoFlights).toBe(true); // was false, toggled
      expect(config.setShowSimulation).toHaveBeenCalled();
    });

    it("sets explicit enable", async () => {
      const result = JSON.parse(await getHandler("toggleDemoFlights")({ enabled: true }));
      expect(result.demoFlights).toBe(true);
      expect(config.setShowSimulation).toHaveBeenCalled();
    });

    it("sets explicit disable", async () => {
      registeredTools.clear();
      config = makeConfig({ showSimulation: true });
      renderHook(() => useCopilotTools(config));
      const result = JSON.parse(await getHandler("toggleDemoFlights")({ enabled: false }));
      expect(result.demoFlights).toBe(false);
    });
  });

  describe("setLayerVisibility", () => {
    it("sets only provided layers", async () => {
      const result = JSON.parse(
        await getHandler("setLayerVisibility")({ history: true, density: true })
      );
      expect(result.updated.history).toBe(true);
      expect(result.updated.density).toBe(true);
      expect(config.setShowHistory).toHaveBeenCalled();
      expect(config.setShowDensity).toHaveBeenCalled();
      // Others not called
      expect(config.setShowSimulation).not.toHaveBeenCalled();
      expect(config.setShowImported).not.toHaveBeenCalled();
    });

    it("handles all layers at once", async () => {
      await getHandler("setLayerVisibility")({
        history: true, density: false, simulation: true,
        imported: false, receiver: true, events: false,
      });
      expect(config.setShowHistory).toHaveBeenCalled();
      expect(config.setShowDensity).toHaveBeenCalled();
      expect(config.setShowSimulation).toHaveBeenCalled();
      expect(config.setShowImported).toHaveBeenCalled();
      expect(config.setShowReceiver).toHaveBeenCalled();
      expect(config.setShowEvents).toHaveBeenCalled();
    });
  });

  describe("setColorMode", () => {
    it("sets live color mode only", async () => {
      const result = JSON.parse(
        await getHandler("setColorMode")({ liveColorMode: "plot" })
      );
      expect(result.liveColorMode).toBe("plot");
      expect(result.historyColorMode).toBe("track"); // unchanged, from config
      expect(config.setLiveColorMode).toHaveBeenCalledWith("plot");
      expect(config.setHistoryColorMode).not.toHaveBeenCalled();
    });

    it("sets both color modes", async () => {
      await getHandler("setColorMode")({ liveColorMode: "plot", historyColorMode: "plot" });
      expect(config.setLiveColorMode).toHaveBeenCalledWith("plot");
      expect(config.setHistoryColorMode).toHaveBeenCalledWith("plot");
    });
  });

  describe("setDensityConfig", () => {
    it("sets metric only", async () => {
      const result = JSON.parse(
        await getHandler("setDensityConfig")({ metric: "aircraft" })
      );
      expect(result.metric).toBe("aircraft");
      expect(config.setDensityMetric).toHaveBeenCalledWith("aircraft");
      expect(config.setDensityAltitudeMin).not.toHaveBeenCalled();
    });

    it("sets altitude range", async () => {
      await getHandler("setDensityConfig")({ altitudeMin: 1000, altitudeMax: 30000 });
      expect(config.setDensityAltitudeMin).toHaveBeenCalledWith(1000);
      expect(config.setDensityAltitudeMax).toHaveBeenCalledWith(30000);
    });
  });

  describe("setEventFilter", () => {
    it("sets filter mode", async () => {
      const result = JSON.parse(
        await getHandler("setEventFilter")({ mode: "upcoming" })
      );
      expect(result.mode).toBe("upcoming");
      expect(config.setEventFilterMode).toHaveBeenCalledWith("upcoming");
    });

    it("sets upcoming days", async () => {
      await getHandler("setEventFilter")({ upcomingDays: 14 });
      expect(config.setEventUpcomingDays).toHaveBeenCalledWith(14);
    });

    it("sets time range", async () => {
      await getHandler("setEventFilter")({ timeRangeStartMs: 5000, timeRangeEndMs: 10000 });
      expect(config.setEventTimeRangeStart).toHaveBeenCalledWith(5000);
      expect(config.setEventTimeRangeEnd).toHaveBeenCalledWith(10000);
    });
  });

  describe("getEventsOfInterest", () => {
    it("calls command and returns events", async () => {
      const result = JSON.parse(await getHandler("getEventsOfInterest")({}));
      expect(result).toEqual([
        { id: "e1", title: "Test Event", category: "test", timestamp_ms: 1000 },
      ]);
    });

    it("accepts optional time range params", async () => {
      await getHandler("getEventsOfInterest")({ startMs: 1000, endMs: 2000 });
      const { getEventsOfInterest } = await import("@/lib/commands");
      expect(getEventsOfInterest).toHaveBeenCalledWith({
        start_ms: 1000,
        end_ms: 2000,
        category: null,
      });
    });

    it("accepts optional category param", async () => {
      await getHandler("getEventsOfInterest")({ category: "surveillance" });
      const { getEventsOfInterest } = await import("@/lib/commands");
      expect(getEventsOfInterest).toHaveBeenCalledWith({
        start_ms: null,
        end_ms: null,
        category: "surveillance",
      });
    });
  });

  describe("createEventOfInterest", () => {
    it("calls command with required params and returns event", async () => {
      const result = JSON.parse(
        await getHandler("createEventOfInterest")({
          title: "New Event",
          latitude: 48.8,
          longitude: 2.3,
        })
      );
      expect(result.id).toBe("e2");
      expect(result.title).toBe("New Event");
    });
  });

  describe("selectAircraft", () => {
    it("selects aircraft by hex ident", async () => {
      const result = JSON.parse(
        await getHandler("selectAircraft")({ hexIdent: "A1B2C3" })
      );
      expect(result.selected).toBe("A1B2C3");
      expect(config.setSelectedHexIdents).toHaveBeenCalled();
      expect(config.setLastSelectedHexIdent).toHaveBeenCalledWith("A1B2C3");
    });

    it("returns not found for unknown hex ident", async () => {
      const result = JSON.parse(
        await getHandler("selectAircraft")({ hexIdent: "ZZZZZZ" })
      );
      expect(result.error).toBeDefined();
      expect(config.setSelectedHexIdents).not.toHaveBeenCalled();
    });
  });

  describe("setFilters", () => {
    it("sets callsign filter", async () => {
      const result = JSON.parse(
        await getHandler("setFilters")({ callsign: "UAL" })
      );
      expect(result.callsign).toBe("UAL");
      expect(config.setActiveFilters).toHaveBeenCalled();
    });

    it("sets altitude range", async () => {
      const result = JSON.parse(
        await getHandler("setFilters")({ altitudeMin: 10000, altitudeMax: 40000 })
      );
      expect(result.altitudeMin).toBe(10000);
      expect(result.altitudeMax).toBe(40000);
    });

    it("preserves existing filters for unset fields", async () => {
      const result = JSON.parse(
        await getHandler("setFilters")({ callsign: "BAW" })
      );
      // Should carry forward the existing altitude values
      expect(result.altitudeMin).toBe(0);
      expect(result.altitudeMax).toBe(50000);
    });

    it("clears filters when called with empty args", async () => {
      const result = JSON.parse(
        await getHandler("setFilters")({})
      );
      expect(result.callsign).toBe("");
      expect(result.altitudeMin).toBe(0);
      expect(result.altitudeMax).toBe(50000);
    });
  });

  describe("panMapTo", () => {
    it("calls flyTo with coordinates and zoom", async () => {
      const result = JSON.parse(
        await getHandler("panMapTo")({ latitude: 48.8, longitude: 2.3, zoom: 10 })
      );
      expect(result.latitude).toBe(48.8);
      expect(result.longitude).toBe(2.3);
      expect(result.zoom).toBe(10);
      expect(config.flyTo).toHaveBeenCalledWith(48.8, 2.3, 10);
    });

    it("uses default zoom when not provided", async () => {
      const result = JSON.parse(
        await getHandler("panMapTo")({ latitude: 51.5, longitude: -0.1 })
      );
      expect(result.zoom).toBe(12);
      expect(config.flyTo).toHaveBeenCalledWith(51.5, -0.1, 12);
    });
  });

  describe("searchLiveFlights", () => {
    it("returns all tracks when called with no filters", async () => {
      const result = JSON.parse(await getHandler("searchLiveFlights")({}));
      expect(result.total).toBe(3);
      expect(result.showing).toBe(3);
      expect(result.flights).toHaveLength(3);
    });

    it("returns flight summary fields", async () => {
      const result = JSON.parse(await getHandler("searchLiveFlights")({}));
      const flight = result.flights.find((f: { hex_ident: string }) => f.hex_ident === "A1B2C3");
      expect(flight).toMatchObject({
        hex_ident: "A1B2C3",
        callsign: "UAL123",
        altitude: 35000,
        ground_speed: 450,
        track: 90,
        latitude: 48.8,
        longitude: 2.3,
        vertical_rate: 500,
        squawk: "1200",
        is_on_ground: false,
        message_count: 10,
        first_seen: 1000,
        last_seen: 3000,
        positionCount: 1,
      });
    });

    it("filters by callsign substring (case-insensitive)", async () => {
      const result = JSON.parse(await getHandler("searchLiveFlights")({ callsign: "ual" }));
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("A1B2C3");
    });

    it("filters by hex ident substring", async () => {
      const result = JSON.parse(await getHandler("searchLiveFlights")({ callsign: "d4e5" }));
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("D4E5F6");
    });

    it("filters by altitude range", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ altitudeMin: 30000, altitudeMax: 40000 })
      );
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("A1B2C3");
    });

    it("filters by speed range", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ speedMin: 400 })
      );
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("A1B2C3");
    });

    it("filters by onGround=true", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ onGround: true })
      );
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("G7H8I9");
    });

    it("filters by onGround=false", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ onGround: false })
      );
      expect(result.total).toBe(2);
      expect(result.flights.map((f: { hex_ident: string }) => f.hex_ident)).toContain("A1B2C3");
      expect(result.flights.map((f: { hex_ident: string }) => f.hex_ident)).toContain("D4E5F6");
    });

    it("filters by squawk exact match", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ squawk: "7700" })
      );
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("D4E5F6");
    });

    it("filters by heading range", async () => {
      // BAW456 has track=180, should be in 170-190 range
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ headingMin: 170, headingMax: 190 })
      );
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("D4E5F6");
    });

    it("filters by wrapping heading range (northbound: 340-20)", async () => {
      // RYR789 has track=350, should match 340-20 (wrapping range)
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ headingMin: 340, headingMax: 20 })
      );
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("G7H8I9");
    });

    it("sorts by altitude descending", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ sortBy: "altitude", sortOrder: "desc" })
      );
      expect(result.flights[0].hex_ident).toBe("A1B2C3"); // 35000
      expect(result.flights[1].hex_ident).toBe("D4E5F6"); // 28000
    });

    it("sorts by altitude ascending", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ sortBy: "altitude", sortOrder: "asc" })
      );
      expect(result.flights[0].altitude).toBeLessThanOrEqual(result.flights[1].altitude);
    });

    it("sorts by speed descending by default", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ sortBy: "speed" })
      );
      expect(result.flights[0].ground_speed).toBeGreaterThanOrEqual(result.flights[1].ground_speed!);
    });

    it("sorts by messages", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ sortBy: "messages", sortOrder: "desc" })
      );
      expect(result.flights[0].hex_ident).toBe("G7H8I9"); // 20 messages
    });

    it("sorts by recent (last_seen)", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ sortBy: "recent", sortOrder: "desc" })
      );
      expect(result.flights[0].hex_ident).toBe("A1B2C3"); // last_seen: 3000
    });

    it("respects limit parameter", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({ limit: 1 })
      );
      expect(result.total).toBe(3);
      expect(result.showing).toBe(1);
      expect(result.flights).toHaveLength(1);
    });

    it("combines multiple filters", async () => {
      const result = JSON.parse(
        await getHandler("searchLiveFlights")({
          onGround: false,
          altitudeMin: 30000,
          squawk: "1200",
        })
      );
      expect(result.total).toBe(1);
      expect(result.flights[0].hex_ident).toBe("A1B2C3");
    });

    it("sees tracks that arrived AFTER first render (no stale closure)", async () => {
      // Regression for the stale-closure bug: useFrontendTool's useEffect
      // registers the handler once on mount, so handlers must read live state
      // via a ref — not by capturing config.tracks in the closure. Without
      // the configRef pattern, the handler returns the snapshot from first
      // render (empty) forever, no matter what subsequent renders provide.
      registeredTools.clear();
      const emptyCfg = makeConfig({ tracks: [] });
      const { rerender } = renderHook((c: DisplayToolsConfig) => useCopilotTools(c), {
        initialProps: emptyCfg,
      });
      // Aircraft arrive after the chat opened: re-render with three tracks.
      rerender(makeConfig());
      const result = JSON.parse(await getHandler("searchLiveFlights")({}));
      expect(result.total).toBe(3);
    });
  });
});
