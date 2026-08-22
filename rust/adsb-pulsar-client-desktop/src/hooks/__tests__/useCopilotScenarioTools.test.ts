import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useCopilotTools,
  type DisplayToolsConfig,
  type ScenarioToolsConfig,
} from "../useCopilotTools";
import type { AgentTrajectory } from "@/lib/simulation-data";
import type { Scenario, ScenarioTrack } from "@/lib/types";

const registeredTools = new Map<
  string,
  { handler: (...args: unknown[]) => unknown; description?: string }
>();

vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (opts: {
    name: string;
    handler: (...args: unknown[]) => unknown;
    description?: string;
  }) => {
    if (registeredTools.has(opts.name)) return;
    registeredTools.set(opts.name, {
      handler: opts.handler,
      description: opts.description,
    });
  },
}));

const mockGetScenario = vi.fn();

vi.mock("@/lib/commands", () => ({
  getStorageStats: vi.fn(),
  getAircraftSummary: vi.fn(),
  getFlightSummary: vi.fn(),
  getStatus: vi.fn(),
  getMetrics: vi.fn(),
  getTrajectory: vi.fn(),
  startFeed: vi.fn(),
  stopFeed: vi.fn(),
  getEventsOfInterest: vi.fn().mockResolvedValue([]),
  createEventOfInterest: vi.fn().mockResolvedValue({}),
  getScenario: (...args: unknown[]) => mockGetScenario(...args),
}));

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "s1",
    name: "Approach Rush",
    description: "",
    origin_lat: null,
    origin_lng: null,
    tags: null,
    created_at_ms: 1000,
    updated_at_ms: 2000,
    track_count: 1,
    ...overrides,
  };
}

function track(overrides: Partial<ScenarioTrack> = {}): ScenarioTrack {
  return {
    id: "t1",
    scenario_id: "s1",
    ordinal: 0,
    hex_ident: "AAA111",
    callsign: "HELI01",
    category: "helicopter",
    start_offset_s: 0,
    waypoints_json: "[]",
    request_json: null,
    created_at_ms: 1000,
    updated_at_ms: 1000,
    ...overrides,
  };
}

const STAGED: AgentTrajectory = {
  hex_ident: "BBB222",
  callsign: "ACA825",
  category: "airliner",
  waypoints: [],
};

