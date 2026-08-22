import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  interpolateHeading,
  sampleTrajectory,
  trailUpTo,
  useAgentSimulatedTracks,
} from "@/hooks/useAgentSimulatedTracks";
import type { AgentTrajectory, DynamicWaypoint } from "@/lib/simulation-data";
import type { PlaybackMap } from "@/lib/trajectory-playback";

/**
 * Position is a function of the trajectory's own clock (`t_offset_s`), not of
 * wall-clock ticks — so the hook is stateless and scrubbing works. Transport
 * state lives in `trajectory-playback.ts`; this covers only the rendering.
 */

function wp(over: Partial<DynamicWaypoint> = {}): DynamicWaypoint {
  return {
    lat: 45.5,
    lng: -73.6,
    alt_ft: 1000,
    speed_kts: 100,
    heading_deg: 0,
    phase: "cruise",
    t_offset_s: 0,
    ...over,
  };
}

const TWO_POINT: DynamicWaypoint[] = [
  wp({ t_offset_s: 0, lat: 45.0, lng: -73.0, alt_ft: 1000, speed_kts: 100, heading_deg: 0 }),
  wp({ t_offset_s: 10, lat: 46.0, lng: -74.0, alt_ft: 2000, speed_kts: 200, heading_deg: 90 }),
];

function trajectory(over: Partial<AgentTrajectory> = {}): AgentTrajectory {
  return {
    hex_ident: "SIM-A1",
    callsign: "HELI001",
    category: "helicopter",
    waypoints: TWO_POINT,
    ...over,
  };
}

const playing = (elapsedS: number, id = "SIM-A1"): PlaybackMap => ({
  [id]: { state: "playing", elapsedS },
});

describe("interpolateHeading", () => {
  it("interpolates linearly away from the wrap point", () => {
    expect(interpolateHeading(0, 90, 0.5)).toBeCloseTo(45);
  });

  it("takes the short way across 0/360", () => {
    // 350 -> 10 is a 20 degree turn through north, not 340 degrees backwards.
    expect(interpolateHeading(350, 10, 0.5)).toBeCloseTo(0);
  });

  it("takes the short way in the other direction", () => {
    expect(interpolateHeading(10, 350, 0.5)).toBeCloseTo(0);
  });

  it("returns a normalized heading", () => {
    const h = interpolateHeading(350, 10, 0.75);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });

  it("returns the endpoints at t=0 and t=1", () => {
    expect(interpolateHeading(120, 200, 0)).toBeCloseTo(120);
    expect(interpolateHeading(120, 200, 1)).toBeCloseTo(200);
  });
});

describe("sampleTrajectory", () => {
  it("returns the first waypoint at t=0", () => {
    const s = sampleTrajectory(TWO_POINT, 0)!;
    expect(s.lat).toBeCloseTo(45.0);
    expect(s.lng).toBeCloseTo(-73.0);
  });

  it("interpolates position by elapsed time", () => {
    const s = sampleTrajectory(TWO_POINT, 5)!;
    expect(s.lat).toBeCloseTo(45.5);
    expect(s.lng).toBeCloseTo(-73.5);
  });

  it("interpolates altitude and speed too", () => {
    const s = sampleTrajectory(TWO_POINT, 5)!;
    expect(s.altFt).toBeCloseTo(1500);
    expect(s.speedKts).toBeCloseTo(150);
  });

  it("interpolates heading", () => {
    expect(sampleTrajectory(TWO_POINT, 5)!.headingDeg).toBeCloseTo(45);
  });

  it("carries the phase of the segment being flown", () => {
    const wps = [wp({ t_offset_s: 0, phase: "climb" }), wp({ t_offset_s: 10, phase: "cruise" })];
    expect(sampleTrajectory(wps, 4)!.phase).toBe("climb");
  });

  it("clamps to the final waypoint past the end", () => {
    const s = sampleTrajectory(TWO_POINT, 999)!;
    expect(s.lat).toBeCloseTo(46.0);
  });

  it("clamps negative elapsed time to the start", () => {
    expect(sampleTrajectory(TWO_POINT, -5)!.lat).toBeCloseTo(45.0);
  });

  it("returns null for an empty trajectory", () => {
    expect(sampleTrajectory([], 0)).toBeNull();
  });

  it("handles a single waypoint without dividing by zero", () => {
    const s = sampleTrajectory([wp({ t_offset_s: 0, lat: 1, lng: 2 })], 0)!;
    expect(s.lat).toBe(1);
    expect(s.lng).toBe(2);
  });

  it("handles duplicate timestamps without producing NaN", () => {
    const wps = [wp({ t_offset_s: 5, lat: 1 }), wp({ t_offset_s: 5, lat: 2 })];
    expect(Number.isNaN(sampleTrajectory(wps, 5)!.lat)).toBe(false);
  });
});

describe("trailUpTo", () => {
  const FOUR = [
    wp({ t_offset_s: 0, lat: 45.0 }),
    wp({ t_offset_s: 10, lat: 45.1 }),
    wp({ t_offset_s: 20, lat: 45.2 }),
    wp({ t_offset_s: 30, lat: 45.3 }),
  ];

  it("contains only the part of the route already flown", () => {
    expect(trailUpTo(FOUR, 15)).toHaveLength(3); // two waypoints + current
  });

  it("grows as time advances", () => {
    expect(trailUpTo(FOUR, 25).length).toBeGreaterThan(trailUpTo(FOUR, 5).length);
  });

  it("shrinks when scrubbed backwards", () => {
    /* The reason the trail is derived rather than accumulated: seeking back
       must not leave the previously drawn path behind. */
    expect(trailUpTo(FOUR, 5).length).toBeLessThan(trailUpTo(FOUR, 25).length);
  });

  it("ends at the current position", () => {
    const trail = trailUpTo(FOUR, 15);
    const [lat] = trail[trail.length - 1];
    expect(lat).toBeCloseTo(sampleTrajectory(FOUR, 15)!.lat);
  });

  it("does not duplicate a point when sitting exactly on a waypoint", () => {
    expect(trailUpTo(FOUR, 10)).toHaveLength(2);
  });

  it("covers the whole route at the end", () => {
    expect(trailUpTo(FOUR, 30)).toHaveLength(4);
  });

  it("is empty for an empty trajectory", () => {
    expect(trailUpTo([], 10)).toEqual([]);
  });

  it("caps its length", () => {
    const many = Array.from({ length: 500 }, (_, i) => wp({ t_offset_s: i }));
    expect(trailUpTo(many, 499, 100)).toHaveLength(100);
  });
});

