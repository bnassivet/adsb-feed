//! Tauri commands for the ADS-B desktop app.
//!
//! These commands are invoked from the Next.js frontend via `invoke()`.

use crate::bridge;
use crate::state::{
    AppState, ConnectionStatus, RecordingState, StatusResponse, StorageAvailability,
};
use adsb_data_engine::{
    AircraftSummary, BboxQuery, CreateEventOfInterest, DetectionRangeQuery, DetectionRangeSector,
    EventOfInterest, EventOfInterestQuery, FlightSummary, FlightSummaryQuery, HourlyHeatmapCell,
    HourlyHeatmapQuery, ImportPreview, ImportResult, PositionRecord, RawMessageQuery, RawSbsRecord,
    StatusEvent, StatusEventQuery, StatusEventStatus, StatusEventType, StorageHandle, StorageStats,
    TimeDistributionBucket, TimeDistributionQuery, TrajectoryQuery, UpdateEventOfInterest,
};
use adsb_pulsar_client::{Config, MetricsSnapshot};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Emitter, State};
use tracing::info;

/// Starts the ADS-B feed client with the current configuration.
#[tauri::command]
pub async fn start_feed(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Check if already running. If a handle exists but all its tasks have already
    // finished (e.g. the client crashed with a fatal error), treat it as a stale
    // handle and clean it up so the feed can be restarted.
    {
        let handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
        if let Some(ref h) = *handle {
            let all_done = h.task_handles.iter().all(|t| t.is_finished());
            if !all_done {
                return Err("Feed is already running".to_string());
            }
            // else: stale handle — fall through to clean it up below
        }
    }
    // Remove stale handle (no-op if None)
    {
        let mut handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
        handle.take();
    }

    let config = { state.config.lock().map_err(|e| e.to_string())?.clone() };

    let recorder = bridge::StatusEventRecorder::new(Arc::clone(&state.storage));
    let feed_handle = bridge::start_feed(
        app,
        config,
        Arc::clone(&state.storage),
        state.record_positions.clone(),
        state.record_raw.clone(),
        recorder,
    )?;

    // Record feed started event (non-fatal)
    {
        let guard = state.storage.read().await;
        if let Some(ref s) = *guard {
            let _ = s
                .insert_status_event(StatusEvent::now(
                    StatusEventType::Feed,
                    StatusEventStatus::Started,
                ))
                .await;
        }
    }

    // Update status
    {
        let mut status = state.connection_status.lock().map_err(|e| e.to_string())?;
        status.is_running = true;
        status.socket_status = ConnectionStatus::Connecting;
        if state.config.lock().map_err(|e| e.to_string())?.test_mode {
            status.pulsar_status = ConnectionStatus::Disconnected;
        } else {
            status.pulsar_status = ConnectionStatus::Connecting;
        }
    }

    // Store the handle
    {
        let mut handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
        *handle = Some(feed_handle);
    }

    Ok(())
}

/// Stops the running ADS-B feed client.
#[tauri::command]
pub async fn stop_feed(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let feed_handle = {
        let mut handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
        handle.take()
    };

    if let Some(handle) = feed_handle {
        // Signal the client to shut down gracefully
        (handle.shutdown_fn)();

        // Abort all background tasks immediately. This is safe because stop_feed
        // emits the final status event itself (below), so we don't need to wait
        // for client_task to emit it. The alive signal in bridge.rs would also
        // cascade to watchdog/metrics, but abort() gives immediate cleanup.
        for task in handle.task_handles {
            task.abort();
        }
    }

    // Build the final "stopped" status
    let status = StatusResponse {
        is_running: false,
        socket_status: ConnectionStatus::Disconnected,
        pulsar_status: ConnectionStatus::Disconnected,
    };

    // Update in-memory state
    {
        let mut connection_status = state.connection_status.lock().map_err(|e| e.to_string())?;
        *connection_status = status.clone();
    }

    // Emit event directly so the frontend updates immediately, even though
    // the aborted client_task never reached its own adsb:status emission.
    let _ = app.emit("adsb:status", &status);

    // Record feed stopped event (non-fatal)
    {
        let guard = state.storage.read().await;
        if let Some(ref s) = *guard {
            let _ = s
                .insert_status_event(StatusEvent::now(
                    StatusEventType::Feed,
                    StatusEventStatus::Stopped,
                ))
                .await;
        }
    }

    Ok(())
}

/// Returns the current connection status.
#[tauri::command]
pub fn get_status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    let status = state.connection_status.lock().map_err(|e| e.to_string())?;
    Ok(status.clone())
}

