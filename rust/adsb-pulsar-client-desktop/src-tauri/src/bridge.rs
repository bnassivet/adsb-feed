//! Bridge between the adsb-pulsar-client library and Tauri.
//!
//! Spawns the feed client as a background task and relays messages
//! to the frontend via Tauri events, with throttling to prevent
//! overwhelming the webview.

use crate::state::{
    ConnectionStatus, FeedHandle, SharedConnectionStatus, SharedStorage, StatusResponse,
};
use adsb_data_engine::{
    AircraftPosition, RawSbsRecord, StatusEvent, StatusEventStatus, StatusEventType,
    extract_sbs_timestamp, parse_sbs_message, parse_sbs_raw_fields,
};
use adsb_pulsar_client::forwarder::NoopForwarder;
use adsb_pulsar_client::{ADSBFeedClient, Config, Metrics};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::sync::{RwLock, broadcast};
use tokio::time::{Duration, Instant, interval};
use tracing::{error, info, warn};

/// Records status lifecycle events to DuckDB.
///
/// Non-fatal: failures are logged, never propagated. Wraps `SharedStorage`
/// so it gracefully handles released/unavailable storage.
#[derive(Clone)]
pub(crate) struct StatusEventRecorder {
    storage: SharedStorage,
}

impl StatusEventRecorder {
    pub fn new(storage: SharedStorage) -> Self {
        Self { storage }
    }

    /// Record a status event. Non-blocking, non-fatal.
    pub async fn record(&self, event: StatusEvent) {
        let guard = self.storage.read().await;
        if let Some(ref s) = *guard
            && let Err(e) = s.insert_status_event(event).await
        {
            warn!("Status event record failed: {e}");
        }
    }
}

