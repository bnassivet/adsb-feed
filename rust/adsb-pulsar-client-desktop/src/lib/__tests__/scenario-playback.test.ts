import { describe, expect, it } from "vitest";
import {
  SCENARIO_STOPPED,
  mergeScenarioPlayback,
  pauseScenario,
  projectScenario,
  scenarioDurationS,
  seekScenario,
  startScenario,
  stopScenario,
  tickScenario,
  type ScenarioClock,
  type ScenarioTiming,
} from "../scenario-playback";
import type { PlaybackMap } from "../trajectory-playback";
import type { AgentTrajectory, DynamicWaypoint } from "../simulation-data";

function waypoint(tOffsetS: number): DynamicWaypoint {
  return {
    lat: 45.5,
    lng: -73.6,
    alt_ft: 1000,
    speed_kts: 80,
    heading_deg: 90,
    phase: "cruise",
    t_offset_s: tOffsetS,
  };
}

function trajectory(hex: string, durationS: number): AgentTrajectory {
  return {
    hex_ident: hex,
    callsign: hex,
    category: "helicopter",
    waypoints: [waypoint(0), waypoint(durationS)],
  };
}

/** A 60s aircraft at t=0 and a 30s aircraft that appears 90s in. */
function timings(): ScenarioTiming[] {
  return [
    { trajectory: trajectory("EARLY", 60), startOffsetS: 0 },
    { trajectory: trajectory("LATE", 30), startOffsetS: 90 },
  ];
}

const playing = (elapsedS: number): ScenarioClock => ({ state: "playing", elapsedS });

describe("scenarioDurationS", () => {
  it("spans until the last aircraft finishes", () => {
    // LATE starts at 90 and runs 30 → the scenario is 120s, not 60s.
    expect(scenarioDurationS(timings())).toBe(120);
  });

  it("is zero for an empty scenario", () => {
    expect(scenarioDurationS([])).toBe(0);
  });

  it("uses the longest track when offsets are equal", () => {
    expect(
      scenarioDurationS([
        { trajectory: trajectory("A", 40), startOffsetS: 0 },
        { trajectory: trajectory("B", 75), startOffsetS: 0 },
      ]),
    ).toBe(75);
  });

  it("counts a zero-duration track's offset", () => {
    expect(
      scenarioDurationS([{ trajectory: trajectory("A", 0), startOffsetS: 45 }]),
    ).toBe(45);
  });
});

describe("projectScenario", () => {
  it("leaves an aircraft stopped before its offset", () => {
    const map = projectScenario(playing(10), timings());
    expect(map.LATE.state).toBe("stopped");
    expect(map.LATE.elapsedS).toBe(0);
  });

  it("spawns an aircraft exactly at its offset", () => {
    // The boundary matters: at T == offset the aircraft is at its first
    // waypoint, not still absent.
    const map = projectScenario(playing(90), timings());
    expect(map.LATE.state).toBe("playing");
    expect(map.LATE.elapsedS).toBe(0);
  });

  it("keeps an aircraft stopped one instant before its offset", () => {
    const map = projectScenario(playing(89.9), timings());
    expect(map.LATE.state).toBe("stopped");
  });

  it("subtracts the offset from the master clock", () => {
    const map = projectScenario(playing(100), timings());
    expect(map.LATE.elapsedS).toBeCloseTo(10);
  });

  it("holds an aircraft paused at its final waypoint once it is done", () => {
    // EARLY runs 0..60; at T=100 it has finished but must stay visible so the
    // scrubber can be dragged back through its route.
    const map = projectScenario(playing(100), timings());
    expect(map.EARLY.state).toBe("paused");
    expect(map.EARLY.elapsedS).toBe(60);
  });

  it("propagates a paused master clock to live aircraft", () => {
    const map = projectScenario({ state: "paused", elapsedS: 30 }, timings());
    expect(map.EARLY.state).toBe("paused");
    expect(map.EARLY.elapsedS).toBe(30);
  });

  it("stops every aircraft when the master clock is stopped", () => {
    const map = projectScenario(SCENARIO_STOPPED, timings());
    expect(map.EARLY.state).toBe("stopped");
    expect(map.LATE.state).toBe("stopped");
  });

  it("returns an entry for every track, even unspawned ones", () => {
    const map = projectScenario(playing(0), timings());
    expect(Object.keys(map).sort()).toEqual(["EARLY", "LATE"]);
  });

  it("is empty for an empty scenario", () => {
    expect(projectScenario(playing(10), [])).toEqual({});
  });

  it("handles a zero-duration track without dividing by zero", () => {
    const map = projectScenario(playing(10), [
      { trajectory: trajectory("ZERO", 0), startOffsetS: 0 },
    ]);
    expect(map.ZERO.state).toBe("paused");
    expect(map.ZERO.elapsedS).toBe(0);
  });
});