/// Returns the current metrics snapshot.
#[tauri::command]
pub fn get_metrics(state: State<'_, AppState>) -> Result<MetricsSnapshot, String> {
    let handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
    match handle.as_ref() {
        Some(h) => Ok(h.metrics.snapshot()),
        None => Ok(adsb_pulsar_client::Metrics::new().snapshot()),
    }
}

/// Returns the current configuration.
#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<Config, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

/// Saves a new configuration.
/// Persists to the Tauri store for restoration on next launch.
/// Safe to call while the feed is running — `start_feed` clones the config
/// at startup, so changes take effect on the next restart.
#[tauri::command]
pub fn save_config(
    app: tauri::AppHandle,
    config: Config,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Validate
    config.validate().map_err(|e| e.to_string())?;

    // Persist to disk
    crate::persist_config(&app, &config)?;

    // Update in-memory state
    let mut current = state.config.lock().map_err(|e| e.to_string())?;
    *current = config;

    Ok(())
}

/// Validates configuration without saving.
#[tauri::command]
pub fn validate_config(config: Config) -> Result<(), String> {
    config.validate().map_err(|e| e.to_string())
}

// --- Historical query commands ---

/// Query positions within a bounding box and optional time window.
#[tauri::command]
pub async fn query_bbox(
    query: BboxQuery,
    state: State<'_, AppState>,
) -> Result<Vec<PositionRecord>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage.query_bbox(query).await.map_err(|e| e.to_string())
}

/// Query positions in a bounding box as Arrow IPC bytes.
#[tauri::command]
pub async fn query_bbox_arrow(
    query: BboxQuery,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .query_bbox_arrow(query)
        .await
        .map_err(|e| e.to_string())
}

/// Get trajectory for a single aircraft.
#[tauri::command]
pub async fn get_trajectory(
    query: TrajectoryQuery,
    state: State<'_, AppState>,
) -> Result<Vec<PositionRecord>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_trajectory(query)
        .await
        .map_err(|e| e.to_string())
}

/// Get trajectories for multiple flights in a single batch, returned as Arrow IPC.
///
/// Acquires the DuckDB Mutex once for all queries (vs N times for N separate calls),
/// and returns binary Arrow IPC instead of JSON — ~4x smaller on the wire, ~5x faster
/// to parse in the browser via `apache-arrow`'s `tableFromIPC()`.
///
/// Each query is paired with a `flight_id` string so the frontend can partition rows.
/// Tauri serializes `Vec<u8>` as a JSON array of numbers over IPC.
#[tauri::command]
pub async fn get_trajectories_batch_arrow(
    queries: Vec<(TrajectoryQuery, String)>,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_trajectories_batch_arrow(queries)
        .await
        .map_err(|e| e.to_string())
}

/// Get summary of distinct aircraft in a time window.
#[tauri::command]
pub async fn get_aircraft_summary(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<AircraftSummary>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_aircraft_summary(start_ms, end_ms)
        .await
        .map_err(|e| e.to_string())
}

/// Get flight-segmented summaries for a time window.
#[tauri::command]
pub async fn get_flight_summary(
    query: FlightSummaryQuery,
    state: State<'_, AppState>,
) -> Result<Vec<FlightSummary>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_flight_summary(query)
        .await
        .map_err(|e| e.to_string())
}

/// Get flight-segmented summaries as Arrow IPC bytes.
#[tauri::command]
pub async fn get_flight_summary_arrow(
    query: FlightSummaryQuery,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_flight_summary_arrow(query)
        .await
        .map_err(|e| e.to_string())
}

/// Get time distribution histogram for a time range.
#[tauri::command]
pub async fn get_time_distribution(
    query: TimeDistributionQuery,
    state: State<'_, AppState>,
) -> Result<Vec<TimeDistributionBucket>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_time_distribution(query)
        .await
        .map_err(|e| e.to_string())
}

/// Get storage statistics (row count, time range, estimated size).
#[tauri::command]
pub async fn get_storage_stats(state: State<'_, AppState>) -> Result<StorageStats, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage.get_stats().await.map_err(|e| e.to_string())
}

/// Get detection range by 10° azimuth sectors.
#[tauri::command]
pub async fn get_detection_range(
    query: DetectionRangeQuery,
    state: State<'_, AppState>,
) -> Result<Vec<DetectionRangeSector>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_detection_range(query)
        .await
        .map_err(|e| e.to_string())
}

/// Get hourly activity heatmap grouped by (day, hour).
#[tauri::command]
pub async fn get_hourly_heatmap(
    query: HourlyHeatmapQuery,
    state: State<'_, AppState>,
) -> Result<Vec<HourlyHeatmapCell>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_hourly_heatmap(query)
        .await
        .map_err(|e| e.to_string())
}

