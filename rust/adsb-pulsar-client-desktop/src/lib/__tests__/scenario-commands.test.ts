import { beforeEach, describe, expect, it } from "vitest";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import {
  createScenario,
  createScenarioTrack,
  deleteScenario,
  deleteScenarioTrack,
  getScenario,
  listScenarios,
  reorderScenarioTracks,
  updateScenario,
  updateScenarioTrack,
} from "../commands";
import type { Scenario, ScenarioTrack } from "../types";

const sampleScenario: Scenario = {
  id: "scenario-uuid",
  name: "Approach Rush",
  description: "",
  origin_lat: 45.5,
  origin_lng: -73.6,
  tags: null,
  created_at_ms: 1705315800000,
  updated_at_ms: 1705315800000,
  track_count: 2,
};

const sampleTrack: ScenarioTrack = {
  id: "track-uuid",
  scenario_id: "scenario-uuid",
  ordinal: 0,
  hex_ident: "AAA111",
  callsign: "HELI01",
  category: "helicopter",
  start_offset_s: 0,
  waypoints_json: "[]",
  request_json: null,
  created_at_ms: 1705315800000,
  updated_at_ms: 1705315800000,
};

describe("scenario commands", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("listScenarios invokes list_scenarios", async () => {
    mockInvokeResponse("list_scenarios", [sampleScenario]);

    const result = await listScenarios();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Approach Rush");
    expect(result[0].track_count).toBe(2);
  });

  it("listScenarios returns an empty list for a fresh database", async () => {
    mockInvokeResponse("list_scenarios", []);
    await expect(listScenarios()).resolves.toEqual([]);
  });

  it("getScenario passes the id and returns tracks", async () => {
    let seen: Record<string, unknown> | undefined;
    mockInvokeResponse("get_scenario", (args: Record<string, unknown>) => {
      seen = args;
      return { scenario: sampleScenario, tracks: [sampleTrack] };
    });

    const result = await getScenario("scenario-uuid");
    expect(seen).toEqual({ id: "scenario-uuid" });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].callsign).toBe("HELI01");
  });

  it("createScenario wraps the payload under `scenario`", async () => {
    let seen: Record<string, unknown> | undefined;
    mockInvokeResponse("create_scenario", (args: Record<string, unknown>) => {
      seen = args;
      return sampleScenario;
    });

    await createScenario({ name: "Approach Rush" });
    expect(seen).toEqual({ scenario: { name: "Approach Rush" } });
  });

  it("updateScenario wraps the payload under `scenario`", async () => {
    let seen: Record<string, unknown> | undefined;
    mockInvokeResponse("update_scenario", (args: Record<string, unknown>) => {
      seen = args;
      return { ...sampleScenario, name: "Renamed" };
    });

    const result = await updateScenario({ id: "scenario-uuid", name: "Renamed" });
    expect(seen).toEqual({ scenario: { id: "scenario-uuid", name: "Renamed" } });
    expect(result.name).toBe("Renamed");
  });

  it("deleteScenario invokes with the id", async () => {
    let seen: Record<string, unknown> | undefined;
    mockInvokeResponse("delete_scenario", (args: Record<string, unknown>) => {
      seen = args;
      return undefined;
    });

    await expect(deleteScenario("scenario-uuid")).resolves.toBeUndefined();
    expect(seen).toEqual({ id: "scenario-uuid" });
  });

  it("createScenarioTrack wraps the payload under `track`", async () => {
    let seen: Record<string, unknown> | undefined;
    mockInvokeResponse("create_scenario_track", (args: Record<string, unknown>) => {
      seen = args;
      return sampleTrack;
    });

    const result = await createScenarioTrack({
      scenario_id: "scenario-uuid",
      hex_ident: "AAA111",
      callsign: "HELI01",
      category: "helicopter",
      waypoints_json: "[]",
    });

    expect((seen as { track: Record<string, unknown> }).track.hex_ident).toBe("AAA111");
    expect(result.ordinal).toBe(0);
  });

  it("updateScenarioTrack sends only the fields being changed", async () => {
    let seen: Record<string, unknown> | undefined;
    mockInvokeResponse("update_scenario_track", (args: Record<string, unknown>) => {
      seen = args;
      return { ...sampleTrack, start_offset_s: 90 };
    });

    const result = await updateScenarioTrack({ id: "track-uuid", start_offset_s: 90 });
    expect(seen).toEqual({ track: { id: "track-uuid", start_offset_s: 90 } });
    expect(result.start_offset_s).toBe(90);
  });

  it("deleteScenarioTrack invokes with the id", async () => {
    mockInvokeResponse("delete_scenario_track", undefined);
    await expect(deleteScenarioTrack("track-uuid")).resolves.toBeUndefined();
  });

  it("reorderScenarioTracks passes camelCase args Tauri converts", async () => {
    let seen: Record<string, unknown> | undefined;
    mockInvokeResponse("reorder_scenario_tracks", (args: Record<string, unknown>) => {
      seen = args;
      return undefined;
    });

    await reorderScenarioTracks("scenario-uuid", ["b", "a"]);
    expect(seen).toEqual({ scenarioId: "scenario-uuid", trackIds: ["b", "a"] });
  });

  it("propagates the storage-unavailable rejection to the caller", async () => {
    // Every scenario command rejects this way when DuckDB init failed or the
    // connection was released; the UI relies on seeing the message.
    mockInvokeResponse("list_scenarios", () => {
      throw new Error("Storage not available");
    });

    await expect(listScenarios()).rejects.toThrow("Storage not available");
  });
});
