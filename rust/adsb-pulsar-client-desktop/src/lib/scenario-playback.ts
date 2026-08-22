/**
 * Master-clock playback for a whole scenario.
 *
 * A scenario is more than a bag of trajectories: what makes it a *scenario* is
 * relative timing — "the intruder appears 90 seconds in". That is expressed as
 * one master clock plus a `start_offset_s` per track.
 *
 * The key design choice is that this never replaces the per-trajectory playback
 * machinery. `useAgentSimulatedTracks` is a stateless renderer over a
 * `PlaybackMap`, so a master clock only has to *project* onto that same map:
 * everything downstream — sampling, trails, route polylines, visibility — keeps
 * working untouched. See `trajectory-playback.ts` for the per-track model.
 *
 * Pure and React-free, so each timing boundary is directly testable.
 */
import type { AgentTrajectory } from "./simulation-data";
import {
  STOPPED,
  trajectoryDurationS,
  type PlaybackMap,
  type PlaybackState,
} from "./trajectory-playback";

/** Where the scenario as a whole is, in its own timeline. */
export interface ScenarioClock {
  state: PlaybackState;
  /** Seconds from the start of the scenario. */
  elapsedS: number;
}

/** One track's trajectory paired with when it enters the scenario. */
export interface ScenarioTiming {
  trajectory: AgentTrajectory;
  startOffsetS: number;
}

export const SCENARIO_STOPPED: ScenarioClock = { state: "stopped", elapsedS: 0 };

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * How long the scenario runs: until its last aircraft finishes.
 *
 * An aircraft entering at 90s and flying for 30s makes a 120-second scenario,
 * even if every other track is shorter.
 */
export function scenarioDurationS(timings: ScenarioTiming[]): number {
  let max = 0;
  for (const { trajectory, startOffsetS } of timings) {
    max = Math.max(max, startOffsetS + trajectoryDurationS(trajectory));
  }
  return max;
}

/**
 * Project the master clock onto a per-trajectory `PlaybackMap`.
 *
 * Three regimes per track:
 * - before its offset — **stopped**, so it is not on the map yet (and scrubbing
 *   back before the offset removes it again);
 * - within its span — it inherits the master state, at `T - offset`;
 * - past its end — **paused at its final waypoint**, matching the per-track
 *   hold-at-end behaviour that lets the scrubber be dragged back through it.
 */
export function projectScenario(
  clock: ScenarioClock,
  timings: ScenarioTiming[],
): PlaybackMap {
  const map: PlaybackMap = {};

  for (const { trajectory, startOffsetS } of timings) {
    const id = trajectory.hex_ident;

    if (clock.state === "stopped") {
      map[id] = { ...STOPPED };
      continue;
    }

    const local = clock.elapsedS - startOffsetS;
    if (local < 0) {
      map[id] = { ...STOPPED };
      continue;
    }

    const duration = trajectoryDurationS(trajectory);
    map[id] =
      local >= duration
        ? { state: "paused", elapsedS: duration }
        : { state: clock.state, elapsedS: local };
  }

  return map;
}

/**
 * Advance the master clock by `dtS` seconds.
 *
 * Reaching the end pauses at the full duration rather than stopping, so the
 * final frame stays on screen and remains scrubbable. Returns the same object
 * when nothing moved, so React can skip the re-render.
 */
export function tickScenario(
  clock: ScenarioClock,
  timings: ScenarioTiming[],
  dtS: number,
): ScenarioClock {
  if (clock.state !== "playing") return clock;

  const duration = scenarioDurationS(timings);
  const advanced = clock.elapsedS + dtS;

  return advanced >= duration
    ? { state: "paused", elapsedS: duration }
    : { state: "playing", elapsedS: advanced };
}

/**
 * Overlay the scenario's projected clocks onto the per-trajectory playback map.
 *
 * This is what makes the two transports coexist. While the scenario clock is
 * stopped nothing is overridden, so each track keeps its own Start/Pause/Stop —
 * the authoring workflow, where you audition one aircraft at a time. Once the
 * master clock runs it owns the scenario's tracks, while any *staged* (generated
 * but not yet saved) trajectory stays on its own clock and is unaffected.
 *
 * Returns the input untouched when the scenario is idle, so React skips the
 * re-render.
 */
export function mergeScenarioPlayback(
  base: PlaybackMap,
  clock: ScenarioClock,
  timings: ScenarioTiming[],
): PlaybackMap {
  if (clock.state === "stopped") return base;
  return { ...base, ...projectScenario(clock, timings) };
}

/** Play from the start, or resume a paused scenario where it left off. */
export function startScenario(clock: ScenarioClock): ScenarioClock {
  return clock.state === "paused"
    ? { state: "playing", elapsedS: clock.elapsedS }
    : { state: "playing", elapsedS: 0 };
}

/** Freeze the scenario in place, leaving its aircraft on the map. */
export function pauseScenario(clock: ScenarioClock): ScenarioClock {
  return clock.state === "playing"
    ? { state: "paused", elapsedS: clock.elapsedS }
    : clock;
}

/**
 * Halt and rewind — every aircraft leaves the map.
 *
 * Takes no previous state, which is what lets it be passed straight to
 * `setClock(stopScenario)`.
 */
export function stopScenario(): ScenarioClock {
  return { ...SCENARIO_STOPPED };
}

/**
 * Jump to a point in the scenario's timeline.
 *
 * Seeking a stopped scenario pauses it there rather than leaving it invisible —
 * dragging the scrubber should show you where you landed.
 */
export function seekScenario(
  clock: ScenarioClock,
  timings: ScenarioTiming[],
  elapsedS: number,
): ScenarioClock {
  const target = clamp(elapsedS, 0, scenarioDurationS(timings));
  return {
    state: clock.state === "playing" ? "playing" : "paused",
    elapsedS: target,
  };
}