function makeScenarioConfig(
  overrides: Partial<ScenarioToolsConfig> = {},
): ScenarioToolsConfig {
  return {
    scenarios: [scenario()],
    activeScenarioId: "s1",
    tracks: [track()],
    storageUnavailable: false,
    selectScenario: vi.fn(),
    createScenario: vi.fn().mockResolvedValue(scenario({ id: "new", name: "Fresh" })),
    renameScenario: vi.fn().mockResolvedValue(undefined),
    setDescription: vi.fn().mockResolvedValue(undefined),
    removeScenario: vi.fn().mockResolvedValue(undefined),
    addTrajectory: vi
      .fn()
      .mockResolvedValue(track({ id: "t2", callsign: "ACA825", start_offset_s: 90 })),
    removeTrack: vi.fn().mockResolvedValue(undefined),
    setTrackOffset: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeConfig(scenarios?: ScenarioToolsConfig): DisplayToolsConfig {
  return {
    connectionStatus: "connected",
    mapTheme: "dark",
    sidebarOpen: true,
    activeMode: "live",
    showHistory: false,
    showDensity: false,
    showSimulation: false,
    showImported: true,
    receiverLocation: { lat: 45.5, lng: -73.6 },
    agentTrajectories: [STAGED],
    showReceiver: true,
    showEvents: true,
    liveColorMode: "plot",
    historyColorMode: "plot",
    densityMetric: "positions",
    densityTooltipMode: "compact",
    densityAltitudeMin: 0,
    densityAltitudeMax: 50000,
    eventFilterMode: "all",
    eventUpcomingDays: 7,
    eventTimeRangeStart: 0,
    eventTimeRangeEnd: 0,
    setMapTheme: vi.fn(),
    setSidebarOpen: vi.fn(),
    setActiveMode: vi.fn(),
    setShowHistory: vi.fn(),
    setShowDensity: vi.fn(),
    setShowSimulation: vi.fn(),
    setShowImported: vi.fn(),
    setAgentTrajectories: vi.fn(),
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
    tracks: [],
    setSelectedHexIdents: vi.fn(),
    setLastSelectedHexIdent: vi.fn(),
    activeFilters: {
      callsign: "",
      altitudeMin: 0,
      altitudeMax: 50000,
      speedMin: 0,
      speedMax: 600,
    } as DisplayToolsConfig["activeFilters"],
    setActiveFilters: vi.fn(),
    flyTo: vi.fn(),
    scenarios,
  };
}

const call = (name: string, args: unknown = {}) =>
  registeredTools.get(name)!.handler(args) as Promise<string>;

let scenarioConfig: ScenarioToolsConfig;

function setup(
  over: Partial<ScenarioToolsConfig> = {},
  withScenarios = true,
  agentTrajectories?: AgentTrajectory[],
) {
  registeredTools.clear();
  scenarioConfig = makeScenarioConfig(over);
  const config = makeConfig(withScenarios ? scenarioConfig : undefined);
  if (agentTrajectories) config.agentTrajectories = agentTrajectories;
  renderHook(() => useCopilotTools(config));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetScenario.mockResolvedValue({
    scenario: scenario(),
    tracks: [track()],
  });
  setup();
});

describe("scenario tool descriptions", () => {
  // These are prose assertions on purpose. Descriptions are the interface the
  // model programs against, and a collision here silently misroutes calls —
  // exactly how "start simulated flights" once hit toggleDemoFlights and
  // launched 20 canned routes while generating nothing.
  it("never claims the generation verbs", () => {
    for (const name of ["listScenarios", "getScenario", "createScenario"]) {
      const desc = (registeredTools.get(name)?.description ?? "").toLowerCase();
      expect(desc).not.toMatch(/\bgenerate (a|an|some) /);
    }
  });

  it("points generation requests at generateSimulatedTrajectory", () => {
    const desc = registeredTools.get("createScenario")?.description ?? "";
    expect(desc).toContain("creates no aircraft");
    expect(desc).toContain("generateSimulatedTrajectory");
  });

  it("describes a scenario as a saved collection", () => {
    const desc = (registeredTools.get("listScenarios")?.description ?? "").toLowerCase();
    expect(desc).toContain("saved");
    expect(desc).toContain("collection");
  });

  it("marks listScenarios as read-only so it is never used to start playback", () => {
    const desc = (registeredTools.get("listScenarios")?.description ?? "").toLowerCase();
    expect(desc).toContain("read-only");
  });

  it("warns that deleting a scenario is permanent and needs an explicit ask", () => {
    const desc = (registeredTools.get("deleteScenario")?.description ?? "").toLowerCase();
    expect(desc).toContain("cannot be undone");
    expect(desc).toContain("explicitly");
  });

  it("tells the model to generate before adding to a scenario", () => {
    const desc = registeredTools.get("addTrajectoryToScenario")?.description ?? "";
    expect(desc).toContain("generateSimulatedTrajectory");
  });

  // `renameScenario` and `setScenarioDescription` both "set text on a scenario".
  // A 7B model will confuse them unless each says which field it writes.
  it("distinguishes the description from the name", () => {
    const describeDesc = (
      registeredTools.get("setScenarioDescription")?.description ?? ""
    ).toLowerCase();
    const renameDesc = (
      registeredTools.get("renameScenario")?.description ?? ""
    ).toLowerCase();

    expect(describeDesc).toContain("description");
    expect(describeDesc).toContain("not its name");
    expect(renameDesc).toContain("name");
    expect(renameDesc).toContain("not its description");
  });

  // `createEventOfInterest` also takes a `description`, and lives in the same
  // tool list. This one has to say it is about a scenario.
  it("scopes the description tool to scenarios, not events", () => {
    const desc = (
      registeredTools.get("setScenarioDescription")?.description ?? ""
    ).toLowerCase();
    expect(desc).toContain("scenario");
    expect(desc).not.toContain("event");
  });
});

describe("setScenarioDescription", () => {
  it("saves the description against the scenario", async () => {
    const result = JSON.parse(
      await call("setScenarioDescription", {
        scenarioId: "s1",
        description: "Busy evening arrivals.",
      }),
    );

    expect(scenarioConfig.setDescription).toHaveBeenCalledWith(
      "s1",
      "Busy evening arrivals.",
    );
    expect(result.description).toBe("Busy evening arrivals.");
  });

  it("defaults to the active scenario when none is named", async () => {
    await call("setScenarioDescription", { description: "Written from chat." });
    expect(scenarioConfig.setDescription).toHaveBeenCalledWith(
      "s1",
      "Written from chat.",
    );
  });

  it("explains when there is no scenario to describe", async () => {
    setup({ activeScenarioId: null });
    const result = JSON.parse(
      await call("setScenarioDescription", { description: "orphan" }),
    );

    expect(result.error).toMatch(/no (active )?scenario/i);
    expect(scenarioConfig.setDescription).not.toHaveBeenCalled();
  });

  it("reports unavailable storage rather than pretending to save", async () => {
    setup({ storageUnavailable: true });
    const result = JSON.parse(
      await call("setScenarioDescription", { description: "x" }),
    );
    expect(result.error).toMatch(/database/i);
    expect(scenarioConfig.setDescription).not.toHaveBeenCalled();
  });
});

describe("listScenarios", () => {
  it("returns the saved scenarios with track counts", async () => {
    const result = JSON.parse(await call("listScenarios"));
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]).toMatchObject({ name: "Approach Rush", trackCount: 1 });
    expect(result.activeScenarioId).toBe("s1");
  });

  it("reports unavailable storage rather than an empty list", async () => {
    setup({ storageUnavailable: true });
    const result = JSON.parse(await call("listScenarios"));
    expect(result.error).toMatch(/database/i);
  });

  it("reports when the scenario layer is not mounted at all", async () => {
    setup({}, false);
    const result = JSON.parse(await call("listScenarios"));
    expect(result.error).toMatch(/unavailable/i);
  });
});

