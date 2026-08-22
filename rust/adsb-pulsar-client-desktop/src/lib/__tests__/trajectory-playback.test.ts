import { describe, it, expect } from "vitest";
import {
  STOPPED,
  formatClock,
  isVisible,
  visibleTrajectories,
  pausePlayback,
  progressOf,
  resumePlayback,
  seekPlayback,
  startPlayback,
  stopPlayback,
  syncPlayback,
  tickPlayback,
  trajectoryDurationS,
  type PlaybackMap,
} from "@/lib/trajectory-playback";
import type { AgentTrajectory, DynamicWaypoint } from "@/lib/simulation-data";

function wp(t: number, over: Partial<DynamicWaypoint> = {}): DynamicWaypoint {
  return {
    lat: 45.5,
    lng: -73.6,
    alt_ft: 1000,
    speed_kts: 100,
    heading_deg: 0,
    phase: "cruise",
    t_offset_s: t,
    ...over,
  };
}

function traj(id: string, duration = 100): AgentTrajectory {
  return {
    hex_ident: id,
    callsign: id.toLowerCase(),
    category: "helicopter",
    waypoints: [wp(0), wp(duration / 2), wp(duration)],
  };
}

const A = traj("SIM-A", 100);
const B = traj("SIM-B", 60);
const TRAJS = [A, B];

const playingAt = (s: number): PlaybackMap => ({
  "SIM-A": { state: "playing", elapsedS: s },
});

describe("trajectoryDurationS", () => {
  it("is the last waypoint's offset", () => {
    expect(trajectoryDurationS(A)).toBe(100);
  });

  it("is zero for an empty trajectory", () => {
    expect(trajectoryDurationS({ ...A, waypoints: [] })).toBe(0);
  });
});

describe("isVisible", () => {
  it("is false when stopped or absent", () => {
    expect(isVisible(STOPPED)).toBe(false);
    expect(isVisible(undefined)).toBe(false);
  });

  it("is true while playing or paused", () => {
    expect(isVisible({ state: "playing", elapsedS: 0 })).toBe(true);
    expect(isVisible({ state: "paused", elapsedS: 5 })).toBe(true);
  });
});

describe("syncPlayback", () => {
  it("adds new trajectories in the stopped state", () => {
    /* Generation must not auto-start — the user presses Start. */
    const next = syncPlayback({}, TRAJS);
    expect(next["SIM-A"]).toEqual(STOPPED);
    expect(next["SIM-B"]).toEqual(STOPPED);
  });

  it("preserves existing playback state", () => {
    const next = syncPlayback(playingAt(42), TRAJS);
    expect(next["SIM-A"]).toEqual({ state: "playing", elapsedS: 42 });
  });

  it("drops entries for trajectories that no longer exist", () => {
    const next = syncPlayback({ "SIM-GONE": { state: "playing", elapsedS: 5 } }, [A]);
    expect(next["SIM-GONE"]).toBeUndefined();
    expect(Object.keys(next)).toEqual(["SIM-A"]);
  });

  it("returns an empty map for no trajectories", () => {
    expect(syncPlayback(playingAt(1), [])).toEqual({});
  });
});

describe("tickPlayback", () => {
  it("advances a playing clock", () => {
    const next = tickPlayback(playingAt(10), TRAJS, 2);
    expect(next["SIM-A"].elapsedS).toBe(12);
  });

  it("leaves paused clocks alone", () => {
    const paused: PlaybackMap = { "SIM-A": { state: "paused", elapsedS: 10 } };
    expect(tickPlayback(paused, TRAJS, 5)["SIM-A"].elapsedS).toBe(10);
  });

  it("leaves stopped clocks alone", () => {
    const stopped: PlaybackMap = { "SIM-A": { ...STOPPED } };
    expect(tickPlayback(stopped, TRAJS, 5)["SIM-A"]).toEqual(STOPPED);
  });

  it("pauses at the end rather than overshooting", () => {
    /* Staying visible at the final position is what lets the user scrub back. */
    const next = tickPlayback(playingAt(99), TRAJS, 5);
    expect(next["SIM-A"]).toEqual({ state: "paused", elapsedS: 100 });
  });

  it("respects each trajectory's own duration", () => {
    const both: PlaybackMap = {
      "SIM-A": { state: "playing", elapsedS: 59 },
      "SIM-B": { state: "playing", elapsedS: 59 },
    };
    const next = tickPlayback(both, TRAJS, 2);
    expect(next["SIM-A"].state).toBe("playing");
    expect(next["SIM-B"]).toEqual({ state: "paused", elapsedS: 60 });
  });

  it("keeps map identity when nothing is playing", () => {
    /* Lets React skip a re-render on idle ticks. */
    const idle: PlaybackMap = { "SIM-A": { ...STOPPED } };
    expect(tickPlayback(idle, TRAJS, 2)).toBe(idle);
  });
});

