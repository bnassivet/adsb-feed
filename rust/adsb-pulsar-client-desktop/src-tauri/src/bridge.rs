//! Bridge between the adsb-pulsar-client library and Tauri.
//!
//! Spawns the feed client as a background task and relays messages
//! to the frontend via Tauri events, with throttling to prevent
//! overwhelming the webview.

use crate::sbs_parser::{parse_sbs_message, AircraftPosition};
use crate::state::{ConnectionStatus, FeedHandle, StatusResponse};
use adsb_pulsar_client::{ADSBFeedClient, Config, Metrics};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, RwLock};
use tokio::time::{interval, Duration, Instant};
use tracing::{error, info, warn};

/// Starts the feed client and background relay tasks.
///
/// Returns a `FeedHandle` that can be used to stop the feed
/// and read metrics.
pub fn start_feed(
    app: AppHandle,
    config: Config,
) -> Result<FeedHandle, String> {
    let test_mode = config.test_mode;
    let socket_read_timeout_secs = config.socket_read_timeout_secs;
    let mut client = ADSBFeedClient::new(config).map_err(|e| e.to_string())?;

    // Attach message tap (buffer 4096 messages)
    let message_rx = client.with_message_tap(4096);

    // Get metrics handle before moving client
    let metrics = client.metrics();
    let metrics_for_relay = metrics.clone();

    // Shared state for last message time (for socket watchdog)
    let last_message_time = Arc::new(RwLock::new(Instant::now()));
    let last_message_time_watchdog = last_message_time.clone();

    // Use a oneshot channel to signal shutdown from outside the task
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let stop_tx = Arc::new(tokio::sync::Mutex::new(Some(stop_tx)));

    let app_for_client = app.clone();
    let app_for_messages = app.clone();
    let app_for_metrics = app.clone();
    let app_for_watchdog = app.clone();

    // Task 1: Run the feed client
    let client_task = tokio::spawn(async move {
        // Emit connecting status
        let _ = app_for_client.emit("adsb:status", StatusResponse {
            is_running: true,
            socket_status: ConnectionStatus::Connecting,
            pulsar_status: if test_mode {
                ConnectionStatus::Disconnected
            } else {
                ConnectionStatus::Connecting
            },
        });

        // Run client with shutdown signal
        tokio::select! {
            result = client.run() => {
                match result {
                    Ok(()) => {
                        info!("Feed client stopped normally");
                    }
                    Err(e) => {
                        error!("Feed client error: {}", e);
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
        let _ = app_for_client.emit("adsb:status", StatusResponse {
            is_running: false,
            socket_status: ConnectionStatus::Disconnected,
            pulsar_status: ConnectionStatus::Disconnected,
        });
    });

    // Task 2: Relay messages to frontend (throttled)
    let message_task = tokio::spawn(async move {
        relay_messages(app_for_messages, message_rx, last_message_time).await;
    });

    // Task 3: Relay metrics to frontend
    let metrics_task = tokio::spawn(async move {
        relay_metrics(app_for_metrics, metrics_for_relay).await;
    });

    // Task 4: Socket watchdog - monitor message activity and emit periodic status
    let watchdog_task = tokio::spawn(async move {
        socket_watchdog(
            app_for_watchdog,
            last_message_time_watchdog,
            test_mode,
            socket_read_timeout_secs,
        ).await;
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
        shutdown_fn,
        task_handles: vec![client_task, message_task, metrics_task, watchdog_task],
    })
}

/// Relays parsed SBS messages to the frontend, throttled to ~2 updates/sec.
///
/// Buffers messages into a HashMap keyed by hex_ident (keeping latest position
/// per aircraft), then flushes the batch every 500ms.
async fn relay_messages(
    app: AppHandle,
    mut rx: broadcast::Receiver<Vec<u8>>,
    last_message_time: Arc<RwLock<Instant>>,
) {
    let mut flush_interval = interval(Duration::from_millis(500));
    let mut buffer: HashMap<String, AircraftPosition> = HashMap::new();

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(data) => {
                        // Update last message time
                        *last_message_time.write().await = Instant::now();

                        if let Ok(line) = String::from_utf8(data) {
                            if let Some(pos) = parse_sbs_message(&line) {
                                buffer.insert(pos.hex_ident.clone(), pos);
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("Message relay lagged, skipped {} messages", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        if !buffer.is_empty() {
                            let batch: Vec<AircraftPosition> = buffer.drain().map(|(_, v)| v).collect();
                            let _ = app.emit("adsb:message", &batch);
                        }
                        break;
                    }
                }
            }
            _ = flush_interval.tick() => {
                if !buffer.is_empty() {
                    let batch: Vec<AircraftPosition> = buffer.drain().map(|(_, v)| v).collect();
                    let _ = app.emit("adsb:message", &batch);
                }
            }
        }
    }
}

/// Emits metrics snapshots to the frontend every second.
async fn relay_metrics(app: AppHandle, metrics: Metrics) {
    let mut tick = interval(Duration::from_secs(1));

    loop {
        tick.tick().await;
        let snapshot = metrics.snapshot();
        if app.emit("adsb:metrics", &snapshot).is_err() {
            break;
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
async fn socket_watchdog(
    app: AppHandle,
    last_message_time: Arc<RwLock<Instant>>,
    test_mode: bool,
    socket_read_timeout_secs: u64,
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
                    current_status = new_status.clone();

                    let status = StatusResponse {
                        is_running: true,
                        socket_status: new_status,
                        pulsar_status: pulsar_status.clone(),
                    };
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
                if app.emit("adsb:status", &status).is_err() {
                    break;
                }
            }
        }
    }
}
