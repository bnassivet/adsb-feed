"use client";
import { useRef, useMemo } from "react";

interface RateEntry {
  counter: number;
  elapsed_secs: number;
}

/**
 * Computes a sliding-window rate from a cumulative counter and elapsed time.
 *
 * Maintains a ring buffer of recent entries and returns:
 *   (newest.counter - oldest.counter) / (newest.elapsed_secs - oldest.elapsed_secs)
 *
 * Falls back to `fallbackRate` (default 0) when fewer than 2 entries exist.
 * Returns 0 when counterValue is null.
 */
export function useWindowedRate(
  counterValue: number | null,
  elapsedSecs: number,
  windowSecs: number,
  fallbackRate: number = 0,
): number {
  const bufferRef = useRef<RateEntry[]>([]);

  return useMemo(() => {
    if (counterValue === null) {
      bufferRef.current = [];
      return 0;
    }

    const buffer = bufferRef.current;
    const entry: RateEntry = {
      counter: counterValue,
      elapsed_secs: elapsedSecs,
    };

    // Only push if elapsed_secs advanced (avoid duplicates from React re-renders)
    if (buffer.length === 0 || entry.elapsed_secs > buffer[buffer.length - 1].elapsed_secs) {
      buffer.push(entry);
    }

    // Trim entries older than windowSecs from the latest
    const cutoff = entry.elapsed_secs - windowSecs;
    while (buffer.length > 1 && buffer[0].elapsed_secs < cutoff) {
      buffer.shift();
    }

    // Need at least 2 entries for a delta
    if (buffer.length < 2) {
      return fallbackRate;
    }

    const oldest = buffer[0];
    const newest = buffer[buffer.length - 1];
    const dt = newest.elapsed_secs - oldest.elapsed_secs;

    if (dt <= 0) {
      return fallbackRate;
    }

    return (newest.counter - oldest.counter) / dt;
  }, [counterValue, elapsedSecs, windowSecs, fallbackRate]);
}
