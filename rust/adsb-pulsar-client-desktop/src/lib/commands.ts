/** Typed wrappers around Tauri invoke() for all backend commands. */
import { invoke } from "@tauri-apps/api/core";
import type {
  AircraftSummary,
  BboxQuery,
  Config,
  DetectionRangeQuery,
  DetectionRangeSector,
  MetricsSnapshot,
  PositionRecord,
  StatusResponse,
  StorageStats,
  TimeDistributionBucket,
  TimeDistributionQuery,
  TrajectoryQuery,
} from "./types";

export async function startFeed(): Promise<void> {
  return invoke("start_feed");
}

export async function stopFeed(): Promise<void> {
  return invoke("stop_feed");
}

export async function getStatus(): Promise<StatusResponse> {
  return invoke("get_status");
}

export async function getMetrics(): Promise<MetricsSnapshot> {
  return invoke("get_metrics");
}

export async function getConfig(): Promise<Config> {
  return invoke("get_config");
}

export async function saveConfig(config: Config): Promise<void> {
  return invoke("save_config", { config });
}

export async function validateConfig(config: Config): Promise<void> {
  return invoke("validate_config", { config });
}

// --- Historical query commands ---

export async function queryBbox(
  query: BboxQuery
): Promise<PositionRecord[]> {
  return invoke("query_bbox", { query });
}

export async function getTrajectory(
  query: TrajectoryQuery
): Promise<PositionRecord[]> {
  return invoke("get_trajectory", { query });
}

export async function getAircraftSummary(
  startMs?: number | null,
  endMs?: number | null
): Promise<AircraftSummary[]> {
  return invoke("get_aircraft_summary", {
    startMs: startMs ?? null,
    endMs: endMs ?? null,
  });
}

export async function getTimeDistribution(
  query: TimeDistributionQuery
): Promise<TimeDistributionBucket[]> {
  return invoke("get_time_distribution", { query });
}

export async function getStorageStats(): Promise<StorageStats> {
  return invoke("get_storage_stats");
}

export async function getDetectionRange(
  query: DetectionRangeQuery
): Promise<DetectionRangeSector[]> {
  return invoke("get_detection_range", { query });
}
