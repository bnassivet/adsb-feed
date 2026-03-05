"use client";
import { useRef, useMemo } from "react";
import type { MetricsSnapshot } from "@/lib/types";

interface RateEntry {
  messages_sent: number;
  elapsed_secs: number;
}

/**
 * Computes a sliding-window msgs/s rate from cumulative MetricsSnapshot data.
 *
 * Maintains a ring buffer of recent snapshots and returns:
 *   (newest.messages_sent - oldest.messages_sent) / (newest.elapsed_secs - oldest.elapsed_secs)
 *
 * Falls back to cumulative throughput_msg_per_sec when fewer than 2 entries exist.
 * Returns 0 when metrics is null.
 */
export function useWindowedRate(
  metrics: MetricsSnapshot | null,
  windowSecs: number,
): number {
  const bufferRef = useRef<RateEntry[]>([]);

  return useMemo(() => {
    if (!metrics) {
      bufferRef.current = [];
      return 0;
    }

    const buffer = bufferRef.current;
    const entry: RateEntry = {
      messages_sent: metrics.messages_sent,
      elapsed_secs: metrics.elapsed_secs,
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
      return metrics.throughput_msg_per_sec;
    }

    const oldest = buffer[0];
    const newest = buffer[buffer.length - 1];
    const dt = newest.elapsed_secs - oldest.elapsed_secs;

    if (dt <= 0) {
      return metrics.throughput_msg_per_sec;
    }

    return (newest.messages_sent - oldest.messages_sent) / dt;
  }, [metrics, windowSecs]);
}
