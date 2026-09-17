import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCopilotContext, type CopilotContextConfig } from "../useCopilotContext";
import type { WeatherSnapshot } from "@/lib/weather";

// Capture all readables from useAgentContext calls
const registeredReadables = new Map<string, unknown>();

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgentContext: (opts: { description: string; value: unknown }) => {
    registeredReadables.set(opts.description, opts.value);
  },
}));

function makeConfig(overrides: Partial<CopilotContextConfig> = {}): CopilotContextConfig {
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
    selectedHexIdents: new Set(["A1B2C3"]),
    lastSelectedHexIdent: "A1B2C3",
    activeFilters: {
      callsign: "UAL",
      altitudeMin: 10000,
      altitudeMax: 40000,
      speedMin: 100,
      speedMax: 500,
      includeImportedInFilter: false,
    },
    tracks: [
      { hex_ident: "A1B2C3" } as never,
      { hex_ident: "D4E5F6" } as never,
      { hex_ident: "G7H8I9" } as never,
    ],
    storageStatus: "available",
    receiverLocation: null,
    agentSimulatedCount: 0,
    ...overrides,
  };
}

describe("useCopilotContext", () => {
  beforeEach(() => {
    registeredReadables.clear();
    renderHook(() => useCopilotContext(makeConfig()));
  });

  it("registers a non-trivial number of readables", () => {
    expect(registeredReadables.size).toBeGreaterThanOrEqual(7);
  });

  it("registers active mode", () => {
    expect(registeredReadables.get("Active mode (live or analysis)")).toBe("live");
  });

  it("registers feed connection status", () => {
    expect(registeredReadables.get("Feed connection status")).toBe("connected");
  });

  it("registers storage status", () => {
    expect(registeredReadables.get("Database storage availability")).toBe("available");
  });

  it("registers selected aircraft snapshot", () => {
    const v = registeredReadables.get(
      "Selected aircraft (hex idents) and the most recently selected one",
    ) as { selected: string[]; lastSelected: string | null };
    expect(v.selected).toEqual(["A1B2C3"]);
    expect(v.lastSelected).toBe("A1B2C3");
  });

  it("registers active filters", () => {
    const v = registeredReadables.get(
      "Active aircraft filters (callsign, altitude range, speed range)",
    ) as { callsign: string; altitudeMin: number };
    expect(v.callsign).toBe("UAL");
    expect(v.altitudeMin).toBe(10000);
  });

  it("registers map and sidebar state", () => {
    const v = registeredReadables.get("Map theme and sidebar state") as {
      mapTheme: string;
      sidebarOpen: boolean;
    };
    expect(v.mapTheme).toBe("dark");
    expect(v.sidebarOpen).toBe(true);
  });

  it("registers visible layers", () => {
    const v = registeredReadables.get(
      "Visible map layers (history, density, simulation, imported, receiver, events)",
    ) as Record<string, boolean>;
    expect(v.history).toBe(false);
    expect(v.imported).toBe(true);
    expect(v.events).toBe(true);
  });

  it("registers live track count", () => {
    const v = registeredReadables.get("Live aircraft track count") as {
      trackCount: number;
    };
    expect(v.trackCount).toBe(3);
  });

  it("reflects no selection when nothing is selected", () => {
    registeredReadables.clear();
    renderHook(() =>
      useCopilotContext(
        makeConfig({ selectedHexIdents: new Set(), lastSelectedHexIdent: null }),
      ),
    );
    const v = registeredReadables.get(
      "Selected aircraft (hex idents) and the most recently selected one",
    ) as { selected: string[]; lastSelected: string | null };
    expect(v.selected).toEqual([]);
    expect(v.lastSelected).toBeNull();
  });

  describe("weather layer", () => {
    const WEATHER = "Weather layer (winds aloft): availability, what it draws, and how current the data is";

    function snapshot(validTimeMs: number): WeatherSnapshot {
      return {
        version: 1,
        source: "open-meteo",
        attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
        model: "best_match",
        fetched_at_ms: validTimeMs,
        valid_time_ms: validTimeMs,
        grid: { lat0: 46, lon0: -3, dlat: 1, dlon: 1, nlat: 1, nlon: 1 },
        surface: { wind_dir_deg: [270], wind_speed_kt: [10], mslp_hpa: [1013] },
        levels: { "250": { wind_dir_deg: [250], wind_speed_kt: [100] } },
      };
    }

    function weatherContext(weather: CopilotContextConfig["weather"]) {
      registeredReadables.clear();
      renderHook(() => useCopilotContext(makeConfig({ weather })));
      return registeredReadables.get(WEATHER);
    }

    it("describes what the layer draws and how current it is", () => {
      const value = weatherContext({
        snapshot: snapshot(Date.now()),
        availability: "available",
        show: true,
        level: 250,
        showBarbs: true,
        showParticles: false,
        nowMs: Date.now(),
      });

      expect(value).toMatchObject({
        availability: "available",
        shown: true,
        level: "FL340 · 250 hPa",
        barbs: true,
        particles: false,
        stale: false,
      });
      expect((value as { validity: string }).validity).toMatch(/valid/);
    });

    it("says it is waiting before the first snapshot", () => {
      const value = weatherContext({
        snapshot: null,
        availability: "waiting",
        show: false,
        level: "surface",
        showBarbs: true,
        showParticles: false,
        nowMs: Date.now(),
      });

      expect((value as { validity: string }).validity).toMatch(/waiting/i);
    });

    it("explains an unsupported live source instead of describing the layer", () => {
      const value = weatherContext({
        snapshot: null,
        availability: "unsupported_source",
        show: true,
        level: 250,
        showBarbs: true,
        showParticles: true,
        nowMs: Date.now(),
      });

      expect(value).toMatch(/MQTT/);
    });

    it("is registered even when the page provides no weather", () => {
      expect(weatherContext(undefined)).toBe("unavailable in this view");
    });

    describe("while browsing recorded weather", () => {
      const VIEW_MS = Date.now() - 48 * 3_600_000;

      function browsing(overrides: Record<string, unknown> = {}) {
        return weatherContext({
          snapshot: snapshot(VIEW_MS - 20 * 60_000),
          availability: "available",
          show: true,
          level: 250,
          showBarbs: true,
          showParticles: false,
          nowMs: Date.now(),
          isLive: false,
          viewTimeMs: VIEW_MS,
          ...overrides,
        } as CopilotContextConfig["weather"]);
      }

      it("measures the hour against the time on screen, not against now", () => {
        // `describeValidity` would say "valid 2 d ago", which reads as a fault
        // rather than as the answer -- and the agent has no visual cue to
        // correct it with.
        expect((browsing() as { validity: string }).validity).toMatch(
          /model hour 20 min earlier/,
        );
      });

      it("says which mode it is describing", () => {
        // The invariant: the agent sees what the map shows. Saying so
        // explicitly beats leaving the LLM to infer it from the wording.
        expect(browsing()).toMatchObject({ mode: "history" });
      });

      it("does not blame the live source when showing recorded weather", () => {
        // The step-12 bug in prose, which is worse: text carries no visual cue
        // that it is describing the wrong day. Recorded weather comes out of
        // DuckDB, so a socket session can browse it.
        const value = browsing({ availability: "unsupported_source" });
        expect(JSON.stringify(value)).not.toMatch(/MQTT/i);
        expect(value).toMatchObject({ mode: "history" });
      });

      it("still explains an unsupported source while live", () => {
        // The live branch must not regress.
        const value = weatherContext({
          snapshot: null,
          availability: "unsupported_source",
          show: true,
          level: 250,
          showBarbs: true,
          showParticles: false,
          nowMs: Date.now(),
        });
        expect(value).toMatch(/MQTT/);
      });
    });
  });
});