describe("transport controls", () => {
  it("start begins a stopped trajectory at zero", () => {
    const next = startPlayback({ "SIM-A": { ...STOPPED } }, ["SIM-A"]);
    expect(next["SIM-A"]).toEqual({ state: "playing", elapsedS: 0 });
  });

  it("start on a paused trajectory resumes in place", () => {
    const next = startPlayback({ "SIM-A": { state: "paused", elapsedS: 30 } }, ["SIM-A"]);
    expect(next["SIM-A"]).toEqual({ state: "playing", elapsedS: 30 });
  });

  it("start restarts an already-playing trajectory from zero", () => {
    expect(startPlayback(playingAt(50), ["SIM-A"])["SIM-A"].elapsedS).toBe(0);
  });

  it("pause freezes in place and keeps it visible", () => {
    const next = pausePlayback(playingAt(30), ["SIM-A"]);
    expect(next["SIM-A"]).toEqual({ state: "paused", elapsedS: 30 });
    expect(isVisible(next["SIM-A"])).toBe(true);
  });

  it("resume continues from where it paused", () => {
    const next = resumePlayback({ "SIM-A": { state: "paused", elapsedS: 30 } }, ["SIM-A"]);
    expect(next["SIM-A"]).toEqual({ state: "playing", elapsedS: 30 });
  });

  it("resume does nothing to a stopped trajectory", () => {
    const next = resumePlayback({ "SIM-A": { ...STOPPED } }, ["SIM-A"]);
    expect(next["SIM-A"]).toEqual(STOPPED);
  });

  it("stop rewinds and hides", () => {
    const next = stopPlayback(playingAt(80), ["SIM-A"]);
    expect(next["SIM-A"]).toEqual(STOPPED);
    expect(isVisible(next["SIM-A"])).toBe(false);
  });

  it("applies to several trajectories at once", () => {
    const both: PlaybackMap = { "SIM-A": { ...STOPPED }, "SIM-B": { ...STOPPED } };
    const next = startPlayback(both, ["SIM-A", "SIM-B"]);
    expect(next["SIM-A"].state).toBe("playing");
    expect(next["SIM-B"].state).toBe("playing");
  });

  it("leaves unselected trajectories untouched", () => {
    const both: PlaybackMap = { "SIM-A": { ...STOPPED }, "SIM-B": { ...STOPPED } };
    const next = startPlayback(both, ["SIM-A"]);
    expect(next["SIM-B"]).toEqual(STOPPED);
  });

  it("ignores unknown ids", () => {
    const map: PlaybackMap = { "SIM-A": { ...STOPPED } };
    expect(() => startPlayback(map, ["NOPE"])).not.toThrow();
    expect(startPlayback(map, ["NOPE"])).toBe(map);
  });

  it("an empty selection is a no-op", () => {
    const map = playingAt(5);
    expect(stopPlayback(map, [])).toBe(map);
  });
});

