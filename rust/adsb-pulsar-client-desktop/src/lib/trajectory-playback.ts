/**
 * Per-trajectory playback state — the model behind the Simulation Agent tab's
 * transport controls (start / pause / resume / stop) and its time scrubber.
 *
 * Kept pure and separate from React so the state machine is directly testable:
 * `useTrajectoryPlayback` only adds the timer, and `useAgentSimulatedTracks`
 * only renders whatever position the clock says.
 *
 * Each trajectory owns its own clock, so aircraft can be started and stopped
 * independently rather than sharing one global timeline.
 */
import type { AgentTrajectory } from "./simulation-data";

export type PlaybackState = "stopped" | "playing" | "paused";

export interface PlaybackEntry {
  state: PlaybackState;
  /** Position within the trajectory's own timeline, in seconds. */
  elapsedS: number;
}

export type PlaybackMap = Record<string, PlaybackEntry>;

export const STOPPED: PlaybackEntry = { state: "stopped", elapsedS: 0 };

/** Total duration of a trajectory — the last waypoint's time offset. */
export function trajectoryDurationS(trajectory: AgentTrajectory): number {
  const wps = trajectory.waypoints;
  return wps.length === 0 ? 0 : wps[wps.length - 1].t_offset_s;
}

/** An aircraft is on the map whenever it isn't stopped. */
export function isVisible(entry: PlaybackEntry | undefined): boolean {
  return entry !== undefined && entry.state !== "stopped";
}

/**
 * Trajectories that should actually be drawn: running, and not hidden.
 *
 * Visibility is a **separate axis** from transport. Hiding leaves the clock
 * alone, so an aircraft un-hidden later reappears where it should be by now
 * rather than back at the start — which is what stopping it would do.
 */
export function visibleTrajectories(
  trajectories: AgentTrajectory[],
  playback: PlaybackMap,
  hidden?: ReadonlySet<string>,
): AgentTrajectory[] {
  return trajectories.filter(
    (t) => isVisible(playback[t.hex_ident]) && !hidden?.has(t.hex_ident),
  );
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function durationOf(trajectories: AgentTrajectory[], id: string): number {
  const t = trajectories.find((x) => x.hex_ident === id);
  return t ? trajectoryDurationS(t) : 0;
}

/**
 * Reconcile the map with the current trajectory list.
 *
 * New trajectories enter **stopped** — generation shows them in the list but
 * nothing moves until the user presses Start. Entries for trajectories that no
 * longer exist are dropped.
 */
export function syncPlayback(
  playback: PlaybackMap,
  trajectories: AgentTrajectory[],
): PlaybackMap {
  const next: PlaybackMap = {};
  for (const t of trajectories) {
    next[t.hex_ident] = playback[t.hex_ident] ?? { ...STOPPED };
  }
  return next;
}

/**
 * Advance every playing clock by `dtS` seconds.
 *
 * A trajectory that reaches its end **pauses at the end** rather than
 * disappearing: the aircraft stays visible at its final position and the
 * scrubber can be dragged back through the route.
 */
export function tickPlayback(
  playback: PlaybackMap,
  trajectories: AgentTrajectory[],
  dtS: number,
): PlaybackMap {
  const next: PlaybackMap = {};
  let changed = false;

  for (const [id, entry] of Object.entries(playback)) {
    if (entry.state !== "playing") {
      next[id] = entry;
      continue;
    }
    const duration = durationOf(trajectories, id);
    const advanced = entry.elapsedS + dtS;
    next[id] =
      advanced >= duration
        ? { state: "paused", elapsedS: duration }
        : { state: "playing", elapsedS: advanced };
    changed = true;
  }

  // Preserve identity when nothing moved, so React can skip re-rendering.
  return changed ? next : playback;
}

/** Start (or restart from the beginning) the given trajectories. */
export function startPlayback(playback: PlaybackMap, ids: string[]): PlaybackMap {
  return applyTo(playback, ids, (entry) =>
    // Resuming a paused aircraft continues from where it was; starting a
    // stopped one begins at zero.
    entry.state === "paused"
      ? { state: "playing", elapsedS: entry.elapsedS }
      : { state: "playing", elapsedS: 0 },
  );
}

/** Freeze in place, staying visible on the map. */
export function pausePlayback(playback: PlaybackMap, ids: string[]): PlaybackMap {
  return applyTo(playback, ids, (entry) =>
    entry.state === "playing" ? { state: "paused", elapsedS: entry.elapsedS } : entry,
  );
}

/** Continue a paused trajectory from where it left off. */
export function resumePlayback(playback: PlaybackMap, ids: string[]): PlaybackMap {
  return applyTo(playback, ids, (entry) =>
    entry.state === "paused" ? { state: "playing", elapsedS: entry.elapsedS } : entry,
  );
}

/** Halt and rewind — the aircraft leaves the map. */
export function stopPlayback(playback: PlaybackMap, ids: string[]): PlaybackMap {
  return applyTo(playback, ids, () => ({ ...STOPPED }));
}

/**
 * Jump to a point in a trajectory's timeline.
 *
 * Seeking a stopped trajectory pauses it at that point rather than leaving it
 * invisible — dragging the scrubber should show you where you landed.
 */
export function seekPlayback(
  playback: PlaybackMap,
  id: string,
  elapsedS: number,
  trajectories: AgentTrajectory[],
): PlaybackMap {
  const entry = playback[id];
  if (!entry) return playback;

  const target = clamp(elapsedS, 0, durationOf(trajectories, id));
  return {
    ...playback,
    [id]: {
      state: entry.state === "playing" ? "playing" : "paused",
      elapsedS: target,
    },
  };
}

function applyTo(
  playback: PlaybackMap,
  ids: string[],
  fn: (entry: PlaybackEntry) => PlaybackEntry,
): PlaybackMap {
  if (ids.length === 0) return playback;
  const next = { ...playback };
  let changed = false;
  for (const id of ids) {
    const entry = next[id];
    if (!entry) continue;
    const updated = fn(entry);
    if (updated !== entry) {
      next[id] = updated;
      changed = true;
    }
  }
  return changed ? next : playback;
}

/** Progress through a trajectory as a 0–1 fraction, for the scrubber. */
export function progressOf(
  entry: PlaybackEntry | undefined,
  trajectory: AgentTrajectory,
): number {
  const duration = trajectoryDurationS(trajectory);
  if (!entry || duration <= 0) return 0;
  return clamp(entry.elapsedS / duration, 0, 1);
}

/** `m:ss` for the scrubber's time readout. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