describe("useAgentSimulatedTracks", () => {
  it("returns nothing without trajectories", () => {
    const { result } = renderHook(() => useAgentSimulatedTracks([], {}));
    expect(result.current).toEqual([]);
  });

  it("omits stopped trajectories", () => {
    /* Generated aircraft are stopped until the user presses Start. */
    const { result } = renderHook(() =>
      useAgentSimulatedTracks([trajectory()], { "SIM-A1": { state: "stopped", elapsedS: 0 } }),
    );
    expect(result.current).toEqual([]);
  });

  it("omits trajectories with no playback entry", () => {
    const { result } = renderHook(() => useAgentSimulatedTracks([trajectory()], {}));
    expect(result.current).toEqual([]);
  });

  it("renders a playing trajectory", () => {
    const { result } = renderHook(() => useAgentSimulatedTracks([trajectory()], playing(5)));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].hex_ident).toBe("SIM-A1");
  });

  it("renders a paused trajectory — pause keeps it on the map", () => {
    const { result } = renderHook(() =>
      useAgentSimulatedTracks([trajectory()], { "SIM-A1": { state: "paused", elapsedS: 5 } }),
    );
    expect(result.current).toHaveLength(1);
  });

  it("maps agent fields onto AircraftTrack", () => {
    const { result } = renderHook(() => useAgentSimulatedTracks([trajectory()], playing(5)));
    const track = result.current[0];
    expect(track.callsign).toBe("HELI001");
    expect(track.altitude).toBe(1500);
    expect(track.ground_speed).toBe(150);
    expect(track.track).toBe(45);
  });

  it("positions the aircraft at its clock, not at wall-clock", () => {
    const { result } = renderHook(() => useAgentSimulatedTracks([trajectory()], playing(5)));
    expect(result.current[0].latitude).toBeCloseTo(45.5);
  });

  it("uses absolute coordinates without a receiver offset", () => {
    const { result } = renderHook(() => useAgentSimulatedTracks([trajectory()], playing(0)));
    expect(result.current[0].latitude).toBeCloseTo(45.0);
    expect(result.current[0].longitude).toBeCloseTo(-73.0);
  });

  it("is stateless — the same inputs give the same position", () => {
    const a = renderHook(() => useAgentSimulatedTracks([trajectory()], playing(5)));
    const b = renderHook(() => useAgentSimulatedTracks([trajectory()], playing(5)));
    expect(a.result.current[0].latitude).toBe(b.result.current[0].latitude);
  });

  it("carries a trail matching the clock", () => {
    const { result } = renderHook(() => useAgentSimulatedTracks([trajectory()], playing(10)));
    expect((result.current[0].positions as unknown[]).length).toBeGreaterThan(1);
  });

  it("derives first_seen from the elapsed clock", () => {
    const { result } = renderHook(() => useAgentSimulatedTracks([trajectory()], playing(10)));
    const track = result.current[0];
    expect(track.last_seen - track.first_seen).toBeCloseTo(10_000, -2);
  });

  it("renders several aircraft independently", () => {
    const trajectories = [
      trajectory({ hex_ident: "SIM-A1" }),
      trajectory({ hex_ident: "SIM-B2", callsign: "B2" }),
    ];
    const playback: PlaybackMap = {
      "SIM-A1": { state: "playing", elapsedS: 0 },
      "SIM-B2": { state: "playing", elapsedS: 10 },
    };
    const { result } = renderHook(() => useAgentSimulatedTracks(trajectories, playback));
    expect(result.current).toHaveLength(2);
    // Different clocks put them in different places.
    expect(result.current[0].latitude).not.toBeCloseTo(result.current[1].latitude!);
  });

  it("renders only the started aircraft when others are stopped", () => {
    const trajectories = [
      trajectory({ hex_ident: "SIM-A1" }),
      trajectory({ hex_ident: "SIM-B2" }),
    ];
    const playback: PlaybackMap = {
      "SIM-A1": { state: "playing", elapsedS: 1 },
      "SIM-B2": { state: "stopped", elapsedS: 0 },
    };
    const { result } = renderHook(() => useAgentSimulatedTracks(trajectories, playback));
    expect(result.current.map((t) => t.hex_ident)).toEqual(["SIM-A1"]);
  });

  it("ignores trajectories with no waypoints", () => {
    const { result } = renderHook(() =>
      useAgentSimulatedTracks([trajectory({ waypoints: [] })], playing(1)),
    );
    expect(result.current).toEqual([]);
  });

  it("marks on-ground when altitude reaches zero", () => {
    const landed = trajectory({
      waypoints: [wp({ t_offset_s: 0, alt_ft: 500 }), wp({ t_offset_s: 10, alt_ft: 0 })],
    });
    const { result } = renderHook(() => useAgentSimulatedTracks([landed], playing(10)));
    expect(result.current[0].is_on_ground).toBe(true);
  });
});
