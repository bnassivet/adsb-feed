//! Tauri commands for the ADS-B desktop app.
//!
//! These commands are invoked from the Next.js frontend via `invoke()`.

use crate::bridge;
use crate::state::{
    AppState, ConnectionStatus, RecordingState, StatusResponse, StorageAvailability,
};
use crate::storage_mode::StorageMode;
use adsb_data_engine::{
    AircraftSummary, BboxQuery, CreateEventOfInterest, CreateScenario, CreateScenarioTrack,
    DetectionRangeQuery, DetectionRangeSector, EventOfInterest, EventOfInterestQuery,
    FlightSummary, FlightSummaryQuery, HourlyHeatmapCell, HourlyHeatmapQuery, ImportPreview,
    ImportResult, MessageTypeBucket, PositionRecord, RawMessageQuery, RawSbsRecord, Scenario,
    ScenarioTrack, ScenarioWithTracks, ShareInfo, ShareStatus, StatusEvent, StatusEventQuery,
    StatusEventStatus, StatusEventType, StorageHandle, StorageStats, TimeDistributionBucket,
    TimeDistributionQuery, TrajectoryQuery, UpdateEventOfInterest, UpdateScenario,
    UpdateScenarioTrack,
};
use adsb_pulsar_client::Config;
use adsb_weather_server::WeatherSnapshot;
use adsb_weather_server::api_client::ApiClient;
use tauri_plugin_store::StoreExt;

use crate::weather::{WeatherAvailability, WeatherServiceView};

use crate::bridge::DesktopMetrics;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, State, ipc::Response};
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
        Arc::clone(&state.connection_status),
        Arc::clone(&state.weather),
        Arc::clone(&state.weather_service),
        // Cloned out of the mutex rather than held across the call: the mode is
        // a small value and start_feed does real work.
        state
            .storage_mode
            .lock()
            .map(|m| m.clone())
            .unwrap_or_default(),
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

    // Note: connection_status is now updated by the bridge tasks (client_task sets
    // Connecting on start, watchdog syncs on every status transition, client_task
    // sets Disconnected on stop). No manual update needed here.

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

/// The last good weather snapshot, for a UI that mounts after it arrived.
///
/// Snapshots are pushed as `adsb:weather` events, but a retained grid can land
/// before the map has subscribed, and is otherwise not seen again until the
/// next hourly fetch.
/// List the weather snapshots on disk, newest first, **without** payloads.
///
/// Distinct from [`get_weather_snapshot`], which answers "what is the weather
/// *now*" from the live MQTT relay. This one answers "what weather do we have
/// *recorded*" — in remote mode, from the daemon's table through the view.
///
/// Metadata only: a snapshot is ~16 KB, so listing a day of them whole would be
/// several hundred KB a caller almost never wants.
#[tauri::command]
pub async fn get_weather_history(
    query: adsb_data_engine::WeatherSnapshotQuery,
    state: State<'_, AppState>,
) -> Result<Vec<adsb_data_engine::WeatherSnapshotMeta>, String> {
    adsb_data_server::tool_service::get_weather_snapshots(&state.storage, query).await
}

/// One recorded snapshot, with its payload verbatim.
///
/// `None` for a model hour that was never recorded — absent is not an error,
/// and the caller must be able to tell it apart from unavailable storage.
///
/// Called fully qualified: a `use` of the service function would collide with
/// [`get_weather_snapshot`] above.
#[tauri::command]
pub async fn get_weather_at(
    key: adsb_data_engine::WeatherSnapshotKey,
    state: State<'_, AppState>,
) -> Result<Option<adsb_data_engine::WeatherSnapshotRecord>, String> {
    adsb_data_server::tool_service::get_weather_snapshot(&state.storage, key).await
}

#[tauri::command]
pub fn get_weather_snapshot(state: State<'_, AppState>) -> Result<Option<WeatherSnapshot>, String> {
    let held = state.weather.read().map_err(|e| e.to_string())?;
    Ok(held.clone())
}

/// Whether the weather layer can have data, and if not, why.
#[tauri::command]
pub fn get_weather_availability(state: State<'_, AppState>) -> Result<WeatherAvailability, String> {
    let source_kind = state.config.lock().map_err(|e| e.to_string())?.source_kind;
    let has_snapshot = state.weather.read().map_err(|e| e.to_string())?.is_some();
    Ok(crate::weather::availability(source_kind, has_snapshot))
}