describe("tickScenario", () => {
  it("advances a playing clock", () => {
    expect(tickScenario(playing(10), timings(), 0.5).elapsedS).toBeCloseTo(10.5);
  });

  it("does not advance a paused clock", () => {
    const clock: ScenarioClock = { state: "paused", elapsedS: 10 };
    expect(tickScenario(clock, timings(), 0.5)).toBe(clock);
  });

  it("does not advance a stopped clock", () => {
    expect(tickScenario(SCENARIO_STOPPED, timings(), 0.5)).toBe(SCENARIO_STOPPED);
  });

  it("pauses at the end rather than running past it", () => {
    const result = tickScenario(playing(119.9), timings(), 0.5);
    expect(result.state).toBe("paused");
    expect(result.elapsedS).toBe(120);
  });

  it("preserves identity when nothing changed, so React can skip a render", () => {
    const clock: ScenarioClock = { state: "paused", elapsedS: 5 };
    expect(tickScenario(clock, timings(), 1)).toBe(clock);
  });
});

describe("transport controls", () => {
  it("start begins a stopped scenario at zero", () => {
    expect(startScenario(SCENARIO_STOPPED)).toEqual({ state: "playing", elapsedS: 0 });
  });

  it("start resumes a paused scenario where it left off", () => {
    expect(startScenario({ state: "paused", elapsedS: 42 })).toEqual({
      state: "playing",
      elapsedS: 42,
    });
  });

  it("pause freezes in place", () => {
    expect(pauseScenario(playing(42))).toEqual({ state: "paused", elapsedS: 42 });
  });

  it("pause leaves a stopped scenario alone", () => {
    expect(pauseScenario(SCENARIO_STOPPED)).toEqual(SCENARIO_STOPPED);
  });

  it("stop rewinds to the beginning", () => {
    expect(stopScenario()).toEqual({ state: "stopped", elapsedS: 0 });
  });
});

describe("seekScenario", () => {
  it("jumps to a point in the timeline", () => {
    expect(seekScenario(playing(0), timings(), 45).elapsedS).toBe(45);
  });

  it("keeps playing when it was playing", () => {
    expect(seekScenario(playing(0), timings(), 45).state).toBe("playing");
  });

  it("pauses a stopped scenario at the sought point, so the aircraft show", () => {
    const result = seekScenario(SCENARIO_STOPPED, timings(), 45);
    expect(result.state).toBe("paused");
    expect(result.elapsedS).toBe(45);
  });

  it("clamps past the end", () => {
    expect(seekScenario(playing(0), timings(), 9999).elapsedS).toBe(120);
  });

  it("clamps below zero", () => {
    expect(seekScenario(playing(50), timings(), -10).elapsedS).toBe(0);
  });
});

describe("mergeScenarioPlayback", () => {
  // The "both" model: a scenario master clock drives the scenario's own tracks,
  // while staged (not-yet-saved) trajectories keep their independent clocks.
  const base: PlaybackMap = {
    EARLY: { state: "playing", elapsedS: 5 },
    LATE: { state: "stopped", elapsedS: 0 },
    STAGED: { state: "playing", elapsedS: 12 },
  };

  it("returns the per-track map untouched while the scenario is stopped", () => {
    expect(mergeScenarioPlayback(base, SCENARIO_STOPPED, timings())).toBe(base);
  });

  it("overrides scenario tracks once the master clock runs", () => {
    const merged = mergeScenarioPlayback(base, playing(100), timings());
    expect(merged.EARLY).toEqual({ state: "paused", elapsedS: 60 });
    expect(merged.LATE).toEqual({ state: "playing", elapsedS: 10 });
  });

  it("leaves staged trajectories on their own clocks", () => {
    const merged = mergeScenarioPlayback(base, playing(100), timings());
    expect(merged.STAGED).toEqual({ state: "playing", elapsedS: 12 });
  });

  it("does not mutate the map it was given", () => {
    mergeScenarioPlayback(base, playing(100), timings());
    expect(base.EARLY).toEqual({ state: "playing", elapsedS: 5 });
  });

  it("adds scenario entries missing from the base map", () => {
    const merged = mergeScenarioPlayback({}, playing(95), timings());
    expect(merged.LATE.state).toBe("playing");
  });
});

describe("scrubbing backwards", () => {
  it("un-spawns an aircraft when scrubbed before its offset", () => {
    // This is what makes the master scrubber feel right: dragging back before
    // an aircraft's entry must remove it, not leave it stranded on the map.
    const afterSpawn = projectScenario(playing(100), timings());
    expect(afterSpawn.LATE.state).toBe("playing");

    const scrubbedBack = projectScenario(playing(10), timings());
    expect(scrubbedBack.LATE.state).toBe("stopped");
  });
});
