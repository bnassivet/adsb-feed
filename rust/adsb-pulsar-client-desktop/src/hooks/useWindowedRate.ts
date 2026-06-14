"use client";
import { useState } from "react";

interface RateEntry {
  counter: number;
  elapsed_secs: number;
}

/**
 * Pure reducer: given the current window and a new snapshot, returns the next window.
 * Appends only when elapsed_secs advanced, then trims entries older than `windowSecs`.
 * Returns the same array reference when nothing changed (so callers can skip a state update).
 */
function nextWindow(buffer: RateEntry[], counterValue: number, elapsedSecs: number, windowSecs: number): RateEntry[] {
  const advanced = buffer.length === 0 || elapsedSecs > buffer[buffer.length - 1].elapsed_secs;
  if (!advanced) {
    return buffer;
  }
  const appended = [...buffer, { counter: counterValue, elapsed_secs: elapsedSecs }];
  const cutoff = elapsedSecs - windowSecs;
  let start = 0;
  while (start < appended.length - 1 && appended[start].elapsed_secs < cutoff) {
    start++;
  }
  return start === 0 ? appended : appended.slice(start);
}

/** Pure rate from a window: (newest.counter - oldest.counter) / dt, or fallback when undefined. */
function rateOf(buffer: RateEntry[], fallbackRate: number): number {
  if (buffer.length < 2) {
    return fallbackRate;
  }
  const oldest = buffer[0];
  const newest = buffer[buffer.length - 1];
  const dt = newest.elapsed_secs - oldest.elapsed_secs;
  return dt <= 0 ? fallbackRate : (newest.counter - oldest.counter) / dt;
}

/**
 * Computes a sliding-window rate from a cumulative counter and elapsed time.
 *
 * Maintains a window of recent entries and returns:
 *   (newest.counter - oldest.counter) / (newest.elapsed_secs - oldest.elapsed_secs)
 *
 * Falls back to `fallbackRate` (default 0) when fewer than 2 entries exist.
 * Returns 0 when counterValue is null.
 *
 * The window is held in state and updated with the React "adjust state during render" pattern
 * (a guarded set-state call during render), which keeps the computation pure — no refs are read
 * or written during render — so it is Rules-of-React / React-Compiler safe.
 */
export function useWindowedRate(
  counterValue: number | null,
  elapsedSecs: number,
  windowSecs: number,
  fallbackRate: number = 0,
): number {
  const [buffer, setBuffer] = useState<RateEntry[]>([]);

  // Reuse the existing array reference when nothing changes so the guarded set-state below is a
  // no-op on steady renders (avoids an infinite render-phase update loop).
  let computed = buffer;
  if (counterValue === null) {
    if (buffer.length > 0) computed = [];
  } else {
    computed = nextWindow(buffer, counterValue, elapsedSecs, windowSecs);
  }
  if (computed !== buffer) {
    setBuffer(computed);
  }

  return counterValue === null ? 0 : rateOf(computed, fallbackRate);
}
