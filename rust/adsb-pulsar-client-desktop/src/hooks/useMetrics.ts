"use client";
import { useState, useMemo } from "react";
import { useTauriEvent } from "./useTauriEvent";
import { useWindowedRate } from "./useWindowedRate";
import { useLocalStorage } from "./useLocalStorage";
import type { MetricsSnapshot } from "@/lib/types";

const EMPTY_METRICS: MetricsSnapshot = {
  messages_sent: 0,
  messages_received: 0,
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
  /** Windowed rate of every ADS-B message received, whatever its MSG type. */
  hits_per_sec: number;
}

/**
 * Subscribes to `adsb:metrics` events and returns the latest snapshot
 * with windowed rates:
 * - `hits_per_sec`: every valid MSG line, any type (`messages_parsed`)
 * - `throughput_msg_per_sec`: position messages only (`positions_parsed`)
 *
 * Both counters come from the shared ingest pipeline, never from the socket
 * client's `messages_sent`: an MQTT session has no socket client, and its base
 * counters are a zeroed handle — reading them left hits/s stuck at 0.
 */
export function useMetrics(): MetricsWithRates {
  const [metrics, setMetrics] = useState<MetricsSnapshot>(EMPTY_METRICS);
  const [windowSecs] = useLocalStorage<number>("adsb-metrics-window-secs", 5);

  useTauriEvent<MetricsSnapshot>("adsb:metrics", setMetrics);

  const active = metrics.elapsed_secs > 0 ? metrics : null;

  const windowedRate = useWindowedRate(
    active?.positions_parsed ?? null,
    metrics.elapsed_secs,
    windowSecs,
  );

  const hitsPerSec = useWindowedRate(
    active?.messages_parsed ?? null,
    metrics.elapsed_secs,
    windowSecs,
  );

  return useMemo(
    () => ({ ...metrics, throughput_msg_per_sec: windowedRate, hits_per_sec: hitsPerSec }),
    [metrics, windowedRate, hitsPerSec],
  );
}
