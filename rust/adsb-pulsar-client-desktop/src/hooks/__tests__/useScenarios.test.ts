import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import { useScenarios } from "../useScenarios";
import type { Scenario, ScenarioTrack } from "@/lib/types";
import type { AgentTrajectory } from "@/lib/simulation-data";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "s1",
    name: "Approach Rush",
    description: "",
    origin_lat: null,
    origin_lng: null,
    tags: null,
    created_at_ms: 1000,
    updated_at_ms: 1000,
    track_count: 0,
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
    waypoints_json: JSON.stringify([
      {
        lat: 45.5,
        lng: -73.6,
        alt_ft: 1000,
        speed_kts: 80,
        heading_deg: 90,
        phase: "cruise",
        t_offset_s: 0,
      },
    ]),
    request_json: null,
    created_at_ms: 1000,
    updated_at_ms: 1000,
    ...overrides,
  };
}

const trajectory: AgentTrajectory = {
  hex_ident: "BBB222",
  callsign: "ACA825",
  category: "airliner",
  waypoints: [
    {
      lat: 45.5,
      lng: -73.6,
      alt_ft: 12000,
      speed_kts: 260,
      heading_deg: 270,
      phase: "cruise",
      t_offset_s: 0,
    },
  ],
};

beforeEach(() => {
  clearMockResponses();
  localStorage.clear();
});