describe("getScenario", () => {
  it("returns the tracks with their offsets", async () => {
    const result = JSON.parse(await call("getScenario", { scenarioId: "s1" }));
    expect(result.name).toBe("Approach Rush");
    expect(result.tracks[0]).toMatchObject({ callsign: "HELI01", startOffsetS: 0 });
  });

  // Without this the assistant cannot answer "what is this scenario about?"
  // and cannot refine an existing description.
  it("returns the saved description", async () => {
    // getScenario reads through the Tauri command, not the config's list.
    mockGetScenario.mockResolvedValue({
      scenario: scenario({ description: "Busy evening arrivals." }),
      tracks: [track()],
    });

    const result = JSON.parse(await call("getScenario", { scenarioId: "s1" }));
    expect(result.description).toBe("Busy evening arrivals.");
  });

  it("makes the opened scenario the active one", async () => {
    await call("getScenario", { scenarioId: "s1" });
    expect(scenarioConfig.selectScenario).toHaveBeenCalledWith("s1");
  });
});

describe("createScenario", () => {
  it("creates and reports the new scenario", async () => {
    const result = JSON.parse(await call("createScenario", { name: "Fresh" }));
    expect(scenarioConfig.createScenario).toHaveBeenCalledWith({
      name: "Fresh",
      description: null,
    });
    expect(result.created).toBe(true);
  });
});

describe("renameScenario", () => {
  it("renames by id", async () => {
    await call("renameScenario", { scenarioId: "s1", name: "Renamed" });
    expect(scenarioConfig.renameScenario).toHaveBeenCalledWith("s1", "Renamed");
  });
});