/// What the weather service last reported over MQTT: its status, and whether
/// it is online. The query side -- the "Fetch weather" switch reads this.
#[tauri::command]
pub fn get_weather_service(state: State<'_, AppState>) -> Result<WeatherServiceView, String> {
    let view = state.weather_service.read().map_err(|e| e.to_string())?;
    Ok(view.clone())
}

/// Asks the weather service to enable or disable fetching: the command side.
///
/// Resolves once the service has accepted and persisted the setting. It
/// deliberately changes nothing the desktop shows: the service reports the
/// outcome on its status topic, and that is the only thing the UI reads.
#[tauri::command]
pub async fn set_weather_service_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let url = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        crate::weather::weather_api_url(&config)
    };
    let client = ApiClient::new(url).map_err(|e| e.to_string())?;
    client
        .set_enabled(enabled)
        .await
        .map_err(|e| e.to_string())?;
    info!("Weather service accepted enabled={enabled}");
    Ok(())
}

/// The stack this instance was launched for, or `None` for the unnamed one.
///
/// Exists because the UI cannot otherwise know: the badge used to derive the
/// stage from `source_id`, which comes from the app's own settings store -- and
/// a freshly-scoped stack starts with an empty store, so it fell back to the
/// default id and showed nothing. `ADSB_STACK` is the value `make up-desktop
/// STACK=<name>` actually sets.
#[tauri::command]
pub fn get_stack() -> Option<String> {
    crate::stack_from_env()
}

/// Where the webview keeps the map tile cache's IndexedDB database on disk.
///
/// Display only (Settings → Map Tile Cache): the page can name its database
/// but not find it. Read-only, and `path` is `None` until the first tile is
/// stored. See `webview_storage` for how the engine directories are searched.
#[tauri::command]
pub async fn locate_tile_cache(
    app: tauri::AppHandle,
    db_name: String,
) -> Result<crate::webview_storage::DatabaseLocation, String> {
    let path = app.path();
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()));
    let roots = crate::webview_storage::candidate_roots(
        &app.config().identifier,
        exe.as_deref(),
        path.home_dir().ok().as_deref(),
        path.app_data_dir().ok().as_deref(),
        path.app_local_data_dir().ok().as_deref(),
    );
    tokio::task::spawn_blocking(move || crate::webview_storage::locate(&roots, &db_name))
        .await
        .map_err(|e| e.to_string())?
}

