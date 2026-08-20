"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SCENARIO_STOPPED,
  pauseScenario,
  scenarioDurationS,
  seekScenario,
  startScenario,
  stopScenario,
  tickScenario,
  type ScenarioClock,
  type ScenarioTiming,
} from "@/lib/scenario-playback";
import { PLAYBACK_TICK_MS } from "./useTrajectoryPlayback";

/**
 * Drives the scenario master clock.
 *
 * Deliberately separate from `useTrajectoryPlayback`: that hook owns per-track
 * transport and a StrictMode-sensitive auto-start path that is not worth
 * disturbing. The two are combined by `mergeScenarioPlayback` at the call site,
 * which keeps each hook's responsibility single and independently testable.
 *
 * All state-machine logic lives in `lib/scenario-playback.ts`; this adds only
 * the timer and the React plumbing.
 */
export interface ScenarioPlaybackApi {
  clock: ScenarioClock;
  /** Total scenario length in seconds — the scrubber's maximum. */
  durationS: number;
  start: () => void;
  pause: () => void;
  stop: () => void;
  seek: (elapsedS: number) => void;
}

export function useScenarioPlayback(timings: ScenarioTiming[]): ScenarioPlaybackApi {
  const [clock, setClock] = useState<ScenarioClock>(SCENARIO_STOPPED);

  // The interval and the seek callback need the current timings without being
  // torn down every render. Written in an effect, not during render —
  // `react-hooks/refs` is an error in this repo and a render-phase ref write is
  // unsafe under the React Compiler.
  const timingsRef = useRef(timings);
  useEffect(() => {
    timingsRef.current = timings;
  });

  // Keyed on content rather than array identity so an inline-array caller does
  // not re-trigger this forever (the same trap `useTrajectoryPlayback` documents).
  const signature = timings
    .map((t) => `${t.trajectory.hex_ident}@${t.startOffsetS}`)
    .join("|");

  // A scenario whose tracks changed underneath a running clock should not keep
  // playing against a timeline that no longer exists.
  // Depends on `signature` alone by design: the effect body reads no props, so
  // exhaustive-deps has nothing to add here.
  useEffect(() => {
    setClock((prev) => (prev.state === "stopped" ? prev : { ...SCENARIO_STOPPED }));
  }, [signature]);

  // `tickScenario` returns the same object when not playing, so an idle
  // interval costs no re-render.
  useEffect(() => {
    const interval = setInterval(() => {
      setClock((prev) => tickScenario(prev, timingsRef.current, PLAYBACK_TICK_MS / 1000));
    }, PLAYBACK_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const start = useCallback(() => setClock(startScenario), []);
  const pause = useCallback(() => setClock(pauseScenario), []);
  const stop = useCallback(() => setClock(stopScenario), []);
  const seek = useCallback((elapsedS: number) => {
    setClock((prev) => seekScenario(prev, timingsRef.current, elapsedS));
  }, []);

  const durationS = useMemo(() => scenarioDurationS(timings), [timings]);

  return useMemo(
    () => ({ clock, durationS, start, pause, stop, seek }),
    [clock, durationS, start, pause, stop, seek],
  );
}