/// Count raw messages in an optional time range.
#[tauri::command]
pub async fn get_raw_message_count(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_raw_message_count(start_ms, end_ms)
        .await
        .map_err(|e| e.to_string())
}

/// Query raw SBS messages by hex_ident and time range.
#[tauri::command]
pub async fn get_raw_messages(
    query: RawMessageQuery,
    state: State<'_, AppState>,
) -> Result<Vec<RawSbsRecord>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .query_raw_messages(query)
        .await
        .map_err(|e| e.to_string())
}

/// Get raw SBS messages as Arrow IPC bytes.
#[tauri::command]
pub async fn get_raw_messages_arrow(
    query: RawMessageQuery,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .query_raw_messages_arrow(query)
        .await
        .map_err(|e| e.to_string())
}

// --- Recording state commands ---

/// Returns the current recording state (which streams are being persisted to DuckDB).
#[tauri::command]
pub fn get_recording_state(state: State<'_, AppState>) -> Result<RecordingState, String> {
    Ok(RecordingState {
        record_positions: state.record_positions.load(Ordering::Relaxed),
        record_raw: state.record_raw.load(Ordering::Relaxed),
    })
}

/// Sets the recording state and emits an event to notify the frontend.
#[tauri::command]
pub fn set_recording_state(
    app: tauri::AppHandle,
    recording: RecordingState,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .record_positions
        .store(recording.record_positions, Ordering::Relaxed);
    state
        .record_raw
        .store(recording.record_raw, Ordering::Relaxed);
    let _ = app.emit("adsb:recording-state", &recording);
    Ok(())
}

/// Queries status events for the audit timeline.
#[tauri::command]
pub async fn get_status_timeline(
    query: StatusEventQuery,
    state: State<'_, AppState>,
) -> Result<Vec<StatusEvent>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .query_status_events(query)
        .await
        .map_err(|e| e.to_string())
}

// --- Storage management commands ---

/// Returns the current storage availability status.
#[tauri::command]
pub async fn get_storage_status(state: State<'_, AppState>) -> Result<StorageAvailability, String> {
    let guard = state.storage.read().await;
    if guard.is_some() {
        Ok(StorageAvailability::Available)
    } else if state.storage_config.is_some() {
        // Config exists but handle is None → was released
        Ok(StorageAvailability::Released)
    } else {
        Ok(StorageAvailability::Unavailable)
    }
}

/// Release the DuckDB connection so external tools can access the file.
///
/// Flushes the WAL via CHECKPOINT, then drops the connection handle.
/// Recording silently stops (batches are dropped). Queries return
/// "Storage not available" until reclaimed.
#[tauri::command]
pub async fn release_storage(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.storage.write().await;
    if let Some(ref storage) = *guard {
        // Record release event before dropping connection
        let _ = storage
            .insert_status_event(StatusEvent::now(
                StatusEventType::Storage,
                StatusEventStatus::Released,
            ))
            .await;
        storage
            .checkpoint()
            .await
            .map_err(|e| format!("Checkpoint failed: {e}"))?;
        info!("Storage released — DuckDB connection dropped");
    }
    *guard = None;

    let status = StorageAvailability::Released;
    let _ = app.emit("adsb:storage-status", &status);
    Ok(())
}

/// Reclaim the DuckDB connection after a release.
///
/// Reopens the database from the stored config. Fails if no config
/// was stored (storage was never available) or if the file can't be opened.
#[tauri::command]
pub async fn reclaim_storage(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = state
        .storage_config
        .as_ref()
        .ok_or_else(|| "No storage config available — storage was never initialized".to_string())?
        .clone();

    let handle =
        StorageHandle::open(config).map_err(|e| format!("Failed to reopen storage: {e}"))?;
    info!("Storage reclaimed — DuckDB connection reopened");

    // Record reclaim event on the fresh connection
    let _ = handle.insert_status_event(StatusEvent::now(
        StatusEventType::Storage,
        StatusEventStatus::Reclaimed,
    )).await;

    let mut guard = state.storage.write().await;
    *guard = Some(handle);

    let status = StorageAvailability::Available;
    let _ = app.emit("adsb:storage-status", &status);
    Ok(())
}