describe("seekPlayback", () => {
  it("jumps to the requested time", () => {
    expect(seekPlayback(playingAt(10), "SIM-A", 55, TRAJS)["SIM-A"].elapsedS).toBe(55);
  });

  it("keeps playing when it was playing", () => {
    expect(seekPlayback(playingAt(10), "SIM-A", 55, TRAJS)["SIM-A"].state).toBe("playing");
  });

  it("shows a stopped trajectory at the sought point", () => {
    /* Dragging the scrubber should reveal where you landed, not stay blank. */
    const next = seekPlayback({ "SIM-A": { ...STOPPED } }, "SIM-A", 40, TRAJS);
    expect(next["SIM-A"]).toEqual({ state: "paused", elapsedS: 40 });
  });

  it("clamps past the end", () => {
    expect(seekPlayback(playingAt(10), "SIM-A", 9999, TRAJS)["SIM-A"].elapsedS).toBe(100);
  });

  it("clamps before the start", () => {
    expect(seekPlayback(playingAt(10), "SIM-A", -50, TRAJS)["SIM-A"].elapsedS).toBe(0);
  });

  it("ignores an unknown id", () => {
    const map = playingAt(10);
    expect(seekPlayback(map, "NOPE", 5, TRAJS)).toBe(map);
  });
});

describe("progressOf", () => {
  it("is the fraction through the route", () => {
    expect(progressOf({ state: "playing", elapsedS: 25 }, A)).toBeCloseTo(0.25);
  });

  it("is zero without an entry", () => {
    expect(progressOf(undefined, A)).toBe(0);
  });

  it("is zero for a zero-length trajectory", () => {
    expect(progressOf({ state: "playing", elapsedS: 5 }, { ...A, waypoints: [] })).toBe(0);
  });

  it("never exceeds 1", () => {
    expect(progressOf({ state: "paused", elapsedS: 999 }, A)).toBe(1);
  });
});

describe("formatClock", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [65, "1:05"],
    [600, "10:00"],
    [3599, "59:59"],
  ])("formats %s seconds as %s", (input, expected) => {
    expect(formatClock(input)).toBe(expected);
  });

  it("clamps negatives to zero", () => {
    expect(formatClock(-10)).toBe("0:00");
  });

  it("truncates fractional seconds", () => {
    expect(formatClock(9.9)).toBe("0:09");
  });
});

/**
 * Visibility is a *separate axis* from transport: hiding must never disturb the
 * clock, so an aircraft un-hidden later reappears where it should be by now
 * rather than back at the start.
 */
describe("visibleTrajectories", () => {
  const A = traj("SIM-A");
  const B = traj("SIM-B");
  const C = traj("SIM-C");
  const playing = { state: "playing", elapsedS: 30 } as const;

  it("keeps every running trajectory when nothing is hidden", () => {
    const out = visibleTrajectories([A, B], { "SIM-A": playing, "SIM-B": playing });
    expect(out.map((t) => t.hex_ident)).toEqual(["SIM-A", "SIM-B"]);
  });

  it("drops stopped trajectories", () => {
    const out = visibleTrajectories([A, B], { "SIM-A": playing, "SIM-B": STOPPED });
    expect(out.map((t) => t.hex_ident)).toEqual(["SIM-A"]);
  });

  it("drops trajectories with no playback entry at all", () => {
    const out = visibleTrajectories([A, B], { "SIM-A": playing });
    expect(out.map((t) => t.hex_ident)).toEqual(["SIM-A"]);
  });

  it("drops hidden trajectories even while they are playing", () => {
    const playback = { "SIM-A": playing, "SIM-B": playing, "SIM-C": playing };
    const out = visibleTrajectories([A, B, C], playback, new Set(["SIM-B"]));
    expect(out.map((t) => t.hex_ident)).toEqual(["SIM-A", "SIM-C"]);
  });

  it("leaves the playback map untouched when hiding", () => {
    const playback = { "SIM-A": { state: "playing", elapsedS: 42 } as const };
    visibleTrajectories([A], playback, new Set(["SIM-A"]));
    expect(playback["SIM-A"]).toEqual({ state: "playing", elapsedS: 42 });
  });

  it("treats an omitted hidden set as nothing hidden", () => {
    expect(visibleTrajectories([A], { "SIM-A": playing })).toHaveLength(1);
  });

  it("returns nothing when everything is hidden", () => {
    const playback = { "SIM-A": playing, "SIM-B": playing };
    expect(visibleTrajectories([A, B], playback, new Set(["SIM-A", "SIM-B"]))).toEqual([]);
  });
});
