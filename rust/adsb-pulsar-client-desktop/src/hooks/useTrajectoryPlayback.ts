"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentTrajectory } from "@/lib/simulation-data";
import {
  pausePlayback,
  resumePlayback,
  seekPlayback,
  startPlayback,
  stopPlayback,
  syncPlayback,
  tickPlayback,
  type PlaybackMap,
} from "@/lib/trajectory-playback";

/**
 * Owns the transport state for agent-generated trajectories and drives its
 * clocks. All the state-machine logic lives in `lib/trajectory-playback.ts`;
 * this hook adds only the timer and the React plumbing.
 */

/** Faster than the 2 s live-feed cadence — simulated playback is watched
 *  closely and a scrubber makes coarse steps obvious. */
export const PLAYBACK_TICK_MS = 500;

export interface TrajectoryPlaybackApi {
  playback: PlaybackMap;
  start: (ids: string[]) => void;
  pause: (ids: string[]) => void;
  resume: (ids: string[]) => void;
  stop: (ids: string[]) => void;
  seek: (id: string, elapsedS: number) => void;
  /**
   * Mark trajectories to begin playing as soon as they are adopted.
   *
   * Needed because playback entries only exist after the sync effect runs, so
   * calling `start` immediately after handing over new trajectories would find
   * nothing to start. Used by the chat path — asking the agent to "simulate a
   * helicopter" should show it flying, whereas the panel deliberately requires
   * an explicit Start.
   */
  requestAutoStart: (ids: string[]) => void;
}

export function useTrajectoryPlayback(
  trajectories: AgentTrajectory[],
): TrajectoryPlaybackApi {
  const [playback, setPlayback] = useState<PlaybackMap>({});
  // Ids to start the moment they appear. Written from an event callback, never
  // during render, so it stays within `react-hooks/refs`.
  const autoStartRef = useRef<Set<string> | null>(null);

  // Keyed on content, not array identity — this hook calls setPlayback, so an
  // inline-array caller would otherwise re-trigger the effect forever.
  const signature = trajectories.map((t) => t.hex_ident).join("|");

  // Long-lived consumers (the tick interval, the seek callback) need the
  // current list without being torn down on every render. Written in an effect
  // rather than during render — `react-hooks/refs` is an error in this repo,
  // and a render-phase ref write is unsafe under the React Compiler.
  const trajectoriesRef = useRef(trajectories);
  useEffect(() => {
    trajectoriesRef.current = trajectories;
  });

  // Reconcile when the trajectory set changes. New ones arrive stopped.
  // Closes over `trajectories` directly: this effect runs exactly when the id
  // set changes, so the captured value is the one that caused the change.
  useEffect(() => {
    setPlayback((prev) => {
      const synced = syncPlayback(prev, trajectories);
      const auto = autoStartRef.current;
      if (!auto || auto.size === 0) return synced;

      autoStartRef.current = null;
      const present = trajectories.map((t) => t.hex_ident).filter((id) => auto.has(id));
      return startPlayback(synced, present);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content
  }, [signature]);

  // Advance the clocks. `tickPlayback` returns the same object when nothing is
  // playing, so an idle interval costs no re-render.
  useEffect(() => {
    const interval = setInterval(() => {
      setPlayback((prev) =>
        tickPlayback(prev, trajectoriesRef.current, PLAYBACK_TICK_MS / 1000),
      );
    }, PLAYBACK_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const start = useCallback((ids: string[]) => {
    setPlayback((prev) => startPlayback(prev, ids));
  }, []);

  const pause = useCallback((ids: string[]) => {
    setPlayback((prev) => pausePlayback(prev, ids));
  }, []);

  const resume = useCallback((ids: string[]) => {
    setPlayback((prev) => resumePlayback(prev, ids));
  }, []);

  const stop = useCallback((ids: string[]) => {
    setPlayback((prev) => stopPlayback(prev, ids));
  }, []);

  const seek = useCallback((id: string, elapsedS: number) => {
    setPlayback((prev) => seekPlayback(prev, id, elapsedS, trajectoriesRef.current));
  }, []);

  const requestAutoStart = useCallback((ids: string[]) => {
    autoStartRef.current = new Set(ids);
  }, []);

  return useMemo(
    () => ({ playback, start, pause, resume, stop, seek, requestAutoStart }),
    [playback, start, pause, resume, stop, seek, requestAutoStart],
  );
}