/// Starts the feed client and background relay tasks.
///
/// Returns a `FeedHandle` that can be used to stop the feed
/// and read metrics.
pub fn start_feed(
    app: AppHandle,
    config: Config,
    storage: SharedStorage,
    record_positions: Arc<AtomicBool>,
    record_raw: Arc<AtomicBool>,
    recorder: StatusEventRecorder,
    connection_status: SharedConnectionStatus,
) -> Result<FeedHandle, String> {
    let test_mode = config.test_mode;
    let socket_read_timeout_secs = config.socket_read_timeout_secs;
    let dump1090_tz = config.dump1090_tz.clone();
    let mut client =
        ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).map_err(|e| e.to_string())?;

    // Attach message tap (buffer 4096 messages)
    let message_rx = client.with_message_tap(4096);

    // Get metrics handle before moving client
    let metrics = client.metrics();
    let metrics_for_relay = metrics.clone();

    // Shared counter for total raw SBS-1 messages parsed (pre-throttle)
    let messages_parsed = Arc::new(AtomicU64::new(0));
    let messages_parsed_for_relay = messages_parsed.clone();
    let messages_parsed_for_metrics = messages_parsed.clone();
    let messages_parsed_for_handle = messages_parsed.clone();

    // Shared state for last message time (for socket watchdog)
    let last_message_time = Arc::new(RwLock::new(Instant::now()));
    let last_message_time_watchdog = last_message_time.clone();

    // Use a oneshot channel to signal shutdown from outside the task
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let stop_tx = Arc::new(tokio::sync::Mutex::new(Some(stop_tx)));

    // Alive signal: when client_task exits (for any reason), alive_tx is dropped.
    // Background tasks (metrics, watchdog) receive watch::RecvError on their next
    // changed() call and break their loops — no zombie tasks emitting stale status.
    let (alive_tx, alive_rx_metrics) = tokio::sync::watch::channel(true);
    let alive_rx_watchdog = alive_tx.subscribe();

    let app_for_client = app.clone();
    let app_for_messages = app.clone();
    let app_for_metrics = app.clone();
    let app_for_watchdog = app.clone();

    let recorder_client = recorder.clone();
    let recorder_watchdog = recorder;

    let connection_status_client = connection_status.clone();
    let connection_status_watchdog = connection_status;

    // Task 1: Run the feed client
    let client_task = tokio::spawn(async move {
        // alive_tx is moved here: dropping this task drops alive_tx,
        // which signals metrics_task and watchdog_task to stop.
        let _alive_tx = alive_tx;

        // Emit connecting status
        let connecting_status = StatusResponse {
            is_running: true,
            socket_status: ConnectionStatus::Connecting,
            pulsar_status: if test_mode {
                ConnectionStatus::Disconnected
            } else {
                ConnectionStatus::Connecting
            },
        };
        if let Ok(mut guard) = connection_status_client.lock() {
            *guard = connecting_status.clone();
        }
        let _ = app_for_client.emit("adsb:status", connecting_status);
        recorder_client
            .record(StatusEvent::now(
                StatusEventType::Feed,
                StatusEventStatus::Connecting,
            ))
            .await;

        // Run client with shutdown signal
        tokio::select! {
            result = client.run() => {
                match result {
                    Ok(()) => {
                        info!("Feed client stopped normally");
                        recorder_client
                            .record(StatusEvent::now(
                                StatusEventType::Feed,
                                StatusEventStatus::Stopped,
                            ))
                            .await;
                    }
                    Err(e) => {
                        error!("Feed client error: {}", e);
                        recorder_client
                            .record(
                                StatusEvent::now(
                                    StatusEventType::Feed,
                                    StatusEventStatus::Error,
                                )
                                .with_detail(e.to_string()),
                            )
                            .await;
                        let _ = app_for_client.emit("adsb:error", serde_json::json!({
                            "message": e.to_string()
                        }));
                    }
                }
            }
            _ = &mut stop_rx => {
                info!("Feed client received stop signal");
                client.shutdown();
                // Give the client a moment to clean up
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }

        let _ = app_for_client.emit("adsb:stopped", serde_json::json!({}));
        let stopped_status = StatusResponse {
            is_running: false,
            socket_status: ConnectionStatus::Disconnected,
            pulsar_status: ConnectionStatus::Disconnected,
        };
        if let Ok(mut guard) = connection_status_client.lock() {
            *guard = stopped_status.clone();
        }
        let _ = app_for_client.emit("adsb:status", stopped_status);
        recorder_client
            .record(StatusEvent::now(
                StatusEventType::Socket,
                StatusEventStatus::Disconnected,
            ))
            .await;
        // _alive_tx is dropped here, signaling background tasks to exit
    });

    // Task 2: Relay messages to frontend (throttled) + persist to DuckDB
    let message_task = tokio::spawn(async move {
        relay_messages(
            app_for_messages,
            message_rx,
            last_message_time,
            storage,
            dump1090_tz,
            messages_parsed_for_relay,
            record_positions,
            record_raw,
        )
        .await;
    });

    // Task 3: Relay metrics to frontend
    let metrics_task = tokio::spawn(async move {
        relay_metrics(
            app_for_metrics,
            metrics_for_relay,
            messages_parsed_for_metrics,
            alive_rx_metrics,
        )
        .await;
    });

    // Task 4: Socket watchdog - monitor message activity and emit periodic status
    let watchdog_task = tokio::spawn(async move {
        socket_watchdog(
            app_for_watchdog,
            last_message_time_watchdog,
            test_mode,
            connection_status_watchdog,
            socket_read_timeout_secs,
            alive_rx_watchdog,
            recorder_watchdog,
        )
        .await;
    });

    let shutdown_fn = Box::new(move || {
        let stop_tx = stop_tx.clone();
        tokio::spawn(async move {
            if let Some(tx) = stop_tx.lock().await.take() {
                let _ = tx.send(());
            }
        });
    });

    Ok(FeedHandle {
        metrics,
        messages_parsed: messages_parsed_for_handle,
        shutdown_fn,
        task_handles: vec![client_task, message_task, metrics_task, watchdog_task],
    })
}

