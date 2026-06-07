import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCopilotContext, type CopilotContextConfig } from "../useCopilotContext";

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
});
