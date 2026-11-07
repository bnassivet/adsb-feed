"use client";
import { useState, useMemo } from "react";
import { useTauriEvent } from "./useTauriEvent";
import { useWindowedRate } from "./useWindowedRate";
import { useLocalStorage } from "./useLocalStorage";
import type { MetricsSnapshot } from "@/lib/types";

const EMPTY_METRICS: MetricsSnapshot = {
  messages_sent: 0,
  messages_received: 0,
  lines_received: 0,
  messages_parsed: 0,
  positions_parsed: 0,
  errors: 0,
  bytes_received: 0,
  bytes_sent: 0,
  retry_queue_size: 0,
  reconnection_attempts: 0,
  elapsed_secs: 0,
  throughput_msg_per_sec: 0,
};

export interface MetricsWithRates extends MetricsSnapshot {
  /** hits/s: windowed rate of every line received, parsed or not. */
  hits_per_sec: number;
  /** pos/s: windowed rate of merged messages carrying a lat/lon fix. */
  pos_per_sec: number;
}

/**
 * Subscribes to `adsb:metrics` events and returns the latest snapshot
 * with windowed rates:
 * - `hits_per_sec` (hits/s): every line received, parsed or not (`lines_received`)
 * - `throughput_msg_per_sec` (msgs/s): MSG lines used to update aircraft
 *   information, MSG1–7 (`messages_parsed`)
 * - `pos_per_sec` (pos/s): the merged lines carrying a lat/lon (`positions_parsed`)
 *
 * So hits/s >= msgs/s >= pos/s. All three counters come from the shared ingest pipeline, never from the socket
 * client's `messages_sent`: an MQTT session has no socket client, and its base
 * counters are a zeroed handle — reading them left hits/s stuck at 0.
 */
export function useMetrics(): MetricsWithRates {
  const [metrics, setMetrics] = useState<MetricsSnapshot>(EMPTY_METRICS);
  const [windowSecs] = useLocalStorage<number>("adsb-metrics-window-secs", 5);

  useTauriEvent<MetricsSnapshot>("adsb:metrics", setMetrics);

  const active = metrics.elapsed_secs > 0 ? metrics : null;

  const hitsPerSec = useWindowedRate(
    active?.lines_received ?? null,
    metrics.elapsed_secs,
    windowSecs,
  );

  const msgsPerSec = useWindowedRate(
    active?.messages_parsed ?? null,
    metrics.elapsed_secs,
    windowSecs,
  );

  const posPerSec = useWindowedRate(
    active?.positions_parsed ?? null,
    metrics.elapsed_secs,
    windowSecs,
  );

  return useMemo(
    () => ({
      ...metrics,
      hits_per_sec: hitsPerSec,
      throughput_msg_per_sec: msgsPerSec,
      pos_per_sec: posPerSec,
    }),
    [metrics, hitsPerSec, msgsPerSec, posPerSec],
  );
}
