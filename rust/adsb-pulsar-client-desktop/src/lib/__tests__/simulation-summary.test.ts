import { describe, it, expect } from "vitest";
import { summarizeTrajectory, routeLegs, legCount } from "@/lib/simulation-data";
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
      waypointCount: 0, durationS: 0, minAltFt: 0, maxAltFt: 0, phases: [], legCount: 0,
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

describe("routeLegs", () => {
  const wp = (leg: number, lat: number, lng: number): DynamicWaypoint => ({
    lat,
    lng,
    alt_ft: 3000,
    speed_kts: 200,
    heading_deg: 90,
    phase: "cruise",
    t_offset_s: 0,
    leg_index: leg,
  });

  const trajectory = (waypoints: DynamicWaypoint[]): AgentTrajectory => ({
    hex_ident: "SIM-000001",
    callsign: "CF001",
    category: "fighter",
    waypoints,
  });

  it("splits the route at leg boundaries", () => {
    const legs = routeLegs(
      trajectory([wp(0, 46.5, -1.8), wp(0, 46.6, -2.0), wp(1, 46.7, -2.3), wp(1, 46.7, -2.4)]),
    );
    expect(legs).toHaveLength(2);
    expect(legs[0].legIndex).toBe(0);
    expect(legs[1].legIndex).toBe(1);
  });

  it("carries the boundary point into the next leg so the line stays unbroken", () => {
    const legs = routeLegs(
      trajectory([wp(0, 46.5, -1.8), wp(0, 46.6, -2.0), wp(1, 46.7, -2.3)]),
    );
    // Without the shared point the two polylines would show a visible gap.
    expect(legs[0].positions[legs[0].positions.length - 1]).toEqual(legs[1].positions[0]);
  });

  it("returns a single leg for a single-leg trajectory", () => {
    const legs = routeLegs(trajectory([wp(0, 46.5, -1.8), wp(0, 46.6, -2.0)]));
    expect(legs).toHaveLength(1);
    expect(legs[0].positions).toEqual([
      [46.5, -1.8],
      [46.6, -2.0],
    ]);
  });

  it("treats a trajectory with no leg_index as one leg", () => {
    const legacy = trajectory([wp(0, 46.5, -1.8), wp(0, 46.6, -2.0)]).waypoints.map((w) => {
      const stripped: DynamicWaypoint = { ...w };
      delete stripped.leg_index;
      return stripped;
    });
    const legs = routeLegs(trajectory(legacy));
    expect(legs).toHaveLength(1);
  });

  it("returns nothing for an empty trajectory", () => {
    expect(routeLegs(trajectory([]))).toEqual([]);
  });
});

describe("legCount", () => {
  it("counts the distinct legs", () => {
    const make = (leg: number): DynamicWaypoint => ({
      lat: 46,
      lng: -2,
      alt_ft: 1,
      speed_kts: 1,
      heading_deg: 1,
      phase: "cruise",
      t_offset_s: 0,
      leg_index: leg,
    });
    expect(legCount({
      hex_ident: "x",
      callsign: "y",
      category: "ga",
      waypoints: [make(0), make(0), make(1), make(2)],
    })).toBe(3);
  });
});

describe("summarizeTrajectory leg count", () => {
  it("reports one leg for a legacy trajectory with no leg_index", () => {
    expect(summarizeTrajectory(CLIMB_CRUISE_FOR_LEGS).legCount).toBe(1);
  });

  it("reports the number of distinct legs", () => {
    const multi = traj([
      wp({ t_offset_s: 0, leg_index: 0 }),
      wp({ t_offset_s: 10, leg_index: 1 }),
      wp({ t_offset_s: 20, leg_index: 2 }),
    ]);
    expect(summarizeTrajectory(multi).legCount).toBe(3);
  });

  it("reports zero legs for an empty trajectory", () => {
    expect(summarizeTrajectory(traj([])).legCount).toBe(0);
  });
});

const CLIMB_CRUISE_FOR_LEGS = traj([wp({ t_offset_s: 0 }), wp({ t_offset_s: 10 })]);

