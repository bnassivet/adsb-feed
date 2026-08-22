import { describe, expect, it } from "vitest";
import {
  dedupeTrajectoriesByHex,
  scenarioTracksToTrajectories,
  stageTrajectories,
  trackDigest,
  trackToTrajectory,
  trajectoryToCreateTrack,
  uniqueHexIdent,
} from "../scenario-convert";
import type { AgentTrajectory, DynamicWaypoint } from "../simulation-data";
import type { ScenarioTrack } from "../types";

function waypoint(overrides: Partial<DynamicWaypoint> = {}): DynamicWaypoint {
  return {
    lat: 45.5,
    lng: -73.6,
    alt_ft: 1000,
    speed_kts: 80,
    heading_deg: 90,
    phase: "cruise",
    t_offset_s: 0,
    ...overrides,
  };
}

function track(overrides: Partial<ScenarioTrack> = {}): ScenarioTrack {
  return {
    id: "track-1",
    scenario_id: "scenario-1",
    ordinal: 0,
    hex_ident: "AAA111",
    callsign: "HELI01",
    category: "helicopter",
    start_offset_s: 0,
    waypoints_json: JSON.stringify([waypoint(), waypoint({ t_offset_s: 8 })]),
    request_json: null,
    created_at_ms: 1000,
    updated_at_ms: 1000,
    ...overrides,
  };
}

function trajectory(overrides: Partial<AgentTrajectory> = {}): AgentTrajectory {
  return {
    hex_ident: "BBB222",
    callsign: "ACA825",
    category: "airliner",
    waypoints: [waypoint(), waypoint({ t_offset_s: 8 })],
    ...overrides,
  };
}

describe("trackToTrajectory", () => {
  it("rebuilds an AgentTrajectory from a stored track", () => {
    const result = trackToTrajectory(track());

    expect(result.hex_ident).toBe("AAA111");
    expect(result.callsign).toBe("HELI01");
    expect(result.category).toBe("helicopter");
    expect(result.waypoints).toHaveLength(2);
    expect(result.waypoints[1].t_offset_s).toBe(8);
  });

  it("preserves leg_index so multi-leg routes still draw per leg", () => {
    const multiLeg = track({
      waypoints_json: JSON.stringify([
        waypoint({ leg_index: 0 }),
        waypoint({ t_offset_s: 8, leg_index: 1 }),
      ]),
    });

    const result = trackToTrajectory(multiLeg);
    expect(result.waypoints.map((w) => w.leg_index)).toEqual([0, 1]);
  });

  it("returns an empty route rather than throwing on malformed JSON", () => {
    // A corrupt row must not take down the whole scenario: the track renders
    // as an empty route and the rest of the scenario still loads.
    const result = trackToTrajectory(track({ waypoints_json: "{not json" }));
    expect(result.waypoints).toEqual([]);
  });

  it("returns an empty route when the JSON is not an array", () => {
    const result = trackToTrajectory(track({ waypoints_json: '{"lat":1}' }));
    expect(result.waypoints).toEqual([]);
  });

  it("falls back to the stored callsign and category", () => {
    const result = trackToTrajectory(track({ callsign: "X", category: "ga" }));
    expect(result.callsign).toBe("X");
    expect(result.category).toBe("ga");
  });
});

describe("scenarioTracksToTrajectories", () => {
  it("converts in the given order", () => {
    const result = scenarioTracksToTrajectories([
      track({ id: "a", hex_ident: "AAA111" }),
      track({ id: "b", hex_ident: "BBB222" }),
    ]);

    expect(result.map((t) => t.hex_ident)).toEqual(["AAA111", "BBB222"]);
  });

  it("handles an empty scenario", () => {
    expect(scenarioTracksToTrajectories([])).toEqual([]);
  });
});

