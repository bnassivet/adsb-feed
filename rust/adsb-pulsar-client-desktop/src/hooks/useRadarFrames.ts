"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRadarFrames } from "@/lib/commands";
import { frameDelayMs, mergeFrames, nextFrame, type RadarFrameSet } from "@/lib/radar";
import { RADAR_RADIUS_NM } from "./useRadar";

export interface UseRadarFrames {
  /** The frames held, oldest first; null while off or before the first answer. */
  frames: RadarFrameSet | null;
  error: string | null;
}

/**
 * The last hour of radar frames, for the animation. Asked when switched on and
 * again for each new latest image (`latestMs`), which is when Rust has saved
 * one more; only the new images travel.
 */
export function useRadarFrames(
  enabled: boolean,
  center: { lat: number; lng: number } | null,
  latestMs: number | null,
): UseRadarFrames {
  const [held, setHeld] = useState<{ key: string; set: RadarFrameSet } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest answer, for the next request's known list; written only in callbacks.
  const current = useRef<{ key: string; set: RadarFrameSet } | null>(null);
  // Set synchronously, so StrictMode's second effect run does not ask twice.
  const asked = useRef("");
  const lat = center?.lat;
  const lng = center?.lng;

  useEffect(() => {
    if (!enabled || lat == null || lng == null) {
      asked.current = "";
      return;
    }
    const key = `${lat},${lng}`;
    const request = `${key}|${latestMs}`;
    if (asked.current === request) return;
    asked.current = request;
    const prev = current.current?.key === key ? current.current.set : null;
    getRadarFrames(lat, lng, RADAR_RADIUS_NM, prev ? prev.frames.map((f) => f.validTimeMs) : [])
      .then((res) => {
        const next = { key, set: mergeFrames(prev, res) };
        current.current = next;
        setHeld(next);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [enabled, lat, lng, latestMs]);

  return { frames: enabled ? (held?.set ?? null) : null, error: enabled ? error : null };
}

export interface FrameAnimation {
  /** The frame to show. */
  index: number;
  playing: boolean;
  /** Shows frame `i` and pauses there. */
  seek: (i: number) => void;
  togglePlay: () => void;
}

/**
 * Which frame to show: loops through `count` frames while playing, holding on
 * the newest. Seeking pauses on the chosen frame; play resumes from it. While
 * not animating, the newest frame.
 */
export function useFrameAnimation(count: number, enabled: boolean): FrameAnimation {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const running = enabled && !paused && count >= 2;
  useEffect(() => {
    if (!running) return;
    const id = setTimeout(() => setIndex((i) => nextFrame(i, count)), frameDelayMs(index, count));
    return () => clearTimeout(id);
  }, [running, count, index]);
  const seek = useCallback(
    (i: number) => {
      setIndex(Math.min(Math.max(Math.round(i), 0), Math.max(count - 1, 0)));
      setPaused(true);
    },
    [count],
  );
  const togglePlay = useCallback(() => setPaused((p) => !p), []);
  const shown = enabled && count >= 2 ? Math.min(index, count - 1) : Math.max(count - 1, 0);
  return { index: shown, playing: running, seek, togglePlay };
}
