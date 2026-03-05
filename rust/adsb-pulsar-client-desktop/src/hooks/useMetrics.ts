"use client";
import { useState, useMemo } from "react";
import { useTauriEvent } from "./useTauriEvent";
import { useWindowedRate } from "./useWindowedRate";
import { useLocalStorage } from "./useLocalStorage";
import type { MetricsSnapshot } from "@/lib/types";

const EMPTY_METRICS: MetricsSnapshot = {
  messages_sent: 0,
  errors: 0,
  bytes_received: 0,
  bytes_sent: 0,
  retry_queue_size: 0,
  elapsed_secs: 0,
  throughput_msg_per_sec: 0,
};

/**
 * Subscribes to `adsb:metrics` events and returns the latest snapshot
 * with throughput_msg_per_sec replaced by a sliding-window rate.
 */
export function useMetrics(): MetricsSnapshot {
  const [metrics, setMetrics] = useState<MetricsSnapshot>(EMPTY_METRICS);
  const [windowSecs] = useLocalStorage<number>("adsb-metrics-window-secs", 5);

  useTauriEvent<MetricsSnapshot>("adsb:metrics", setMetrics);

  const windowedRate = useWindowedRate(
    metrics.elapsed_secs > 0 ? metrics : null,
    windowSecs,
  );

  return useMemo(
    () => ({ ...metrics, throughput_msg_per_sec: windowedRate }),
    [metrics, windowedRate],
  );
}
