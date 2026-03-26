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
  errors: 0,
  bytes_received: 0,
  bytes_sent: 0,
  retry_queue_size: 0,
  reconnection_attempts: 0,
  elapsed_secs: 0,
  throughput_msg_per_sec: 0,
};

export interface MetricsWithRates extends MetricsSnapshot {
  /** Windowed raw TCP line rate (all lines from socket, pre-parse). */
  hits_per_sec: number;
}

/**
 * Subscribes to `adsb:metrics` events and returns the latest snapshot
 * with windowed rates:
 * - `hits_per_sec`: all raw lines from socket (messages_sent counter)
 * - `throughput_msg_per_sec`: successfully parsed MSG messages (messages_parsed counter)
 */
export function useMetrics(): MetricsWithRates {
  const [metrics, setMetrics] = useState<MetricsSnapshot>(EMPTY_METRICS);
  const [windowSecs] = useLocalStorage<number>("adsb-metrics-window-secs", 5);

  useTauriEvent<MetricsSnapshot>("adsb:metrics", setMetrics);

  const active = metrics.elapsed_secs > 0 ? metrics : null;

  const windowedRate = useWindowedRate(
    active?.messages_parsed ?? null,
    metrics.elapsed_secs,
    windowSecs,
  );

  const hitsPerSec = useWindowedRate(
    active?.messages_sent ?? null,
    metrics.elapsed_secs,
    windowSecs,
    metrics.throughput_msg_per_sec,
  );

  return useMemo(
    () => ({ ...metrics, throughput_msg_per_sec: windowedRate, hits_per_sec: hitsPerSec }),
    [metrics, windowedRate, hitsPerSec],
  );
}