describe("useScenarios", () => {
  it("loads the scenario list on mount", async () => {
    mockInvokeResponse("list_scenarios", [scenario()]);

    const { result } = renderHook(() => useScenarios());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scenarios).toHaveLength(1);
    expect(result.current.scenarios[0].name).toBe("Approach Rush");
  });

  it("treats storage-unavailable as an empty list, not an error", async () => {
    // DuckDB init failure must leave the app usable in real-time-only mode.
    mockInvokeResponse("list_scenarios", () => {
      throw new Error("Storage not available");
    });

    const { result } = renderHook(() => useScenarios());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.storageUnavailable).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.scenarios).toEqual([]);
  });

  it("surfaces a genuine error", async () => {
    mockInvokeResponse("list_scenarios", () => {
      throw new Error("disk exploded");
    });

    const { result } = renderHook(() => useScenarios());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("disk exploded");
    expect(result.current.storageUnavailable).toBe(false);
  });

  it("starts with no active scenario and no tracks", async () => {
    mockInvokeResponse("list_scenarios", [scenario()]);

    const { result } = renderHook(() => useScenarios());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeScenarioId).toBeNull();
    expect(result.current.tracksAsTrajectories).toEqual([]);
  });

  it("loads the selected scenario's tracks as trajectories", async () => {
    mockInvokeResponse("list_scenarios", [scenario({ track_count: 1 })]);
    mockInvokeResponse("get_scenario", {
      scenario: scenario({ track_count: 1 }),
      tracks: [track()],
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectScenario("s1"));

    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    expect(result.current.tracksAsTrajectories[0].hex_ident).toBe("AAA111");
    expect(result.current.tracksAsTrajectories[0].waypoints).toHaveLength(1);
  });

  it("replaces tracks when switching scenarios rather than appending", async () => {
    mockInvokeResponse("list_scenarios", [scenario(), scenario({ id: "s2", name: "Other" })]);
    mockInvokeResponse("get_scenario", (args: Record<string, unknown>) =>
      args.id === "s1"
        ? { scenario: scenario(), tracks: [track()] }
        : { scenario: scenario({ id: "s2" }), tracks: [track({ id: "t9", hex_ident: "ZZZ999" })] },
    );

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectScenario("s1"));
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));

    act(() => result.current.selectScenario("s2"));
    await waitFor(() => expect(result.current.tracks[0].hex_ident).toBe("ZZZ999"));
    expect(result.current.tracks).toHaveLength(1);
  });

  it("exposes the active scenario object", async () => {
    mockInvokeResponse("list_scenarios", [scenario()]);
    mockInvokeResponse("get_scenario", { scenario: scenario(), tracks: [] });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectScenario("s1"));
    await waitFor(() => expect(result.current.activeScenario?.name).toBe("Approach Rush"));
  });

  it("makes a newly created scenario the active one", async () => {
    const created = scenario({ id: "new-id", name: "Fresh" });
    mockInvokeResponse("list_scenarios", [created]);
    mockInvokeResponse("create_scenario", created);
    mockInvokeResponse("get_scenario", { scenario: created, tracks: [] });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createScenario({ name: "Fresh" });
    });

    expect(result.current.activeScenarioId).toBe("new-id");
  });

  it("clears the active scenario when it is deleted", async () => {
    mockInvokeResponse("list_scenarios", []);
    mockInvokeResponse("get_scenario", { scenario: scenario(), tracks: [] });
    mockInvokeResponse("delete_scenario", undefined);

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectScenario("s1"));
    await waitFor(() => expect(result.current.activeScenarioId).toBe("s1"));

    await act(async () => {
      await result.current.removeScenario("s1");
    });

    expect(result.current.activeScenarioId).toBeNull();
  });

  it("refuses to add a trajectory with no scenario selected", async () => {
    mockInvokeResponse("list_scenarios", [scenario()]);

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.addTrajectory(trajectory)).rejects.toThrow(
      "No scenario selected",
    );
  });

  it("adds a trajectory to the active scenario", async () => {
    let sentTrack: Record<string, unknown> | undefined;
    mockInvokeResponse("list_scenarios", [scenario()]);
    mockInvokeResponse("get_scenario", { scenario: scenario(), tracks: [] });
    mockInvokeResponse("create_scenario_track", (args: Record<string, unknown>) => {
      sentTrack = (args as { track: Record<string, unknown> }).track;
      return track({ id: "t2", hex_ident: "BBB222" });
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.selectScenario("s1"));
    await waitFor(() => expect(result.current.activeScenarioId).toBe("s1"));

    await act(async () => {
      await result.current.addTrajectory(trajectory, 90, { category: "airliner" });
    });

    expect(sentTrack?.scenario_id).toBe("s1");
    expect(sentTrack?.hex_ident).toBe("BBB222");
    expect(sentTrack?.start_offset_s).toBe(90);
    expect(JSON.parse(sentTrack?.request_json as string)).toEqual({ category: "airliner" });
  });

  // The silent-failure guard: two tracks sharing a hex_ident would share a
  // playback clock and one aircraft would become unreachable.
  it("reassigns a colliding hex_ident when adding to a scenario", async () => {
    let sentTrack: Record<string, unknown> | undefined;
    mockInvokeResponse("list_scenarios", [scenario({ track_count: 1 })]);
    mockInvokeResponse("get_scenario", {
      scenario: scenario({ track_count: 1 }),
      tracks: [track({ hex_ident: "BBB222" })],
    });
    mockInvokeResponse("create_scenario_track", (args: Record<string, unknown>) => {
      sentTrack = (args as { track: Record<string, unknown> }).track;
      return track({ id: "t2" });
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.selectScenario("s1"));
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));

    await act(async () => {
      // Same hex as the track already in the scenario.
      await result.current.addTrajectory(trajectory);
    });

    expect(sentTrack?.hex_ident).not.toBe("BBB222");
  });

  it("updates a track's start offset", async () => {
    let sent: Record<string, unknown> | undefined;
    mockInvokeResponse("list_scenarios", [scenario()]);
    mockInvokeResponse("get_scenario", { scenario: scenario(), tracks: [track()] });
    mockInvokeResponse("update_scenario_track", (args: Record<string, unknown>) => {
      sent = (args as { track: Record<string, unknown> }).track;
      return track({ start_offset_s: 45 });
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.selectScenario("s1"));
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));

    await act(async () => {
      await result.current.setTrackOffset("t1", 45);
    });

    expect(sent).toEqual({ id: "t1", start_offset_s: 45 });
  });

  it("removes a track", async () => {
    let deletedId: unknown;
    mockInvokeResponse("list_scenarios", [scenario()]);
    mockInvokeResponse("get_scenario", { scenario: scenario(), tracks: [] });
    mockInvokeResponse("delete_scenario_track", (args: Record<string, unknown>) => {
      deletedId = args.id;
      return undefined;
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.selectScenario("s1"));
    await waitFor(() => expect(result.current.activeScenarioId).toBe("s1"));

    await act(async () => {
      await result.current.removeTrack("t1");
    });

    expect(deletedId).toBe("t1");
  });

  it("saves a description against the scenario", async () => {
    let sent: unknown;
    mockInvokeResponse("list_scenarios", [scenario()]);
    mockInvokeResponse("update_scenario", (args: Record<string, unknown>) => {
      sent = (args as { scenario: Record<string, unknown> }).scenario;
      return scenario({ description: "Two aircraft converge." });
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setDescription("s1", "Two aircraft converge.");
    });

    expect(sent).toMatchObject({
      id: "s1",
      description: "Two aircraft converge.",
    });
  });

  it("keeps the existing name when saving a description", async () => {
    // `name` is required by UpdateScenario, so setDescription has to supply the
    // current one — sending an empty name would blank the scenario's title.
    let sent: Record<string, unknown> | undefined;
    mockInvokeResponse("list_scenarios", [scenario({ name: "Approach Rush" })]);
    mockInvokeResponse("update_scenario", (args: Record<string, unknown>) => {
      sent = (args as { scenario: Record<string, unknown> }).scenario;
      return scenario();
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setDescription("s1", "Busy evening arrivals.");
    });

    expect(sent?.name).toBe("Approach Rush");
  });

  it("saves an empty description as a deliberate clear", async () => {
    let sent: Record<string, unknown> | undefined;
    mockInvokeResponse("list_scenarios", [scenario({ description: "old text" })]);
    mockInvokeResponse("update_scenario", (args: Record<string, unknown>) => {
      sent = (args as { scenario: Record<string, unknown> }).scenario;
      return scenario({ description: "" });
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setDescription("s1", "");
    });

    // "" not undefined: storage COALESCEs an omitted field to its old value,
    // so undefined here would silently refuse to clear the description.
    expect(sent?.description).toBe("");
  });

  // Regression: `update_scenario_sync` used to overwrite every column, so a
  // rename that sent only `{ id, name }` wiped the description. Storage now
  // COALESCEs — this pins the hook's half of that contract.
  it("does not send a description when renaming", async () => {
    let sent: Record<string, unknown> | undefined;
    mockInvokeResponse("list_scenarios", [scenario({ description: "keep me" })]);
    mockInvokeResponse("update_scenario", (args: Record<string, unknown>) => {
      sent = (args as { scenario: Record<string, unknown> }).scenario;
      return scenario({ name: "Renamed", description: "keep me" });
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.renameScenario("s1", "Renamed");
    });

    expect(sent?.name).toBe("Renamed");
    expect(sent?.description).toBeUndefined();
  });

  it("refreshes the list so a saved description shows immediately", async () => {
    let listCalls = 0;
    mockInvokeResponse("list_scenarios", () => {
      listCalls += 1;
      return [scenario({ description: listCalls > 1 ? "saved" : "" })];
    });
    mockInvokeResponse("update_scenario", scenario({ description: "saved" }));

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setDescription("s1", "saved");
    });

    await waitFor(() =>
      expect(result.current.scenarios[0].description).toBe("saved"),
    );
  });

  it("survives a stale active id whose scenario no longer exists", async () => {
    mockInvokeResponse("list_scenarios", []);
    mockInvokeResponse("get_scenario", () => {
      throw new Error("Scenario not found: gone");
    });

    const { result } = renderHook(() => useScenarios());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.selectScenario("gone"));

    await waitFor(() => expect(result.current.tracks).toEqual([]));
    expect(result.current.activeScenario).toBeNull();
  });
});
