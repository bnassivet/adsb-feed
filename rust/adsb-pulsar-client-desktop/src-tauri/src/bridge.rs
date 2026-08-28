//! Bridge between the adsb-pulsar-client library and Tauri.
//!
//! Spawns the feed client as a background task and relays messages
//! to the frontend via Tauri events, with throttling to prevent
//! overwhelming the webview.

use crate::state::{
    ConnectionStatus, FeedHandle, SharedConnectionStatus, SharedStorage, StatusResponse,
};
use adsb_data_engine::{
    AircraftPosition, BatchSink, IngestConfig, IngestPipeline, StatusEvent, StatusEventStatus,
    StatusEventType,
};
use adsb_pulsar_client::forwarder::NoopForwarder;
use adsb_pulsar_client::source::mqtt_source::MqttSource;
use adsb_pulsar_client::source::socket_source::SocketSource;
use adsb_pulsar_client::source::{Liveness, LivenessPolicy, MessageSource, SourceStatus};
use adsb_pulsar_client::{Config, Metrics, SourceKind};
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
    let dump1090_tz = config.dump1090_tz.clone();
    let source_id = config.source_id.clone();
    let source_kind = config.source_kind;
    // Thresholds must follow the source: a broker subscription has no TCP read
    // timeout, so reusing the socket numbers would make the status light lie.
    let liveness = config.liveness_policy();

    // The desktop consumes the feed rather than republishing it, so a socket
    // source carries a NoopForwarder; an MQTT source has no forwarders at all.
    // A socket source owns the feed client and therefore its counters, which
    // the metrics bar reads. An MQTT subscriber has no socket of its own to
    // report on, so it gets a fresh (zeroed) handle rather than a wrong one.
    let (mut source, metrics): (Box<dyn MessageSource>, Metrics) = match source_kind {
        SourceKind::Socket => {
            let s = SocketSource::with_forwarders(config, vec![Box::new(NoopForwarder)])
                .map_err(|e| e.to_string())?;
            let m = s.metrics();
            (Box::new(s), m)
        }
        SourceKind::Mqtt => (Box::new(MqttSource::new(&config)), Metrics::new()),
    };

    let message_rx = source.subscribe(4096);
    let transport_status = source.status();
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
            result = source.run() => {
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
                source.shutdown();
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
            source_id,
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
            liveness,
            transport_status,
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

/// [`BatchSink`] that forwards each flushed batch to the webview.
///
/// This is the *only* thing the desktop app does differently from the headless
/// `adsb-data-server` daemon; everything else in the ingest path is shared via
/// [`IngestPipeline`] so the two cannot drift.
struct EmitSink {
    app: AppHandle,
}

impl BatchSink for EmitSink {
    fn on_positions(&self, batch: &[AircraftPosition]) {
        let _ = self.app.emit("adsb:message", batch);
    }
}

/// Relays parsed SBS messages to the frontend, throttled to ~2 updates/sec.
///
/// Thin wrapper over the shared [`IngestPipeline`]: it supplies the Tauri
/// emit sink and the caller-owned toggles/counters, and the engine does the
/// parsing, per-aircraft merging, throttling and DuckDB persistence.
#[allow(clippy::too_many_arguments)]
async fn relay_messages(
    app: AppHandle,
    rx: broadcast::Receiver<Vec<u8>>,
    last_message_time: Arc<RwLock<Instant>>,
    storage: SharedStorage,
    dump1090_tz: String,
    source_id: String,
    messages_parsed: Arc<AtomicU64>,
    record_positions: Arc<AtomicBool>,
    record_raw: Arc<AtomicBool>,
) {
    let pipeline = IngestPipeline::new(
        storage,
        IngestConfig {
            source_id,
            dump1090_tz,
            flush_interval: Duration::from_millis(500),
        },
    )
    .with_last_message_time(last_message_time)
    .with_messages_parsed(messages_parsed)
    .with_record_positions(record_positions)
    .with_record_raw(record_raw);

    pipeline.run(rx, EmitSink { app }).await;
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
#[allow(clippy::too_many_arguments)]
async fn socket_watchdog(
    app: AppHandle,
    last_message_time: Arc<RwLock<Instant>>,
    test_mode: bool,
    connection_status: SharedConnectionStatus,
    liveness: LivenessPolicy,
    transport_status: tokio::sync::watch::Receiver<SourceStatus>,
    mut alive_rx: tokio::sync::watch::Receiver<bool>,
    recorder: StatusEventRecorder,
) {
    info!(
        "Feed watchdog started: degraded after {}s, connection lost after {}s",
        liveness.degraded_after.as_secs(),
        liveness.lost_after.as_secs(),
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
                let transport = *transport_status.borrow();

                let new_status = match liveness.resolve(transport, elapsed) {
                    Liveness::Connecting => ConnectionStatus::Connecting,
                    Liveness::Healthy => ConnectionStatus::Connected,
                    Liveness::Degraded => ConnectionStatus::Degraded,
                    Liveness::Lost => ConnectionStatus::ConnectionLost,
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
