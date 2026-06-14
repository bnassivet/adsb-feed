//! Application state management.
//!
//! Holds the shared state between Tauri commands and background tasks.

use adsb_data_engine::{StorageConfig, StorageHandle};
use adsb_pulsar_client::{Config, Metrics};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;
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
    #[allow(dead_code)]
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
    /// Bridge-level parsed-message counter (distinct from core messages_received
    /// which counts every TCP line). Shared with bridge tasks.
    pub messages_parsed: Arc<AtomicU64>,
    /// Shutdown function — sends signal to stop the client
    pub shutdown_fn: Box<dyn Fn() + Send + Sync>,
    /// Background task handles for cleanup
    pub task_handles: Vec<JoinHandle<()>>,
}

/// Recording state for independent DuckDB stream control.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecordingState {
    pub record_positions: bool,
    pub record_raw: bool,
}

/// Availability state for the DuckDB storage connection.
///
/// - `Available`: Connection is active and usable.
/// - `Released`: Connection was intentionally dropped (user clicked release).
/// - `Unavailable`: Init failed or storage was never configured.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StorageAvailability {
    Available,
    Released,
    Unavailable,
}

/// Shared DuckDB storage: `Arc<RwLock<Option<StorageHandle>>>`.
///
/// The relay task and query commands read-lock on each access.
/// Release takes a write-lock and sets to `None`.
/// Reclaim reopens from the stored `StorageConfig`.
pub type SharedStorage = Arc<RwLock<Option<StorageHandle>>>;

/// Shared connection status: `Arc<Mutex<StatusResponse>>`.
///
/// Updated by both the `start_feed`/`stop_feed` commands and background tasks
/// (socket watchdog), and read by `get_status`.
pub type SharedConnectionStatus = Arc<Mutex<StatusResponse>>;

/// Top-level application state managed by Tauri.
pub struct AppState {
    /// Current configuration (persisted via tauri-plugin-store)
    pub config: Mutex<Config>,
    /// Handle to the running feed (None when stopped)
    pub feed_handle: Mutex<Option<FeedHandle>>,
    /// Current connection status (Arc-wrapped so background tasks can update it)
    pub connection_status: Arc<Mutex<StatusResponse>>,
    /// DuckDB storage handle, shared with the relay task via Arc<RwLock<...>>
    pub storage: SharedStorage,
    /// Config used to reopen storage after release (None if storage was never available)
    pub storage_config: Option<StorageConfig>,
    /// Whether to record position data to DuckDB (toggled at runtime)
    pub record_positions: Arc<AtomicBool>,
    /// Whether to record raw SBS-1 messages to DuckDB (toggled at runtime)
    pub record_raw: Arc<AtomicBool>,
}

impl AppState {
    #[cfg(test)]
    pub fn new(storage: Option<StorageHandle>) -> Self {
        Self::with_config(Config::default(), storage, None)
    }

    pub fn with_config(
        config: Config,
        storage: Option<StorageHandle>,
        storage_config: Option<StorageConfig>,
    ) -> Self {
        Self {
            config: Mutex::new(config),
            feed_handle: Mutex::new(None),
            connection_status: Arc::new(Mutex::new(StatusResponse {
                is_running: false,
                socket_status: ConnectionStatus::Disconnected,
                pulsar_status: ConnectionStatus::Disconnected,
            })),
            storage: Arc::new(RwLock::new(storage)),
            storage_config,
            record_positions: Arc::new(AtomicBool::new(true)),
            record_raw: Arc::new(AtomicBool::new(true)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_state_new_defaults() {
        let state = AppState::new(None);
        let config = state.config.lock().unwrap();
        // Verify it's a default Config by checking a known default value
        assert_eq!(config.source_id, "kraspberryPi");
    }

    #[test]
    fn test_app_state_feed_handle_starts_none() {
        let state = AppState::new(None);
        let handle = state.feed_handle.lock().unwrap();
        assert!(handle.is_none());
    }

    #[test]
    fn test_app_state_initial_status_not_running() {
        let state = AppState::new(None);
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
    fn test_recording_flags_default_to_true() {
        let state = AppState::new(None);
        assert!(
            state
                .record_positions
                .load(std::sync::atomic::Ordering::Relaxed)
        );
        assert!(state.record_raw.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn test_recording_state_serialize() {
        let rs = RecordingState {
            record_positions: true,
            record_raw: false,
        };
        let json = serde_json::to_value(&rs).unwrap();
        assert_eq!(json["record_positions"], true);
        assert_eq!(json["record_raw"], false);
    }

    #[test]
    fn test_recording_state_deserialize() {
        let json = serde_json::json!({"record_positions": false, "record_raw": true});
        let rs: RecordingState = serde_json::from_value(json).unwrap();
        assert!(!rs.record_positions);
        assert!(rs.record_raw);
    }

    #[test]
    fn test_storage_availability_serialize() {
        let available = StorageAvailability::Available;
        let json = serde_json::to_value(&available).unwrap();
        assert_eq!(json, "available");

        let released = StorageAvailability::Released;
        let json = serde_json::to_value(&released).unwrap();
        assert_eq!(json, "released");

        let unavailable = StorageAvailability::Unavailable;
        let json = serde_json::to_value(&unavailable).unwrap();
        assert_eq!(json, "unavailable");
    }

    #[test]
    fn test_storage_availability_deserialize() {
        let val: StorageAvailability = serde_json::from_str("\"released\"").unwrap();
        assert_eq!(val, StorageAvailability::Released);
    }

    #[test]
    fn test_app_state_stores_storage_config() {
        let config = adsb_data_engine::StorageConfig {
            db_path: Some(std::path::PathBuf::from("/tmp/test.db")),
            source_id: "test".to_string(),
            gap_threshold_ms: 3_600_000,
        };
        let state = AppState::with_config(Config::default(), None, Some(config.clone()));
        assert!(state.storage_config.is_some());
        let stored = state.storage_config.unwrap();
        assert_eq!(stored.source_id, "test");
        assert_eq!(stored.db_path.unwrap().to_string_lossy(), "/tmp/test.db");
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
