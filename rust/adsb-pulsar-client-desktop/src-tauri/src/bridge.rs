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
use tokio::sync::broadcast;
use tokio::time::{interval, Duration};
use tracing::{error, info, warn};

/// Starts the feed client and background relay tasks.
///
/// Returns a `FeedHandle` that can be used to stop the feed
/// and read metrics.
pub fn start_feed(
    app: AppHandle,
    config: Config,
) -> Result<FeedHandle, String> {
    let mut client = ADSBFeedClient::new(config).map_err(|e| e.to_string())?;

    // Attach message tap (buffer 4096 messages)
    let message_rx = client.with_message_tap(4096);

    // Get metrics handle before moving client
    let metrics = client.metrics();
    let metrics_for_relay = metrics.clone();

    // Use a oneshot channel to signal shutdown from outside the task
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let stop_tx = Arc::new(tokio::sync::Mutex::new(Some(stop_tx)));

    let app_for_client = app.clone();
    let app_for_messages = app.clone();
    let app_for_metrics = app.clone();

    // Task 1: Run the feed client
    let client_task = tokio::spawn(async move {
        // Emit connecting status
        let _ = app_for_client.emit("adsb:status", StatusResponse {
            is_running: true,
            socket_status: ConnectionStatus::Connecting,
            pulsar_status: ConnectionStatus::Connecting,
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
        relay_messages(app_for_messages, message_rx).await;
    });

    // Task 3: Relay metrics to frontend
    let metrics_task = tokio::spawn(async move {
        relay_metrics(app_for_metrics, metrics_for_relay).await;
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
        task_handles: vec![client_task, message_task, metrics_task],
    })
}

/// Relays parsed SBS messages to the frontend, throttled to ~2 updates/sec.
///
/// Buffers messages into a HashMap keyed by hex_ident (keeping latest position
/// per aircraft), then flushes the batch every 500ms.
async fn relay_messages(
    app: AppHandle,
    mut rx: broadcast::Receiver<Vec<u8>>,
) {
    let mut flush_interval = interval(Duration::from_millis(500));
    let mut buffer: HashMap<String, AircraftPosition> = HashMap::new();

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(data) => {
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
