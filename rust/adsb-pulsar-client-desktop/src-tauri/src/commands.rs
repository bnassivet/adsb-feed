//! Tauri commands for the ADS-B desktop app.
//!
//! These commands are invoked from the Next.js frontend via `invoke()`.

use crate::bridge;
use crate::state::{AppState, ConnectionStatus, StatusResponse};
use adsb_data_engine::{AircraftSummary, BboxQuery, PositionRecord, StorageStats, TrajectoryQuery};
use adsb_pulsar_client::{Config, MetricsSnapshot};
use tauri::State;

/// Starts the ADS-B feed client with the current configuration.
#[tauri::command]
pub async fn start_feed(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Check if already running
    {
        let handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
        if handle.is_some() {
            return Err("Feed is already running".to_string());
        }
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
pub async fn stop_feed(state: State<'_, AppState>) -> Result<(), String> {
    let feed_handle = {
        let mut handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
        handle.take()
    };

    if let Some(handle) = feed_handle {
        // Call shutdown
        (handle.shutdown_fn)();

        // Wait for tasks to complete (with timeout)
        for task in handle.task_handles {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), task).await;
        }
    }

    // Update status
    {
        let mut status = state.connection_status.lock().map_err(|e| e.to_string())?;
        *status = StatusResponse {
            is_running: false,
            socket_status: ConnectionStatus::Disconnected,
            pulsar_status: ConnectionStatus::Disconnected,
        };
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

/// Saves a new configuration. Cannot be changed while running.
#[tauri::command]
pub fn save_config(config: Config, state: State<'_, AppState>) -> Result<(), String> {
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

    // Store
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

/// Get storage statistics (row count, time range, estimated size).
#[tauri::command]
pub async fn get_storage_stats(state: State<'_, AppState>) -> Result<StorageStats, String> {
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage.get_stats().await.map_err(|e| e.to_string())
}