/// Relays parsed SBS messages to the frontend, throttled to ~2 updates/sec.
///
/// Buffers messages into a HashMap keyed by hex_ident (keeping latest position
/// per aircraft), then flushes the batch every 500ms. If a `StorageHandle` is
/// provided, positions are also persisted to DuckDB on each flush (non-fatal on failure).
#[allow(clippy::too_many_arguments)]
async fn relay_messages(
    app: AppHandle,
    mut rx: broadcast::Receiver<Vec<u8>>,
    last_message_time: Arc<RwLock<Instant>>,
    storage: SharedStorage,
    dump1090_tz: String,
    messages_parsed: Arc<AtomicU64>,
    record_positions: Arc<AtomicBool>,
    record_raw: Arc<AtomicBool>,
) {
    let mut flush_interval = interval(Duration::from_millis(500));
    let mut buffer: HashMap<String, AircraftPosition> = HashMap::new();
    let mut message_counts: HashMap<String, u64> = HashMap::new();
    let mut raw_buffer: Vec<RawSbsRecord> = Vec::new();

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(data) => {
                        // Update last message time
                        *last_message_time.write().await = Instant::now();

                        if let Ok(line) = String::from_utf8(data) {
                            // Collect raw message for audit/replay
                            if let Some((hex, msg_type, trans_type)) = parse_sbs_raw_fields(&line)
                                && let Some(ts) = extract_sbs_timestamp(&line) {
                                    raw_buffer.push(RawSbsRecord {
                                        hex_ident: hex,
                                        msg_type,
                                        transmission_type: trans_type,
                                        timestamp: ts,
                                        timestamp_ms: 0,
                                        raw_message: line.clone(),
                                        source_id: String::new(),
                                    });
                                }

                            if let Some(pos) = parse_sbs_message(&line) {
                                messages_parsed.fetch_add(1, Ordering::Relaxed);
                                *message_counts.entry(pos.hex_ident.clone()).or_insert(0) += 1;
                                merge_into_buffer(&mut buffer, pos);
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("Message relay lagged, skipped {} messages", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        if !buffer.is_empty() {
                            let mut batch: Vec<AircraftPosition> = buffer.drain().map(|(_, v)| v).collect();
                            for pos in &mut batch {
                                if let Some(count) = message_counts.remove(&pos.hex_ident) {
                                    pos.message_count = count;
                                }
                            }
                            if record_positions.load(Ordering::Relaxed) {
                                persist_batch(&storage, &batch, &dump1090_tz).await;
                            }
                            let _ = app.emit("adsb:message", &batch);
                        }
                        if record_raw.load(Ordering::Relaxed) {
                            persist_raw_batch(&storage, &raw_buffer, &dump1090_tz).await;
                        }
                        raw_buffer.clear();
                        break;
                    }
                }
            }
            _ = flush_interval.tick() => {
                if !buffer.is_empty() {
                    let mut batch: Vec<AircraftPosition> = buffer.drain().map(|(_, v)| v).collect();
                    for pos in &mut batch {
                        if let Some(count) = message_counts.remove(&pos.hex_ident) {
                            pos.message_count = count;
                        }
                    }
                    if record_positions.load(Ordering::Relaxed) {
                        persist_batch(&storage, &batch, &dump1090_tz).await;
                    }
                    let _ = app.emit("adsb:message", &batch);
                }
                if record_raw.load(Ordering::Relaxed) {
                    persist_raw_batch(&storage, &raw_buffer, &dump1090_tz).await;
                }
                raw_buffer.clear();
            }
        }
    }
}

/// Merge a new SBS position into the buffer, preserving non-null fields from the
/// existing entry.  SBS-1 splits aircraft data across multiple message subtypes
/// (MSG1=callsign, MSG3=position, MSG4=speed, etc.).  A blind `insert` would
/// overwrite a MSG3's lat/lon with nulls if a MSG1 arrives afterward in the same
/// 500ms window. This merge keeps the best-known state per aircraft.
fn merge_into_buffer(buffer: &mut HashMap<String, AircraftPosition>, new: AircraftPosition) {
    match buffer.get_mut(&new.hex_ident) {
        Some(existing) => {
            existing.callsign = new.callsign.or(existing.callsign.take());
            existing.altitude = new.altitude.or(existing.altitude);
            existing.ground_speed = new.ground_speed.or(existing.ground_speed);
            existing.track = new.track.or(existing.track);
            existing.latitude = new.latitude.or(existing.latitude);
            existing.longitude = new.longitude.or(existing.longitude);
            existing.vertical_rate = new.vertical_rate.or(existing.vertical_rate);
            existing.squawk = new.squawk.or(existing.squawk.take());
            existing.is_on_ground = new.is_on_ground.or(existing.is_on_ground);
            existing.timestamp = new.timestamp;
        }
        None => {
            buffer.insert(new.hex_ident.clone(), new);
        }
    }
}

/// Persist a batch of positions to DuckDB (non-fatal on failure).
///
/// Takes a read-lock on the shared storage. If storage has been released
/// (set to `None`), the batch is silently dropped.
async fn persist_batch(storage: &SharedStorage, batch: &[AircraftPosition], tz: &str) {
    let guard = storage.read().await;
    if let Some(ref s) = *guard
        && let Err(e) = s.insert_batch(batch.to_vec(), tz.to_string()).await
    {
        warn!("Storage insert failed: {e}");
    }
}

/// Persist a batch of raw SBS messages to DuckDB (non-fatal on failure).
async fn persist_raw_batch(storage: &SharedStorage, batch: &[RawSbsRecord], tz: &str) {
    if batch.is_empty() {
        return;
    }
    let guard = storage.read().await;
    if let Some(ref s) = *guard
        && let Err(e) = s.insert_raw_batch(batch.to_vec(), tz.to_string()).await
    {
        warn!("Raw storage insert failed: {e}");
    }
}

