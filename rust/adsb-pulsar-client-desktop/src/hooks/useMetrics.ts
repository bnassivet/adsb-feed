"use client";
import { useState } from "react";
import { useTauriEvent } from "./useTauriEvent";
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
 * Subscribes to `adsb:metrics` events and returns the latest snapshot.
 */
export function useMetrics(): MetricsSnapshot {
  const [metrics, setMetrics] = useState<MetricsSnapshot>(EMPTY_METRICS);

  useTauriEvent<MetricsSnapshot>("adsb:metrics", setMetrics);

  return metrics;
}
