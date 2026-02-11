//! Application state management.
//!
//! Holds the shared state between Tauri commands and background tasks.

use adsb_pulsar_client::{Config, Metrics};
use serde::Serialize;
use std::sync::Mutex;
use tokio::task::JoinHandle;

/// Connection status for UI display.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", content = "message")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error(String),
}

/// Status response sent to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct StatusResponse {
    pub is_running: bool,
    pub socket_status: ConnectionStatus,
    pub pulsar_status: ConnectionStatus,
}

/// Handle to a running feed, allowing shutdown and metrics access.
pub struct FeedHandle {
    /// Metrics handle (lock-free reads)
    pub metrics: Metrics,
    /// Shutdown function — sends signal to stop the client
    pub shutdown_fn: Box<dyn Fn() + Send + Sync>,
    /// Background task handles for cleanup
    pub task_handles: Vec<JoinHandle<()>>,
}

/// Top-level application state managed by Tauri.
pub struct AppState {
    /// Current configuration (persisted via tauri-plugin-store)
    pub config: Mutex<Config>,
    /// Handle to the running feed (None when stopped)
    pub feed_handle: Mutex<Option<FeedHandle>>,
    /// Current connection status
    pub connection_status: Mutex<StatusResponse>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            config: Mutex::new(Config::default()),
            feed_handle: Mutex::new(None),
            connection_status: Mutex::new(StatusResponse {
                is_running: false,
                socket_status: ConnectionStatus::Disconnected,
                pulsar_status: ConnectionStatus::Disconnected,
            }),
        }
    }
}