/// Swap the current database to a timestamped snapshot and start fresh.
///
/// This is a zero-loss operation: the `SharedStorage` is never `None` during
/// the swap. A fresh DB is pre-created at a staging path, then atomically
/// swapped into `SharedStorage` under a brief write-lock. The old DB is
/// checkpointed, closed, and renamed to `snapshots/adsb_history_{timestamp}.db`.
///
/// Returns the snapshot file path.
#[tauri::command]
pub async fn swap_database(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 1. Read db_path from storage_config
    let config = state
        .storage_config
        .as_ref()
        .ok_or_else(|| "No storage config — storage was never initialized".to_string())?;
    let db_path = config
        .db_path
        .as_ref()
        .ok_or_else(|| "Cannot swap an in-memory database".to_string())?
        .clone();

    let db_parent = db_path
        .parent()
        .ok_or_else(|| "Database path has no parent directory".to_string())?;

    // 2. Build snapshot and staging paths
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S%.3f");
    let snapshot_path = db_parent
        .join("snapshots")
        .join(format!("adsb_history_{timestamp}.db"));
    let staging_path = db_parent.join("adsb_history_next.db");

    // 3. Pre-create fresh DB at staging path (expensive — outside any lock)
    let staging_config = adsb_data_engine::StorageConfig {
        db_path: Some(staging_path.clone()),
        source_id: config.source_id.clone(),
        gap_threshold_ms: config.gap_threshold_ms,
    };
    let new_handle = StorageHandle::open(staging_config)
        .map_err(|e| format!("Failed to create staging database: {e}"))?;

    // 4. Atomic swap under write-lock (SharedStorage is never None)
    let old_handle = {
        let mut guard = state.storage.write().await;
        let old = guard.take();
        *guard = Some(new_handle);
        old
    };
    // relay_messages immediately writes to the new DB on its next flush

    // 5. Checkpoint and drop old handle (outside lock)
    if let Some(old) = old_handle {
        if let Err(e) = old.checkpoint().await {
            info!("Checkpoint warning during swap (non-fatal): {e}");
        }
        drop(old); // closes connection, releases file lock
    }

    // 6. Rename old DB → snapshot
    let snap = snapshot_path.clone();
    let db = db_path.clone();
    tokio::task::spawn_blocking(move || adsb_data_engine::move_database_to_snapshot(&db, &snap))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
        .map_err(|e| format!("Failed to move database to snapshot: {e}"))?;

    // 7. Rename staging → canonical path
    let staging = staging_path.clone();
    let canonical = db_path.clone();
    tokio::task::spawn_blocking(move || std::fs::rename(&staging, &canonical))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
        .map_err(|e| format!("Failed to rename staging database: {e}"))?;

    info!("Database swapped — snapshot at {}", snapshot_path.display());

    // 8. Emit status event for UI refresh
    let status = StorageAvailability::Available;
    let _ = app.emit("adsb:storage-status", &status);

    Ok(snapshot_path.to_string_lossy().into_owned())
}

/// Export the database to a user-chosen path without stopping recording.
///
/// Uses DuckDB's ATTACH + CREATE TABLE AS within the active connection,
/// so recording continues uninterrupted. The frontend provides the target
/// path from a Tauri save-file dialog.
#[tauri::command]
pub async fn export_database(
    target_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;

    let path = std::path::PathBuf::from(&target_path);
    storage
        .export_database(path)
        .await
        .map_err(|e| format!("Export failed: {e}"))?;

    Ok(())
}

/// Preview an external database file before importing.
///
/// ATTACHes the file as READ_ONLY, queries row counts and timestamp ranges
/// for each table, then DETACHes. Returns zero-count previews for missing tables.
#[tauri::command]
pub async fn preview_import_database(
    path: String,
    state: State<'_, AppState>,
) -> Result<ImportPreview, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;

    let path = std::path::PathBuf::from(&path);
    storage
        .preview_import(path)
        .await
        .map_err(|e| format!("Preview failed: {e}"))
}

/// Import records from an external database file with deduplication.
///
/// ATTACHes the file as READ_ONLY, INSERTs rows that don't already exist
/// (anti-join on natural keys), then DETACHes. Returns the count of newly
/// imported rows per table.
#[tauri::command]
pub async fn import_database(
    path: String,
    state: State<'_, AppState>,
) -> Result<ImportResult, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;

    let path = std::path::PathBuf::from(&path);
    storage
        .import_database(path)
        .await
        .map_err(|e| format!("Import failed: {e}"))
}

// --- Events of interest commands ---

#[tauri::command]
pub async fn create_event_of_interest(
    event: CreateEventOfInterest,
    state: State<'_, AppState>,
) -> Result<EventOfInterest, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .insert_event_of_interest(event)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_events_of_interest(
    query: EventOfInterestQuery,
    state: State<'_, AppState>,
) -> Result<Vec<EventOfInterest>, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .query_events_of_interest(query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_event_of_interest(
    id: String,
    state: State<'_, AppState>,
) -> Result<EventOfInterest, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_event_of_interest(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_event_of_interest(
    event: UpdateEventOfInterest,
    state: State<'_, AppState>,
) -> Result<EventOfInterest, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .update_event_of_interest(event)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_event_of_interest(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .delete_event_of_interest(id)
        .await
        .map_err(|e| e.to_string())
}