describe("trajectoryToCreateTrack", () => {
  it("serialises the waypoints and carries the scenario id", () => {
    const result = trajectoryToCreateTrack(trajectory(), "scenario-9", 0, null);

    expect(result.scenario_id).toBe("scenario-9");
    expect(result.hex_ident).toBe("BBB222");
    expect(result.callsign).toBe("ACA825");
    expect(result.category).toBe("airliner");
    expect(JSON.parse(result.waypoints_json)).toHaveLength(2);
  });

  it("records the start offset", () => {
    const result = trajectoryToCreateTrack(trajectory(), "s", 90, null);
    expect(result.start_offset_s).toBe(90);
  });

  it("stores the generating request so the track can be regenerated", () => {
    const request = { category: "airliner", originLat: 45.5, originLng: -73.6 };
    const result = trajectoryToCreateTrack(trajectory(), "s", 0, request);

    expect(result.request_json).not.toBeNull();
    expect(JSON.parse(result.request_json as string)).toEqual(request);
  });

  it("leaves request_json null for a hand-authored track", () => {
    const result = trajectoryToCreateTrack(trajectory(), "s", 0, null);
    expect(result.request_json).toBeNull();
  });

  it("round-trips through trackToTrajectory unchanged", () => {
    const original = trajectory();
    const create = trajectoryToCreateTrack(original, "s", 0, null);
    const restored = trackToTrajectory(
      track({
        hex_ident: create.hex_ident,
        callsign: create.callsign,
        category: create.category,
        waypoints_json: create.waypoints_json,
      }),
    );

    expect(restored.waypoints).toEqual(original.waypoints);
    expect(restored.hex_ident).toBe(original.hex_ident);
  });
});

describe("dedupeTrajectoriesByHex", () => {
  // Regression: React threw "two children with the same key" from MapInner.
  // `agentTrajectories` concatenates the saved scenario tracks with the staged
  // ones, and committing a trajectory refetches the scenario *before* the
  // staged set is filtered — so for one render the same hex was in both.
  it("keeps the first occurrence when a hex appears twice", () => {
    const saved = trajectory({ hex_ident: "SIM-153A03", callsign: "SAVED" });
    const staged = trajectory({ hex_ident: "SIM-153A03", callsign: "STAGED" });

    const result = dedupeTrajectoriesByHex([saved, staged]);

    expect(result).toHaveLength(1);
    expect(result[0].callsign).toBe("SAVED");
  });

  it("leaves a list with no duplicates untouched", () => {
    const list = [
      trajectory({ hex_ident: "AAA111" }),
      trajectory({ hex_ident: "BBB222" }),
    ];
    expect(dedupeTrajectoriesByHex(list)).toEqual(list);
  });

  it("preserves identity when nothing was removed, so React can skip a render", () => {
    const list = [trajectory({ hex_ident: "AAA111" })];
    expect(dedupeTrajectoriesByHex(list)).toBe(list);
  });

  it("preserves order", () => {
    const result = dedupeTrajectoriesByHex([
      trajectory({ hex_ident: "AAA111" }),
      trajectory({ hex_ident: "BBB222" }),
      trajectory({ hex_ident: "AAA111" }),
      trajectory({ hex_ident: "CCC333" }),
    ]);
    expect(result.map((t) => t.hex_ident)).toEqual(["AAA111", "BBB222", "CCC333"]);
  });

  it("handles an empty list", () => {
    expect(dedupeTrajectoriesByHex([])).toEqual([]);
  });

  it("collapses three copies of the same hex", () => {
    const result = dedupeTrajectoriesByHex([
      trajectory({ hex_ident: "AAA111" }),
      trajectory({ hex_ident: "AAA111" }),
      trajectory({ hex_ident: "AAA111" }),
    ]);
    expect(result).toHaveLength(1);
  });
});