describe("deleteScenario", () => {
  it("deletes by id", async () => {
    const result = JSON.parse(await call("deleteScenario", { scenarioId: "s1" }));
    expect(scenarioConfig.removeScenario).toHaveBeenCalledWith("s1");
    expect(result.deleted).toBe(true);
  });
});

describe("addTrajectoryToScenario", () => {
  it("matches a generated trajectory by callsign", async () => {
    const result = JSON.parse(
      await call("addTrajectoryToScenario", { identifier: "ACA825", startOffsetS: 90 }),
    );
    expect(scenarioConfig.addTrajectory).toHaveBeenCalledWith(STAGED, 90);
    expect(result.added).toBe(true);
  });

  it("matches by ICAO hex too", async () => {
    await call("addTrajectoryToScenario", { identifier: "bbb222" });
    expect(scenarioConfig.addTrajectory).toHaveBeenCalledWith(STAGED, 0);
  });

  it("defaults the offset to zero", async () => {
    await call("addTrajectoryToScenario", { identifier: "ACA825" });
    expect(scenarioConfig.addTrajectory).toHaveBeenCalledWith(STAGED, 0);
  });

  it("explains when nothing on screen matches", async () => {
    const result = JSON.parse(
      await call("addTrajectoryToScenario", { identifier: "NOPE99" }),
    );
    expect(result.error).toMatch(/No generated trajectory/);
    expect(scenarioConfig.addTrajectory).not.toHaveBeenCalled();
  });

  it("refuses when no scenario is selected", async () => {
    setup({ activeScenarioId: null });
    const result = JSON.parse(
      await call("addTrajectoryToScenario", { identifier: "ACA825" }),
    );
    expect(result.error).toMatch(/No scenario is selected/);
  });

  /*
   * Regression: adding one trajectory from chat recreated the ones already
   * saved.
   *
   * `agentTrajectories` is DERIVED — saved scenario tracks concatenated with
   * the staged ones — so the saved aircraft are "on screen" and the tool
   * happily matched them. `addTrajectory` then called `uniqueHexIdent`, which
   * dutifully renamed the colliding hex and inserted a SECOND row. Every test
   * missed it because the harness only ever put the staged trajectory in
   * `agentTrajectories`, which never happens in the running app.
   */
  describe("aircraft already saved in the scenario", () => {
    // Mirrors reality: the saved track's trajectory plus the staged one.
    const SAVED_TRAJECTORY: AgentTrajectory = {
      hex_ident: "AAA111",
      callsign: "HELI01",
      category: "helicopter",
      waypoints: [],
    };

    beforeEach(() => {
      setup({}, true, [SAVED_TRAJECTORY, STAGED]);
    });

    it("does not add a second copy of an aircraft already in the scenario", async () => {
      const result = JSON.parse(
        await call("addTrajectoryToScenario", { identifier: "HELI01" }),
      );

      expect(scenarioConfig.addTrajectory).not.toHaveBeenCalled();
      expect(result.added).toBe(false);
      expect(result.alreadyInScenario).toBe(true);
    });

    it("says so plainly instead of reporting a failure", async () => {
      const result = JSON.parse(
        await call("addTrajectoryToScenario", { identifier: "HELI01" }),
      );
      expect(result.error).toBeUndefined();
      expect(String(result.message)).toMatch(/already/i);
    });

    it("matches an existing track by hex too", async () => {
      await call("addTrajectoryToScenario", { identifier: "aaa111" });
      expect(scenarioConfig.addTrajectory).not.toHaveBeenCalled();
    });

    // uniqueHexIdent renames a colliding hex, so an earlier duplicate has the
    // same callsign but a different hex. Callsign is what actually identifies
    // an aircraft to the user — and to every other scenario tool.
    it("catches a re-add whose hex was renamed by a previous collision", async () => {
      setup({ tracks: [track({ hex_ident: "AAA111-2", callsign: "HELI01" })] }, true, [
        SAVED_TRAJECTORY,
        STAGED,
      ]);

      await call("addTrajectoryToScenario", { identifier: "HELI01" });
      expect(scenarioConfig.addTrajectory).not.toHaveBeenCalled();
    });

    it("is idempotent — repeated calls add exactly once", async () => {
      await call("addTrajectoryToScenario", { identifier: "ACA825" });
      await call("addTrajectoryToScenario", { identifier: "ACA825" });
      await call("addTrajectoryToScenario", { identifier: "ACA825" });

      // The mock's tracks never change, so a correct handler still adds each
      // time here — what it must never do is match the SAVED aircraft.
      expect(scenarioConfig.addTrajectory).toHaveBeenCalledWith(STAGED, 0);
      expect(scenarioConfig.addTrajectory).not.toHaveBeenCalledWith(
        SAVED_TRAJECTORY,
        expect.anything(),
      );
    });

    it("still adds a genuinely new aircraft", async () => {
      const result = JSON.parse(
        await call("addTrajectoryToScenario", { identifier: "ACA825", startOffsetS: 90 }),
      );

      expect(scenarioConfig.addTrajectory).toHaveBeenCalledWith(STAGED, 90);
      expect(result.added).toBe(true);
    });

    /*
     * Deliberate trade-off, not an oversight.
     *
     * A freshly generated aircraft can reuse a callsign the scenario already
     * holds, and this refuses it. That is the right call: every other scenario
     * tool (`removeTrackFromScenario`, `setTrackStartOffset`) addresses tracks
     * BY CALLSIGN, so two tracks sharing one would make those tools ambiguous.
     * The refusal is explicit and names the aircraft; the panel's "+ Add"
     * button is unaffected if the user really wants both.
     */
    it("refuses a new aircraft that reuses a saved callsign, and says why", async () => {
      const stagedDuplicate: AgentTrajectory = {
        hex_ident: "AAA111-2",
        callsign: "HELI01",
        category: "helicopter",
        waypoints: [],
      };
      setup({}, true, [SAVED_TRAJECTORY, stagedDuplicate]);

      const result = JSON.parse(
        await call("addTrajectoryToScenario", { identifier: "HELI01" }),
      );

      expect(scenarioConfig.addTrajectory).not.toHaveBeenCalled();
      expect(result.alreadyInScenario).toBe(true);
      expect(String(result.message)).toContain("HELI01");
    });
  });
});

