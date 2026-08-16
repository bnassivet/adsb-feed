import { describe, it, expect } from "vitest";
import { summarizeTrajectory } from "@/lib/simulation-data";
import type { AgentTrajectory, DynamicWaypoint } from "@/lib/simulation-data";

function wp(over: Partial<DynamicWaypoint> = {}): DynamicWaypoint {
  return {
    lat: 45.5, lng: -73.6, alt_ft: 1000, speed_kts: 100,
    heading_deg: 0, phase: "cruise", t_offset_s: 0, ...over,
  };
}

function traj(waypoints: DynamicWaypoint[]): AgentTrajectory {
  return { hex_ident: "SIM-A", callsign: "A", category: "ga", waypoints };
}

describe("summarizeTrajectory", () => {
  const CLIMB_CRUISE = traj([
    wp({ t_offset_s: 0, alt_ft: 500, phase: "climb" }),
    wp({ t_offset_s: 30, alt_ft: 3000, phase: "climb" }),
    wp({ t_offset_s: 60, alt_ft: 4000, phase: "cruise" }),
  ]);

  it("counts the waypoints", () => {
    expect(summarizeTrajectory(CLIMB_CRUISE).waypointCount).toBe(3);
  });

  it("takes duration from the last time offset", () => {
    expect(summarizeTrajectory(CLIMB_CRUISE).durationS).toBe(60);
  });

  it("reports the altitude range", () => {
    const s = summarizeTrajectory(CLIMB_CRUISE);
    expect(s.minAltFt).toBe(500);
    expect(s.maxAltFt).toBe(4000);
  });

  it("lists distinct phases in the order flown", () => {
    expect(summarizeTrajectory(CLIMB_CRUISE).phases).toEqual(["climb", "cruise"]);
  });

  it("does not repeat a phase that recurs", () => {
    const s = summarizeTrajectory(traj([
      wp({ t_offset_s: 0, phase: "cruise" }),
      wp({ t_offset_s: 10, phase: "descent" }),
      wp({ t_offset_s: 20, phase: "cruise" }),
    ]));
    expect(s.phases).toEqual(["cruise", "descent"]);
  });

  it("handles an empty trajectory", () => {
    expect(summarizeTrajectory(traj([]))).toEqual({
      waypointCount: 0, durationS: 0, minAltFt: 0, maxAltFt: 0, phases: [],
    });
  });

  it("handles a single waypoint", () => {
    const s = summarizeTrajectory(traj([wp({ t_offset_s: 0, alt_ft: 900 })]));
    expect(s).toMatchObject({ waypointCount: 1, durationS: 0, minAltFt: 900, maxAltFt: 900 });
  });
});

describe("routeLatLngs", () => {
  it("returns every waypoint as a lat/lng pair", async () => {
    const { routeLatLngs } = await import("@/lib/simulation-data");
    const t = traj([
      wp({ lat: 45.0, lng: -73.0 }),
      wp({ lat: 45.1, lng: -73.1, t_offset_s: 10 }),
    ]);
    expect(routeLatLngs(t)).toEqual([
      [45.0, -73.0],
      [45.1, -73.1],
    ]);
  });

  it("is empty for a trajectory with no waypoints", async () => {
    const { routeLatLngs } = await import("@/lib/simulation-data");
    expect(routeLatLngs(traj([]))).toEqual([]);
  });

  it("preserves waypoint order", async () => {
    const { routeLatLngs } = await import("@/lib/simulation-data");
    const t = traj([wp({ lat: 1 }), wp({ lat: 2, t_offset_s: 5 }), wp({ lat: 3, t_offset_s: 9 })]);
    expect(routeLatLngs(t).map(([lat]) => lat)).toEqual([1, 2, 3]);
  });
});
