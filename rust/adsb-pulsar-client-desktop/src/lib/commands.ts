/** Typed wrappers around Tauri invoke() for all backend commands. */
import { invoke } from "@tauri-apps/api/core";
import type {
  AircraftSummary,
  BboxQuery,
  Config,
  CreateEventOfInterest,
  CreateScenario,
  CreateScenarioTrack,
  DetectionRangeQuery,
  DetectionRangeSector,
  EventOfInterest,
  EventOfInterestQuery,
  FlightSummary,
  FlightSummaryQuery,
  HourlyHeatmapCell,
  HourlyHeatmapQuery,
  ImportPreview,
  ImportResult,
  MetricsSnapshot,
  PositionRecord,
  RawMessageQuery,
  RawSbsRecord,
  RecordingState,
  Scenario,
  ScenarioTrack,
  ScenarioWithTracks,
  StatusEvent,
  StatusEventQuery,
  StatusResponse,
  ShareInfo,
  ShareStatus,
  StorageAvailability,
  StorageMode,
  StorageStats,
  TimeDistributionBucket,
  TimeDistributionQuery,
  TrajectoryQuery,
  UpdateEventOfInterest,
  UpdateScenario,
  UpdateScenarioTrack,
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

/** The stack this window was launched for (`ADSB_STACK`), or null if unnamed. */
export async function getStack(): Promise<string | null> {
  return invoke("get_stack");
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

export async function queryBboxArrow(
  query: BboxQuery
): Promise<ArrayBuffer> {
  return invoke("query_bbox_arrow", { query });
}

export async function getTrajectory(
  query: TrajectoryQuery
): Promise<PositionRecord[]> {
  return invoke("get_trajectory", { query });
}

export async function getTrajectoryBatchArrow(
  queries: [TrajectoryQuery, string][]
): Promise<ArrayBuffer> {
  return invoke("get_trajectories_batch_arrow", { queries });
}

export async function getAllTrajectoriesArrow(
  startMs?: number | null,
  endMs?: number | null
): Promise<ArrayBuffer> {
  return invoke("get_all_trajectories_arrow", {
    startMs: startMs ?? null,
    endMs: endMs ?? null,
  });
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

export async function getFlightSummary(
  query: FlightSummaryQuery
): Promise<FlightSummary[]> {
  return invoke("get_flight_summary", { query });
}

export async function getFlightSummaryArrow(
  query: FlightSummaryQuery
): Promise<ArrayBuffer> {
  return invoke("get_flight_summary_arrow", { query });
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

export async function getHourlyHeatmap(
  query: HourlyHeatmapQuery
): Promise<HourlyHeatmapCell[]> {
  return invoke("get_hourly_heatmap", { query });
}

export async function getRawMessageCount(
  startMs?: number | null,
  endMs?: number | null
): Promise<number> {
  return invoke("get_raw_message_count", {
    startMs: startMs ?? null,
    endMs: endMs ?? null,
  });
}

export async function getRawMessages(
  query: RawMessageQuery
): Promise<RawSbsRecord[]> {
  return invoke("get_raw_messages", { query });
}

export async function getRawMessagesArrow(
  query: RawMessageQuery
): Promise<ArrayBuffer> {
  return invoke("get_raw_messages_arrow", { query });
}

// --- Recording state commands ---

export async function getRecordingState(): Promise<RecordingState> {
  return invoke("get_recording_state");
}

export async function setRecordingState(
  recording: RecordingState
): Promise<void> {
  return invoke("set_recording_state", { recording });
}

// --- Storage management commands ---

/** Storage mode currently in effect. */
export async function getStorageMode(): Promise<StorageMode> {
  return invoke<StorageMode>("get_storage_mode");
}

/**
 * Switch between embedded and remote storage.
 *
 * Applies immediately — the two modes open different database files, so the
 * history views change as soon as this resolves. Rejects with a readable
 * message if the daemon cannot be reached; storage is left unavailable rather
 * than silently reverted, because mode is explicit configuration.
 */
export async function setStorageMode(mode: StorageMode): Promise<StorageAvailability> {
  return invoke<StorageAvailability>("set_storage_mode", { mode });
}

export async function getStorageStatus(): Promise<StorageAvailability> {
  return invoke("get_storage_status");
}

export async function releaseStorage(): Promise<void> {
  return invoke("release_storage");
}

export async function reclaimStorage(): Promise<void> {
  return invoke("reclaim_storage");
}

export async function exportDatabase(targetPath: string): Promise<void> {
  return invoke("export_database", { targetPath });
}

// --- Quack sharing commands ---

/**
 * Expose the DuckDB database over Quack so other DuckDB clients can ATTACH.
 *
 * Idempotent — calling it while already sharing returns the running server's
 * details rather than starting a second one.
 */
export async function startSharing(): Promise<ShareInfo> {
  return invoke("start_sharing");
}

/** Stop exposing the database. No-op when sharing is not active. */
export async function stopSharing(): Promise<void> {
  return invoke("stop_sharing");
}

/** Current sharing state. Reports `off` when storage itself is unavailable. */
export async function sharingStatus(): Promise<ShareStatus> {
  return invoke("sharing_status");
}

export async function previewImportDatabase(path: string): Promise<ImportPreview> {
  return invoke("preview_import_database", { path });
}

export async function importDatabase(path: string): Promise<ImportResult> {
  return invoke("import_database", { path });
}

export async function swapDatabase(): Promise<string> {
  return invoke("swap_database");
}

// --- Status timeline commands ---

export async function getStatusTimeline(
  query: StatusEventQuery
): Promise<StatusEvent[]> {
  return invoke("get_status_timeline", { query });
}

// --- Events of interest commands ---

export async function createEventOfInterest(
  event: CreateEventOfInterest
): Promise<EventOfInterest> {
  return invoke("create_event_of_interest", { event });
}

export async function getEventsOfInterest(
  query: EventOfInterestQuery
): Promise<EventOfInterest[]> {
  return invoke("get_events_of_interest", { query });
}

export async function getEventOfInterest(
  id: string
): Promise<EventOfInterest> {
  return invoke("get_event_of_interest", { id });
}

export async function updateEventOfInterest(
  event: UpdateEventOfInterest
): Promise<EventOfInterest> {
  return invoke("update_event_of_interest", { event });
}

export async function deleteEventOfInterest(id: string): Promise<void> {
  return invoke("delete_event_of_interest", { id });
}

// --- Simulation scenario commands ---
//
// Every one of these rejects with "Storage not available" when DuckDB init
// failed or the connection was released; callers surface that as a disabled
// scenario UI rather than an error.

export async function listScenarios(): Promise<Scenario[]> {
  return invoke("list_scenarios");
}

export async function getScenario(id: string): Promise<ScenarioWithTracks> {
  return invoke("get_scenario", { id });
}

export async function createScenario(
  scenario: CreateScenario
): Promise<Scenario> {
  return invoke("create_scenario", { scenario });
}

export async function updateScenario(
  scenario: UpdateScenario
): Promise<Scenario> {
  return invoke("update_scenario", { scenario });
}

export async function deleteScenario(id: string): Promise<void> {
  return invoke("delete_scenario", { id });
}

export async function createScenarioTrack(
  track: CreateScenarioTrack
): Promise<ScenarioTrack> {
  return invoke("create_scenario_track", { track });
}

export async function updateScenarioTrack(
  track: UpdateScenarioTrack
): Promise<ScenarioTrack> {
  return invoke("update_scenario_track", { track });
}

export async function deleteScenarioTrack(id: string): Promise<void> {
  return invoke("delete_scenario_track", { id });
}

export async function reorderScenarioTracks(
  scenarioId: string,
  trackIds: string[]
): Promise<void> {
  // Tauri converts snake_case command args from camelCase automatically.
  return invoke("reorder_scenario_tracks", { scenarioId, trackIds });
}
