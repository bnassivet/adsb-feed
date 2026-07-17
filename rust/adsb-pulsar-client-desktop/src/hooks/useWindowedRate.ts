"use client";
import { useEffect, useState } from "react";

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
 * The next window is computed *purely* during render (no state mutation there) and drives the
 * returned rate, so there is no one-tick display lag. The window is persisted to state only from
 * an effect — never with a render-phase set-state — because the React Compiler does not reliably
 * apply render-phase state updates at runtime (it would leave the buffer stuck at < 2 entries, so
 * the rate would read a constant fallback of 0). Persisting from an effect keeps this correct
 * under the compiler.
 */
export function useWindowedRate(
  counterValue: number | null,
  elapsedSecs: number,
  windowSecs: number,
  fallbackRate: number = 0,
): number {
  const [buffer, setBuffer] = useState<RateEntry[]>([]);

  // Pure: compute the next window in render. Reuse the existing array reference when nothing
  // changes so the effect dependency below is stable on steady renders (no refire, no loop).
  let nextBuf = buffer;
  if (counterValue === null) {
    if (buffer.length > 0) nextBuf = [];
  } else {
    nextBuf = nextWindow(buffer, counterValue, elapsedSecs, windowSecs);
  }

  // Persist only from an effect. When nextBuf === buffer the dep is unchanged and this does not
  // refire; otherwise it commits the new window (and setBuffer to the same ref later is a no-op).
  useEffect(() => {
    setBuffer(nextBuf);
  }, [nextBuf]);

  return counterValue === null ? 0 : rateOf(nextBuf, fallbackRate);
}
