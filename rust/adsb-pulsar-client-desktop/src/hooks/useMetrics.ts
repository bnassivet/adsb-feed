"use client";
import { useState, useMemo } from "react";
import { useTauriEvent } from "./useTauriEvent";
import { useWindowedRate } from "./useWindowedRate";
import { useLocalStorage } from "./useLocalStorage";
import type { MetricsSnapshot } from "@/lib/types";

const EMPTY_METRICS: MetricsSnapshot = {
  messages_sent: 0,
  messages_received: 0,
  errors: 0,
  bytes_received: 0,
  bytes_sent: 0,
  retry_queue_size: 0,
  elapsed_secs: 0,
  throughput_msg_per_sec: 0,
};

export interface MetricsWithRates extends MetricsSnapshot {
  /** Windowed raw SBS-1 message rate (pre-throttle). */
  hits_per_sec: number;
}

/**
 * Subscribes to `adsb:metrics` events and returns the latest snapshot
 * with throughput_msg_per_sec replaced by a sliding-window rate,
 * plus a windowed hits_per_sec for raw message rate.
 */
export function useMetrics(): MetricsWithRates {
  const [metrics, setMetrics] = useState<MetricsSnapshot>(EMPTY_METRICS);
  const [windowSecs] = useLocalStorage<number>("adsb-metrics-window-secs", 5);

  useTauriEvent<MetricsSnapshot>("adsb:metrics", setMetrics);

  const active = metrics.elapsed_secs > 0 ? metrics : null;

  const windowedRate = useWindowedRate(
    active?.messages_sent ?? null,
    metrics.elapsed_secs,
    windowSecs,
    metrics.throughput_msg_per_sec,
  );

  const hitsPerSec = useWindowedRate(
    active?.messages_received ?? null,
    metrics.elapsed_secs,
    windowSecs,
  );

  return useMemo(
    () => ({ ...metrics, throughput_msg_per_sec: windowedRate, hits_per_sec: hitsPerSec }),
    [metrics, windowedRate, hitsPerSec],
  );
}