/// Returns the current metrics snapshot, including bridge-level counters
/// (`lines_received`, `messages_parsed`, `positions_parsed`) that the TS `MetricsSnapshot` type expects to be present.
#[tauri::command]
pub fn get_metrics(state: State<'_, AppState>) -> Result<DesktopMetrics, String> {
    let handle = state.feed_handle.lock().map_err(|e| e.to_string())?;
    match handle.as_ref() {
        Some(h) => Ok(DesktopMetrics {
            base: h.metrics.snapshot(),
            lines_received: h.lines_received.load(Ordering::Relaxed),
            messages_parsed: h.messages_parsed.load(Ordering::Relaxed),
            positions_parsed: h.positions_parsed.load(Ordering::Relaxed),
        }),
        None => Ok(DesktopMetrics {
            base: adsb_pulsar_client::Metrics::new().snapshot(),
            lines_received: 0,
            messages_parsed: 0,
            positions_parsed: 0,
        }),
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
///
/// Returns raw binary via `tauri::ipc::Response` — bypasses JSON serialization
/// of `Vec<u8>` (which would encode each byte as a JSON number, ~3x size amplification).
/// The frontend receives an `ArrayBuffer` directly.
#[tauri::command]
pub async fn query_bbox_arrow(
    query: BboxQuery,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    let bytes = storage
        .query_bbox_arrow(query)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Get trajectory for a single aircraft.
#[tauri::command]
pub async fn get_trajectory(
    query: TrajectoryQuery,
    state: State<'_, AppState>,
) -> Result<Vec<PositionRecord>, String> {
    adsb_data_server::tool_service::get_trajectory(&state.storage, query).await
}

/// Get trajectories for multiple flights in a single batch, returned as Arrow IPC.
///
/// Acquires the DuckDB Mutex once for all queries (vs N times for N separate calls),
/// and returns binary Arrow IPC instead of JSON — ~4x smaller on the wire, ~5x faster
/// to parse in the browser via `apache-arrow`'s `tableFromIPC()`.
///
/// Each query is paired with a `flight_id` string so the frontend can partition rows.
/// Returns raw binary via `tauri::ipc::Response` — the frontend receives an `ArrayBuffer`.
#[tauri::command]
pub async fn get_trajectories_batch_arrow(
    queries: Vec<(TrajectoryQuery, String)>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    let bytes = storage
        .get_trajectories_batch_arrow(queries)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Fetch ALL trajectories in a single query (joins positions with flights table).
/// Much faster than per-flight batch when loading all flights.
/// Returns raw binary via `tauri::ipc::Response` — the frontend receives an `ArrayBuffer`.
#[tauri::command]
pub async fn get_all_trajectories_arrow(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    let bytes = storage
        .get_all_trajectories_arrow(start_ms, end_ms)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Get summary of distinct aircraft in a time window.
#[tauri::command]
pub async fn get_aircraft_summary(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<AircraftSummary>, String> {
    adsb_data_server::tool_service::get_aircraft_summary(&state.storage, start_ms, end_ms).await
}

/// Get flight-segmented summaries for a time window.
#[tauri::command]
pub async fn get_flight_summary(
    query: FlightSummaryQuery,
    state: State<'_, AppState>,
) -> Result<Vec<FlightSummary>, String> {
    adsb_data_server::tool_service::get_flight_summary(&state.storage, query).await
}

/// Get flight-segmented summaries as Arrow IPC bytes.
///
/// Returns raw binary via `tauri::ipc::Response` — the frontend receives an `ArrayBuffer`.
#[tauri::command]
pub async fn get_flight_summary_arrow(
    query: FlightSummaryQuery,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    let bytes = storage
        .get_flight_summary_arrow(query)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Get time distribution histogram for a time range.
#[tauri::command]
pub async fn get_time_distribution(
    query: TimeDistributionQuery,
    state: State<'_, AppState>,
) -> Result<Vec<TimeDistributionBucket>, String> {
    adsb_data_server::tool_service::get_time_distribution(&state.storage, query).await
}

/// Get raw-message counts per (time bucket, SBS-1 transmission type).
#[tauri::command]
pub async fn get_message_type_distribution(
    query: TimeDistributionQuery,
    state: State<'_, AppState>,
) -> Result<Vec<MessageTypeBucket>, String> {
    adsb_data_server::tool_service::get_message_type_distribution(&state.storage, query).await
}

/// Get storage statistics (row count, time range, estimated size).
#[tauri::command]
pub async fn get_storage_stats(state: State<'_, AppState>) -> Result<StorageStats, String> {
    adsb_data_server::tool_service::get_storage_stats(&state.storage).await
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
    adsb_data_server::tool_service::get_hourly_heatmap(&state.storage, query).await
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
///
/// Returns raw binary via `tauri::ipc::Response` — the frontend receives an `ArrayBuffer`.
#[tauri::command]
pub async fn get_raw_messages_arrow(
    query: RawMessageQuery,
    state: State<'_, AppState>,
) -> Result<Response, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    let bytes = storage
        .query_raw_messages_arrow(query)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
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
    } else if state.storage_config.lock().unwrap().is_some() {
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
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No storage config available — storage was never initialized".to_string())?;

    let handle =
        StorageHandle::open(config).map_err(|e| format!("Failed to reopen storage: {e}"))?;
    info!("Storage reclaimed — DuckDB connection reopened");

    // Record reclaim event on the fresh connection
    let _ = handle
        .insert_status_event(StatusEvent::now(
            StatusEventType::Storage,
            StatusEventStatus::Reclaimed,
        ))
        .await;

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
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No storage config — storage was never initialized".to_string())?;
    let db_path = config
        .db_path
        .clone()
        .ok_or_else(|| "Cannot swap an in-memory database".to_string())?;

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
        share: None,
        remote: None,
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
    adsb_data_server::tool_service::get_events_of_interest(&state.storage, query).await
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

// --- Simulation scenario commands ---
//
// Reads go through `adsb-data-server`'s `tool_service` so the desktop app, the
// agent tool server and the headless daemon all answer queries identically; writes
// take the lock here, mirroring the events-of-interest commands above.

#[tauri::command]
pub async fn list_scenarios(state: State<'_, AppState>) -> Result<Vec<Scenario>, String> {
    adsb_data_server::tool_service::list_scenarios(&state.storage).await
}

#[tauri::command]
pub async fn get_scenario(
    id: String,
    state: State<'_, AppState>,
) -> Result<ScenarioWithTracks, String> {
    adsb_data_server::tool_service::get_scenario(&state.storage, id).await
}

#[tauri::command]
pub async fn create_scenario(
    scenario: CreateScenario,
    state: State<'_, AppState>,
) -> Result<Scenario, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .insert_scenario(scenario)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_scenario(
    scenario: UpdateScenario,
    state: State<'_, AppState>,
) -> Result<Scenario, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .update_scenario(scenario)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_scenario(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage.delete_scenario(id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_scenario_track(
    track: CreateScenarioTrack,
    state: State<'_, AppState>,
) -> Result<ScenarioTrack, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .insert_scenario_track(track)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_scenario_track(
    track: UpdateScenarioTrack,
    state: State<'_, AppState>,
) -> Result<ScenarioTrack, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .update_scenario_track(track)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_scenario_track(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .delete_scenario_track(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_scenario_tracks(
    scenario_id: String,
    track_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;
    storage
        .reorder_scenario_tracks(scenario_id, track_ids)
        .await
        .map_err(|e| e.to_string())
}

/// Expose the DuckDB database over the Quack protocol.
///
/// Returns the coordinates an external DuckDB client needs to `ATTACH`.
/// **The token grants full read and write access to every table** — the
/// server runs with Quack's default permissive authorization — so treat it
/// as a credential.
///
/// Idempotent: calling this while already sharing returns the running
/// server's details rather than starting a second one.
#[tauri::command]
pub async fn start_sharing(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ShareInfo, String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;

    let info = storage.start_sharing().await.map_err(|e| e.to_string())?;
    info!("Database shared over Quack at {}", info.listen_uri);

    let status = ShareStatus::Active(info.clone());
    let _ = app.emit("adsb:share-status", &status);
    Ok(info)
}

/// Stop exposing the database. No-op when sharing is not active.
#[tauri::command]
pub async fn stop_sharing(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.storage.read().await;
    let storage = guard
        .as_ref()
        .ok_or_else(|| "Storage not available".to_string())?;

    storage.stop_sharing().await.map_err(|e| e.to_string())?;
    let _ = app.emit("adsb:share-status", &ShareStatus::Off);
    Ok(())
}

/// Current sharing state.
///
/// Reports `Off` when storage itself is unavailable — from the caller's point
/// of view the database is equally not shared, and this keeps the command
/// usable for rendering rather than making the UI handle a second error path.
#[tauri::command]
pub async fn sharing_status(state: State<'_, AppState>) -> Result<ShareStatus, String> {
    let guard = state.storage.read().await;
    let Some(storage) = guard.as_ref() else {
        return Ok(ShareStatus::Off);
    };
    storage.sharing_status().await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Storage mode
// ---------------------------------------------------------------------------

/// Returns the storage mode currently in effect.
#[tauri::command]
pub async fn get_storage_mode(state: State<'_, AppState>) -> Result<StorageMode, String> {
    Ok(state.storage_mode.lock().unwrap().clone())
}

/// Switches between embedded and remote storage, reopening the database.
///
/// The switch is applied immediately rather than on next launch, because the
/// two modes open *different files* and a user who flips the toggle expects the
/// history panel to change now.
///
/// On failure the previous storage is left released rather than silently
/// reopened in the old mode: mode is explicit configuration, and quietly
/// reverting would hide from the user that their daemon is unreachable.
#[tauri::command]
pub async fn set_storage_mode(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mode: StorageMode,
) -> Result<StorageAvailability, String> {
    mode.validate()?;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?;

    let share = state
        .storage_config
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|c| c.share.clone());
    let config = mode.to_storage_config(&app_data_dir, share);

    // Drop the old connection first: DuckDB takes an exclusive file lock, and
    // in embedded->embedded reopens the target could be the very file we hold.
    {
        let mut guard = state.storage.write().await;
        if let Some(old) = guard.take() {
            let _ = old.checkpoint().await;
        }
    }

    let handle = StorageHandle::open(config.clone()).map_err(|e| {
        let _ = app.emit("adsb:storage-status", &StorageAvailability::Unavailable);
        format!("Failed to open storage in {} mode: {e}", mode.label())
    })?;

    let _ = handle
        .insert_status_event(StatusEvent::now(
            StatusEventType::Storage,
            StatusEventStatus::Reclaimed,
        ))
        .await;

    *state.storage.write().await = Some(handle);
    *state.storage_config.lock().unwrap() = Some(config);
    *state.storage_mode.lock().unwrap() = mode.clone();

    persist_storage_mode(&app, &mode)?;
    info!("Storage mode changed to {}", mode.label());

    let status = StorageAvailability::Available;
    let _ = app.emit("adsb:storage-status", &status);
    Ok(status)
}

/// Persists the storage mode so it survives a restart.
fn persist_storage_mode(app: &tauri::AppHandle, mode: &StorageMode) -> Result<(), String> {
    let store = app
        .store(crate::config_store_path())
        .map_err(|e| format!("Failed to open config store: {e}"))?;
    let value =
        serde_json::to_value(mode).map_err(|e| format!("Failed to serialize storage mode: {e}"))?;
    store.set(crate::STORAGE_MODE_STORE_KEY.to_string(), value);
    store
        .save()
        .map_err(|e| format!("Failed to save config store: {e}"))
}

/// Serialises airspace loads: two at once (StrictMode mounts twice) would both
/// download and race to write the same cycle file.
static AIRSPACE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// OpenAIP airspaces for `ADSB_OPENAIP_COUNTRIES`, cached per AIRAC cycle in
/// `<stack data dir>/airspaces/`. Never fails as a whole: each country carries
/// its own origin and error, so one missing key or one outage is reported in
/// the panel while any cached cycle is still drawn (marked expired).
#[tauri::command]
pub async fn get_airspaces(
    app: tauri::AppHandle,
) -> Result<Vec<crate::airspace::CountryAirspaces>, String> {
    use crate::airspace;
    let _guard = AIRSPACE_LOCK.lock().await;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?;
    let dir =
        crate::stack_data_dir(&app_data_dir, crate::stack_from_env().as_deref()).join("airspaces");
    let key = std::env::var(airspace::KEY_ENV)
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    let countries =
        airspace::parse_countries(std::env::var(airspace::COUNTRIES_ENV).ok().as_deref());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let today = chrono::Utc::now().date_naive();

    let mut out = Vec::with_capacity(countries.len());
    for country in &countries {
        let fetch = |page: u32| {
            let (client, key) = (&client, key.as_deref());
            async move {
                match key {
                    Some(k) => airspace::fetch_page(client, k, country, page).await,
                    None => Err(airspace::NO_KEY_ERROR.to_string()),
                }
            }
        };
        out.push(airspace::load_country(&dir, country, today, fetch).await);
    }
    Ok(out)
}

/// Last METAR download, in memory only (see metar.rs). Also serialises loads.
static METAR_CACHE: tokio::sync::Mutex<Option<crate::metar::MetarCache>> =
    tokio::sync::Mutex::const_new(None);

/// Latest METAR per station within `radius_nm` of a point (the receiver),
/// from AviationWeather.gov. Never fails as a whole: a failed refresh serves
/// the last snapshot with its age and the error.
#[tauri::command]
pub async fn get_metars(
    lat: f64,
    lng: f64,
    radius_nm: f64,
    force: bool,
) -> Result<crate::metar::MetarSnapshot, String> {
    use crate::metar;
    if !(lat.is_finite()
        && lng.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lng))
    {
        return Err(format!("Invalid position {lat}, {lng}"));
    }
    let radius_nm = if radius_nm.is_finite() {
        radius_nm.clamp(10.0, 600.0)
    } else {
        300.0
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let mut cache = METAR_CACHE.lock().await;
    let bbox = metar::bbox_around(lat, lng, radius_nm);
    Ok(metar::load_metars(
        &mut cache,
        chrono::Utc::now(),
        bbox,
        force,
        |b| async move { metar::fetch(&client, b).await },
    )
    .await)
}

/// Last radar mosaic, in memory only (see radar.rs). Also serialises loads.
static RADAR_CACHE: tokio::sync::Mutex<Option<crate::radar::RadarCache>> =
    tokio::sync::Mutex::const_new(None);
/// Rendered images (base64 PNG) by image time, for the current box: the latest
/// image and the animation frames share it, so nothing is rendered twice.
static RADAR_IMAGES: std::sync::Mutex<crate::radar_history::RenderCache<std::sync::Arc<String>>> =
    std::sync::Mutex::new(crate::radar_history::RenderCache::new());
/// One frames request renders at a time: a second would redo the same work.
static RADAR_FRAMES_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The box the radar is cut to, after checking the arguments.
fn radar_area(lat: f64, lng: f64, radius_nm: f64) -> Result<crate::metar::Bbox, String> {
    if !(lat.is_finite()
        && lng.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lng))
    {
        return Err(format!("Invalid position {lat}, {lng}"));
    }
    let radius_nm = if radius_nm.is_finite() {
        radius_nm.clamp(10.0, 600.0)
    } else {
        300.0
    };
    Ok(crate::metar::bbox_around(lat, lng, radius_nm))
}

/// Where the last hour of mosaics is kept (radar_history.rs).
fn radar_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    Some(crate::stack_data_dir(&app_data_dir, crate::stack_from_env().as_deref()).join("radar"))
}

/// Colour, reproject and encode one mosaic for the box: blocking CPU work.
fn radar_image(
    field: &crate::radar_grid::RainField,
    b: crate::metar::Bbox,
) -> Result<String, String> {
    use crate::{radar, radar_grid};
    use base64::Engine;
    let rgba = radar_grid::render(
        field,
        (b.min_lat, b.min_lon, b.max_lat, b.max_lon),
        radar::IMAGE_PX,
        radar::IMAGE_PX,
    );
    let png = radar_grid::encode_png(&rgba, radar::IMAGE_PX, radar::IMAGE_PX)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

/// Decodes and renders saved mosaics on a few threads (each decoded field is
/// 24 MB, so not all at once). A frame that fails is left out, with a warning.
fn radar_images_from_files(
    files: Vec<(chrono::DateTime<chrono::Utc>, std::path::PathBuf)>,
    b: crate::metar::Bbox,
) -> Vec<(chrono::DateTime<chrono::Utc>, String)> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let workers = std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .min(4);
    let next = AtomicUsize::new(0);
    let out = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| {
                while let Some((v, path)) = files.get(next.fetch_add(1, Ordering::Relaxed)) {
                    let image = std::fs::read(path)
                        .map_err(|e| e.to_string())
                        .and_then(crate::radar_grid::decode_odim)
                        .and_then(|field| radar_image(&field, b));
                    match image {
                        Ok(p) => out.lock().unwrap().push((*v, p)),
                        Err(e) => tracing::warn!("radar frame {}: {e}", path.display()),
                    }
                }
            });
        }
    });
    out.into_inner().unwrap()
}

/// Météo-France rain radar around a point (the receiver): the latest 5-minute
/// rainfall mosaic, coloured by rate and reprojected to Web Mercator. Never
/// fails as a whole: a failed refresh serves the last image with the error.
/// Each new mosaic is also kept on disk for the animation.
#[tauri::command]
pub async fn get_radar(
    app: tauri::AppHandle,
    lat: f64,
    lng: f64,
    radius_nm: f64,
    force: bool,
) -> Result<crate::radar::RadarSnapshot, String> {
    use crate::{radar, radar_grid, radar_history};
    let b = radar_area(lat, lng, radius_nm)?;
    let key = std::env::var(radar::KEY_ENV).ok();
    let now = chrono::Utc::now();
    let problem = radar::key_problem(key.as_deref(), now);
    let key = key.unwrap_or_default().trim().to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let history_dir = radar_dir(&app);
    // Turning the radar on after a while deletes the old session's frames.
    if let Some(dir) = history_dir.clone() {
        let _ = tokio::task::spawn_blocking(move || radar_history::prune(&dir, now)).await;
    }

    let load = {
        let mut cache = RADAR_CACHE.lock().await;
        let (client, key) = (&client, key.as_str());
        let describe = || async move {
            if let Some(p) = problem {
                return Err(p);
            }
            radar::parse_validity(&radar::get(client, key, &radar::description_url()).await?)
        };
        let download = || async move { radar::get(client, key, &radar::product_url()).await };
        // Decoding ~2.6 MB of gzip-chunked HDF5 is CPU work: off the async runtime.
        // Only a mosaic that decodes is kept for the animation.
        let decode = |validity, bytes: Vec<u8>| {
            tokio::task::block_in_place(|| {
                let field = radar_grid::decode_odim(bytes.clone())?;
                if let Some(dir) = &history_dir
                    && let Err(e) = radar_history::save(dir, validity, &bytes)
                {
                    tracing::warn!("{e}");
                }
                Ok(field)
            })
        };
        radar::load_radar(&mut cache, now, force, describe, download, decode).await
    };

    let bounds = [b.min_lat, b.min_lon, b.max_lat, b.max_lon];
    let png_base64 = match (&load.field, load.validity) {
        (Some(field), Some(validity)) => {
            let cached = RADAR_IMAGES.lock().unwrap().get(b, validity);
            match cached {
                Some(p) => Some(p),
                None => {
                    let field = field.clone();
                    let p = tokio::task::spawn_blocking(move || radar_image(&field, b))
                        .await
                        .map_err(|e| format!("radar render: {e}"))??;
                    let p = std::sync::Arc::new(p);
                    RADAR_IMAGES.lock().unwrap().insert(b, validity, p.clone());
                    Some(p)
                }
            }
        }
        _ => None,
    };
    Ok(radar::RadarSnapshot {
        png_base64: png_base64.map(|p| (*p).clone()),
        bounds: load.field.as_ref().map(|_| bounds),
        valid_time_ms: load.validity.map(|v| v.timestamp_millis()),
        accumulation_minutes: load.field.as_ref().map(|f| f.accumulation_minutes()),
        origin: load.origin,
        error: load.error,
        scale: radar::legend(),
    })
}

/// The last hour of radar images kept by `get_radar`, oldest first, for the
/// animation. Downloads nothing. `known_ms` lists the frames the webview
/// already holds: those come back without their image.
#[tauri::command]
pub async fn get_radar_frames(
    app: tauri::AppHandle,
    lat: f64,
    lng: f64,
    radius_nm: f64,
    known_ms: Vec<i64>,
) -> Result<crate::radar_history::RadarFrames, String> {
    use crate::radar_history::{self, RadarFrame, RadarFrames};
    let b = radar_area(lat, lng, radius_nm)?;
    let dir = radar_dir(&app).ok_or("No app data directory for the radar history")?;
    let _guard = RADAR_FRAMES_LOCK.lock().await;
    let now = chrono::Utc::now();
    let files = tokio::task::spawn_blocking(move || radar_history::frames(&dir, now))
        .await
        .map_err(|e| format!("radar history: {e}"))?;
    let wanted: Vec<_> = files.iter().map(|(v, _)| *v).collect();
    let missing = {
        let mut images = RADAR_IMAGES.lock().unwrap();
        if let Some(oldest) = wanted.first() {
            images.forget_before(*oldest);
        }
        images.missing(b, &wanted)
    };
    if !missing.is_empty() {
        let todo: Vec<_> = files
            .into_iter()
            .filter(|(v, _)| missing.contains(v))
            .collect();
        let rendered = tokio::task::spawn_blocking(move || radar_images_from_files(todo, b))
            .await
            .map_err(|e| format!("radar render: {e}"))?;
        let mut images = RADAR_IMAGES.lock().unwrap();
        for (v, p) in rendered {
            images.insert(b, v, std::sync::Arc::new(p));
        }
    }
    let mut images = RADAR_IMAGES.lock().unwrap();
    let frames = wanted
        .into_iter()
        .filter_map(|v| {
            let image = images.get(b, v)?;
            let ms = v.timestamp_millis();
            Some(RadarFrame {
                valid_time_ms: ms,
                png_base64: (!known_ms.contains(&ms)).then(|| (*image).clone()),
            })
        })
        .collect();
    Ok(RadarFrames {
        bounds: [b.min_lat, b.min_lon, b.max_lat, b.max_lon],
        frames,
    })
}