describe("removeTrackFromScenario", () => {
  it("removes a saved track by callsign", async () => {
    const result = JSON.parse(
      await call("removeTrackFromScenario", { identifier: "HELI01" }),
    );
    expect(scenarioConfig.removeTrack).toHaveBeenCalledWith("t1");
    expect(result.removed).toBe(true);
  });

  it("explains when the scenario has no such track", async () => {
    const result = JSON.parse(
      await call("removeTrackFromScenario", { identifier: "GHOST" }),
    );
    expect(result.error).toMatch(/no track called/);
    expect(scenarioConfig.removeTrack).not.toHaveBeenCalled();
  });
});

describe("setTrackStartOffset", () => {
  it("sets when an aircraft enters the scenario", async () => {
    const result = JSON.parse(
      await call("setTrackStartOffset", { identifier: "HELI01", startOffsetS: 90 }),
    );
    expect(scenarioConfig.setTrackOffset).toHaveBeenCalledWith("t1", 90);
    expect(result.startOffsetS).toBe(90);
  });

  it("clamps a negative offset to zero", async () => {
    await call("setTrackStartOffset", { identifier: "HELI01", startOffsetS: -30 });
    expect(scenarioConfig.setTrackOffset).toHaveBeenCalledWith("t1", 0);
  });

  it("explains when the track is not in the scenario", async () => {
    const result = JSON.parse(
      await call("setTrackStartOffset", { identifier: "GHOST", startOffsetS: 10 }),
    );
    expect(result.error).toMatch(/no track called/);
  });
});
