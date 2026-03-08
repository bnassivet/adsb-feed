//! Tauri commands for the ADS-B desktop app.
//!
//! These commands are invoked from the Next.js frontend via `invoke()`.

use crate::bridge;
use crate::state::{AppState, ConnectionStatus, StatusResponse};
use adsb_data_engine::{
    AircraftSummary, BboxQuery, DetectionRangeQuery, DetectionRangeSector, HourlyHeatmapCell,
    HourlyHeatmapQuery, PositionRecord, RawMessageQuery, RawSbsRecord, StorageStats,
    TimeDistributionBucket, TimeDistributionQuery, TrajectoryQuery,
};
use adsb_pulsar_client::{Config, MetricsSnapshot};
use tauri::{Emitter, State};

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

    let feed_handle = bridge::start_feed(app, config, state.storage.clone())?;

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

/// Saves a new configuration. Cannot be changed while running.
/// Persists to the Tauri store for restoration on next launch.
#[tauri::command]
pub fn save_config(
    app: tauri::AppHandle,
    config: Config,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Prevent config changes while running
    {
        let handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
        if handle.is_some() {
            return Err(
                "Cannot change config while feed is running. Stop the feed first.".to_string(),
            );
        }
    }

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
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage.query_bbox(query).await.map_err(|e| e.to_string())
}

/// Get trajectory for a single aircraft.
#[tauri::command]
pub async fn get_trajectory(
    query: TrajectoryQuery,
    state: State<'_, AppState>,
) -> Result<Vec<PositionRecord>, String> {
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_trajectory(query)
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
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_aircraft_summary(start_ms, end_ms)
        .await
        .map_err(|e| e.to_string())
}

/// Get time distribution histogram for a time range.
#[tauri::command]
pub async fn get_time_distribution(
    query: TimeDistributionQuery,
    state: State<'_, AppState>,
) -> Result<Vec<TimeDistributionBucket>, String> {
    let storage = state
        .storage
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
    let storage = state
        .storage
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
    let storage = state
        .storage
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
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .get_hourly_heatmap(query)
        .await
        .map_err(|e| e.to_string())
}

/// Query raw SBS messages by hex_ident and time range.
#[tauri::command]
pub async fn get_raw_messages(
    query: RawMessageQuery,
    state: State<'_, AppState>,
) -> Result<Vec<RawSbsRecord>, String> {
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .query_raw_messages(query)
        .await
        .map_err(|e| e.to_string())
}