/// Extended metrics snapshot with bridge-level counters.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DesktopMetrics {
    #[serde(flatten)]
    pub base: adsb_pulsar_client::MetricsSnapshot,
    /// Total raw SBS-1 messages successfully parsed into AircraftPosition (pre-throttle).
    /// Distinct from `messages_received` (in base) which counts ALL TCP lines including heartbeats.
    pub messages_parsed: u64,
}

/// Emits metrics snapshots to the frontend every second.
///
/// Exits when the client task stops (alive_rx sender dropped) or when
/// the app handle is no longer valid.
async fn relay_metrics(
    app: AppHandle,
    metrics: Metrics,
    messages_parsed: Arc<AtomicU64>,
    mut alive_rx: tokio::sync::watch::Receiver<bool>,
) {
    let mut tick = interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = tick.tick() => {
                let desktop_metrics = DesktopMetrics {
                    base: metrics.snapshot(),
                    messages_parsed: messages_parsed.load(Ordering::Relaxed),
                };
                if app.emit("adsb:metrics", &desktop_metrics).is_err() {
                    break;
                }
            }
            // alive_rx.changed() resolves when alive_tx is dropped (client task exited)
            _ = alive_rx.changed() => { break; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pos(hex: &str) -> AircraftPosition {
        AircraftPosition {
            hex_ident: hex.to_string(),
            callsign: None,
            altitude: None,
            ground_speed: None,
            track: None,
            latitude: None,
            longitude: None,
            vertical_rate: None,
            squawk: None,
            is_on_ground: None,
            timestamp: "2024-01-01 00:00:00".to_string(),
            message_count: 0,
        }
    }

    #[test]
    fn merge_inserts_new_aircraft() {
        let mut buffer = HashMap::new();
        let pos = AircraftPosition {
            latitude: Some(48.8),
            longitude: Some(2.3),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, pos);

        assert_eq!(buffer.len(), 1);
        let entry = &buffer["ABC123"];
        assert_eq!(entry.latitude, Some(48.8));
        assert_eq!(entry.longitude, Some(2.3));
    }

    #[test]
    fn merge_preserves_position_when_non_position_msg_arrives() {
        // MSG3 arrives with lat/lon, then MSG1 arrives with callsign but no lat/lon
        let mut buffer = HashMap::new();

        let msg3 = AircraftPosition {
            latitude: Some(48.8),
            longitude: Some(2.3),
            altitude: Some(35000.0),
            timestamp: "2024-01-01 00:00:00".to_string(),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, msg3);

        let msg1 = AircraftPosition {
            callsign: Some("BAW123".to_string()),
            timestamp: "2024-01-01 00:00:01".to_string(),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, msg1);

        let entry = &buffer["ABC123"];
        assert_eq!(entry.latitude, Some(48.8), "lat must survive MSG1 merge");
        assert_eq!(entry.longitude, Some(2.3), "lon must survive MSG1 merge");
        assert_eq!(entry.altitude, Some(35000.0), "alt must survive MSG1 merge");
        assert_eq!(
            entry.callsign.as_deref(),
            Some("BAW123"),
            "callsign from MSG1"
        );
        assert_eq!(entry.timestamp, "2024-01-01 00:00:01", "timestamp updated");
    }

    #[test]
    fn merge_updates_position_with_newer_values() {
        let mut buffer = HashMap::new();

        let first = AircraftPosition {
            latitude: Some(48.8),
            longitude: Some(2.3),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, first);

        let second = AircraftPosition {
            latitude: Some(49.0),
            longitude: Some(2.5),
            timestamp: "2024-01-01 00:00:02".to_string(),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, second);

        let entry = &buffer["ABC123"];
        assert_eq!(entry.latitude, Some(49.0));
        assert_eq!(entry.longitude, Some(2.5));
    }

    #[test]
    fn merge_preserves_squawk_string_field() {
        let mut buffer = HashMap::new();

        let msg = AircraftPosition {
            squawk: Some("7700".to_string()),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, msg);

        // Next message has no squawk
        let msg2 = AircraftPosition {
            altitude: Some(10000.0),
            ..make_pos("ABC123")
        };
        merge_into_buffer(&mut buffer, msg2);

        let entry = &buffer["ABC123"];
        assert_eq!(entry.squawk.as_deref(), Some("7700"), "squawk must survive");
        assert_eq!(entry.altitude, Some(10000.0));
    }

    #[test]
    fn merge_handles_multiple_aircraft_independently() {
        let mut buffer = HashMap::new();

        merge_into_buffer(
            &mut buffer,
            AircraftPosition {
                latitude: Some(48.8),
                ..make_pos("AAA")
            },
        );
        merge_into_buffer(
            &mut buffer,
            AircraftPosition {
                latitude: Some(51.5),
                ..make_pos("BBB")
            },
        );

        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer["AAA"].latitude, Some(48.8));
        assert_eq!(buffer["BBB"].latitude, Some(51.5));
    }
}