describe("stageTrajectories", () => {
  it("leaves non-colliding trajectories untouched", () => {
    const incoming = [trajectory({ hex_ident: "BBB222" })];
    expect(stageTrajectories(incoming, ["AAA111"])).toBe(incoming);
  });

  // Without this the newcomer loses to the saved track in dedupe, and the user
  // presses Generate and sees nothing appear.
  it("reassigns a hex already saved in the scenario", () => {
    const result = stageTrajectories(
      [trajectory({ hex_ident: "AAA111", callsign: "NEW" })],
      ["AAA111"],
    );

    expect(result[0].hex_ident).not.toBe("AAA111");
    expect(result[0].callsign).toBe("NEW");
  });

  it("keeps the generated aircraft visible after dedupe", () => {
    const saved = trajectory({ hex_ident: "AAA111", callsign: "SAVED" });
    const staged = stageTrajectories(
      [trajectory({ hex_ident: "AAA111", callsign: "NEW" })],
      [saved.hex_ident],
    );

    const combined = dedupeTrajectoriesByHex([saved, ...staged]);
    expect(combined).toHaveLength(2);
    expect(combined.map((t) => t.callsign)).toEqual(["SAVED", "NEW"]);
  });

  it("separates duplicates within a single generated batch", () => {
    const result = stageTrajectories(
      [trajectory({ hex_ident: "AAA111" }), trajectory({ hex_ident: "AAA111" })],
      [],
    );

    expect(new Set(result.map((t) => t.hex_ident)).size).toBe(2);
  });

  it("does not mutate the trajectory it reassigns", () => {
    const original = trajectory({ hex_ident: "AAA111" });
    stageTrajectories([original], ["AAA111"]);
    expect(original.hex_ident).toBe("AAA111");
  });

  it("handles an empty batch", () => {
    expect(stageTrajectories([], ["AAA111"])).toEqual([]);
  });
});

