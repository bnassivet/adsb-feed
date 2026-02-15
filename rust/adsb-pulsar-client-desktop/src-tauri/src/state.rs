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
    /// Not running / intentionally off (grey)
    Disconnected,
    /// Attempting to establish connection (yellow, pulsing)
    Connecting,
    /// Receiving messages normally (green)
    Connected,
    /// No messages for read_timeout + 10s — feed may be stalling (orange)
    Degraded,
    /// No messages for read_timeout + 30s — connection likely lost (red)
    ConnectionLost,
    /// Unexpected error (red)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_state_new_defaults() {
        let state = AppState::new();
        let config = state.config.lock().unwrap();
        // Verify it's a default Config by checking a known default value
        assert_eq!(config.source_id, "kraspberryPi");
    }

    #[test]
    fn test_app_state_feed_handle_starts_none() {
        let state = AppState::new();
        let handle = state.feed_handle.lock().unwrap();
        assert!(handle.is_none());
    }

    #[test]
    fn test_app_state_initial_status_not_running() {
        let state = AppState::new();
        let status = state.connection_status.lock().unwrap();
        assert!(!status.is_running);
    }

    #[test]
    fn test_connection_status_serialize() {
        let status = ConnectionStatus::Connected;
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["status"], "Connected");

        let error = ConnectionStatus::Error("test error".to_string());
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["status"], "Error");
        assert_eq!(json["message"], "test error");
    }

    #[test]
    fn test_status_response_serialize() {
        let response = StatusResponse {
            is_running: true,
            socket_status: ConnectionStatus::Connected,
            pulsar_status: ConnectionStatus::Disconnected,
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["is_running"], true);
        assert!(json.get("socket_status").is_some());
        assert!(json.get("pulsar_status").is_some());
    }
}