/// Socket watchdog — monitors message activity and emits periodic status.
///
/// Emits a status event to the frontend every 60 seconds (heartbeat) and
/// immediately on any status transition. Thresholds are derived from the
/// configured `socket_read_timeout_secs`:
///
/// - **Connected**: message received within `read_timeout + 10s`
/// - **Degraded**: no message for `read_timeout + 10s`
/// - **ConnectionLost**: no message for `read_timeout + 30s`
///
/// If a message arrives again after Degraded/ConnectionLost the status
/// switches back to Connected automatically.
///
/// Exits cleanly when the client task stops (alive_rx sender dropped).
async fn socket_watchdog(
    app: AppHandle,
    last_message_time: Arc<RwLock<Instant>>,
    test_mode: bool,
    connection_status: SharedConnectionStatus,
    socket_read_timeout_secs: u64,
    mut alive_rx: tokio::sync::watch::Receiver<bool>,
    recorder: StatusEventRecorder,
) {
    let degraded_threshold = Duration::from_secs(socket_read_timeout_secs + 10);
    let lost_threshold = Duration::from_secs(socket_read_timeout_secs + 30);

    info!(
        "Socket watchdog started: degraded after {}s, connection lost after {}s",
        degraded_threshold.as_secs(),
        lost_threshold.as_secs(),
    );

    let mut check_tick = interval(Duration::from_secs(5));
    let mut heartbeat_tick = interval(Duration::from_secs(60));
    let mut current_status = ConnectionStatus::Connecting;

    let pulsar_status = if test_mode {
        ConnectionStatus::Disconnected
    } else {
        ConnectionStatus::Connected
    };

    // Allow initial connection time before first evaluation
    tokio::time::sleep(Duration::from_secs(2)).await;

    loop {
        tokio::select! {
            // Check status every 5 seconds
            _ = check_tick.tick() => {
                let elapsed = last_message_time.read().await.elapsed();

                let new_status = if elapsed >= lost_threshold {
                    ConnectionStatus::ConnectionLost
                } else if elapsed >= degraded_threshold {
                    ConnectionStatus::Degraded
                } else {
                    ConnectionStatus::Connected
                };

                // Emit only on transition
                if new_status != current_status {
                    info!(
                        "Socket status: {:?} -> {:?} (no message for {:.0}s)",
                        current_status, new_status, elapsed.as_secs_f64()
                    );

                    let event_status = match &new_status {
                        ConnectionStatus::Connected => StatusEventStatus::Connected,
                        ConnectionStatus::Degraded => StatusEventStatus::Degraded,
                        ConnectionStatus::ConnectionLost => StatusEventStatus::ConnectionLost,
                        _ => StatusEventStatus::Disconnected,
                    };
                    recorder
                        .record(
                            StatusEvent::now(StatusEventType::Socket, event_status)
                                .with_detail(format!(
                                    "no message for {:.0}s",
                                    elapsed.as_secs_f64()
                                )),
                        )
                        .await;

                    current_status = new_status.clone();

                    let status = StatusResponse {
                        is_running: true,
                        socket_status: new_status,
                        pulsar_status: pulsar_status.clone(),
                    };
                    if let Ok(mut guard) = connection_status.lock() {
                        *guard = status.clone();
                    }
                    if app.emit("adsb:status", &status).is_err() {
                        break;
                    }
                }
            }
            // Heartbeat: emit current status every 60 seconds
            _ = heartbeat_tick.tick() => {
                let elapsed = last_message_time.read().await.elapsed();
                info!(
                    "Socket heartbeat: {:?} (last message {:.0}s ago)",
                    current_status, elapsed.as_secs_f64()
                );
                let status = StatusResponse {
                    is_running: true,
                    socket_status: current_status.clone(),
                    pulsar_status: pulsar_status.clone(),
                };
                if let Ok(mut guard) = connection_status.lock() {
                    *guard = status.clone();
                }
                if app.emit("adsb:status", &status).is_err() {
                    break;
                }
            }
            // Client task exited: alive_tx dropped, stop watchdog
            _ = alive_rx.changed() => { break; }
        }
    }
}