describe("trackDigest", () => {
  // The digest is what the LLM sees. Raw waypoints never leave the app: the
  // prompt stays small and the model is pointed at what a description needs.
  const climbing = track({
    callsign: "ACA825",
    category: "airliner",
    start_offset_s: 90,
    waypoints_json: JSON.stringify([
      waypoint({ alt_ft: 500, speed_kts: 140, phase: "climb", t_offset_s: 0 }),
      waypoint({ alt_ft: 12000, speed_kts: 320, phase: "cruise", t_offset_s: 240 }),
      waypoint({
        lat: 46.1,
        lng: -73.1,
        alt_ft: 3000,
        speed_kts: 180,
        phase: "descent",
        t_offset_s: 600,
      }),
    ]),
  });

  it("carries the track identity and its scenario timing", () => {
    const d = trackDigest(climbing);

    expect(d.callsign).toBe("ACA825");
    expect(d.category).toBe("airliner");
    expect(d.start_offset_s).toBe(90);
  });

  it("reports the waypoint count and the route duration", () => {
    const d = trackDigest(climbing);

    expect(d.waypoint_count).toBe(3);
    // Duration is the last t_offset_s, not the count — waypoints are unevenly spaced.
    expect(d.duration_s).toBe(600);
  });

  it("summarises the altitude and speed envelope", () => {
    const d = trackDigest(climbing);

    expect(d.alt_ft_min).toBe(500);
    expect(d.alt_ft_max).toBe(12000);
    expect(d.speed_kts_min).toBe(140);
    expect(d.speed_kts_max).toBe(320);
  });

  it("lists the distinct phases in the order flown", () => {
    const d = trackDigest(climbing);
    expect(d.phases).toEqual(["climb", "cruise", "descent"]);
  });

  it("collapses repeated phases rather than listing every waypoint", () => {
    const d = trackDigest(
      track({
        waypoints_json: JSON.stringify([
          waypoint({ phase: "cruise" }),
          waypoint({ phase: "cruise", t_offset_s: 10 }),
          waypoint({ phase: "descent", t_offset_s: 20 }),
        ]),
      }),
    );
    expect(d.phases).toEqual(["cruise", "descent"]);
  });

  it("records where the route starts and ends", () => {
    const d = trackDigest(climbing);

    expect(d.start_lat).toBe(45.5);
    expect(d.start_lng).toBe(-73.6);
    expect(d.end_lat).toBe(46.1);
    expect(d.end_lng).toBe(-73.1);
  });

  it("handles a single-waypoint track without collapsing to nulls", () => {
    const d = trackDigest(track({ waypoints_json: JSON.stringify([waypoint()]) }));

    expect(d.waypoint_count).toBe(1);
    expect(d.duration_s).toBe(0);
    expect(d.start_lat).toBe(d.end_lat);
    expect(d.alt_ft_min).toBe(d.alt_ft_max);
  });

  // Inherits parseWaypoints' "a corrupt row must not take down the scenario"
  // rule: the track still describes itself, it just has no route to report.
  it("degrades to an empty route on corrupt JSON rather than throwing", () => {
    const d = trackDigest(track({ waypoints_json: "{not json", callsign: "HELI01" }));

    expect(d.callsign).toBe("HELI01");
    expect(d.waypoint_count).toBe(0);
    expect(d.duration_s).toBe(0);
    expect(d.phases).toEqual([]);
    expect(d.start_lat).toBeNull();
    expect(d.alt_ft_min).toBeNull();
  });

  it("handles a track with an empty waypoint array", () => {
    const d = trackDigest(track({ waypoints_json: "[]" }));
    expect(d.waypoint_count).toBe(0);
    expect(d.end_lng).toBeNull();
  });

  // The route hint says what the aircraft was *asked* to do, which beats
  // anything derived from the resulting waypoints. It lives in request_json,
  // the SimulateRequest the trajectory was generated from.
  it("extracts the route hint from the stored request", () => {
    const d = trackDigest(
      track({ request_json: JSON.stringify({ routeHint: "orbit the port" }) }),
    );
    expect(d.route).toBe("orbit the port");
  });

  it("reports no route for a track with no stored request", () => {
    expect(trackDigest(track({ request_json: null })).route).toBeNull();
  });

  it("reports no route when the request carries no hint", () => {
    const d = trackDigest(
      track({ request_json: JSON.stringify({ category: "helicopter" }) }),
    );
    expect(d.route).toBeNull();
  });

  it("survives a corrupt request without losing the rest of the digest", () => {
    const d = trackDigest(track({ request_json: "{not json" }));
    expect(d.route).toBeNull();
    expect(d.callsign).toBe("HELI01");
  });

  it("ignores a blank route hint", () => {
    const d = trackDigest(track({ request_json: JSON.stringify({ routeHint: "  " }) }));
    expect(d.route).toBeNull();
  });

  it("ignores a non-string route hint", () => {
    const d = trackDigest(track({ request_json: JSON.stringify({ routeHint: 42 }) }));
    expect(d.route).toBeNull();
  });

  it("does not mutate or reorder the stored waypoints", () => {
    const json = climbing.waypoints_json;
    trackDigest(climbing);
    expect(climbing.waypoints_json).toBe(json);
    expect(trackToTrajectory(climbing).waypoints[0].phase).toBe("climb");
  });
});

describe("uniqueHexIdent", () => {
  it("keeps the desired id when it is free", () => {
    expect(uniqueHexIdent(["AAA111"], "BBB222")).toBe("BBB222");
  });

  it("keeps the desired id against an empty scenario", () => {
    expect(uniqueHexIdent([], "AAA111")).toBe("AAA111");
  });

  // The important one: PlaybackMap is keyed by hex_ident, so two tracks
  // sharing a hex would share a clock and one aircraft becomes unreachable.
  it("reassigns when the desired id is already taken", () => {
    const result = uniqueHexIdent(["AAA111"], "AAA111");
    expect(result).not.toBe("AAA111");
  });

  it("keeps reassigning until it finds a free id", () => {
    const existing = ["AAA111", "AAA111-2", "AAA111-3"];
    const result = uniqueHexIdent(existing, "AAA111");
    expect(existing).not.toContain(result);
  });

  it("produces ids that are themselves unique across repeated calls", () => {
    const existing = ["AAA111"];
    const first = uniqueHexIdent(existing, "AAA111");
    existing.push(first);
    const second = uniqueHexIdent(existing, "AAA111");

    expect(second).not.toBe(first);
    expect(existing).not.toContain(second);
  });
});
