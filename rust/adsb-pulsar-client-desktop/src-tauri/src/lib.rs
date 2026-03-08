//! ADS-B Aircraft Tracker Desktop Application.
//!
//! Tauri v2 desktop app that wraps the adsb-pulsar-client library
//! and provides a real-time aircraft tracking dashboard with
//! DuckDB-backed historical storage.

mod bridge;
mod commands;
mod state;

use adsb_data_engine::{StorageConfig, StorageHandle};
use adsb_pulsar_client::Config;
use state::AppState;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const CONFIG_STORE_FILE: &str = "config.json";
const CONFIG_STORE_KEY: &str = "config";

/// Main entry point for the Tauri application.
pub fn run() {
    // Initialize tracing (logging)
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Initialize DuckDB storage in the app data directory.
            // Failure is non-fatal — the app continues in real-time-only mode.
            let storage = init_storage(app);

            // Load persisted config from Tauri store (falls back to defaults).
            let config = load_config(app);
            let state = AppState::with_config(config, storage);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_feed,
            commands::stop_feed,
            commands::get_status,
            commands::get_metrics,
            commands::get_config,
            commands::save_config,
            commands::validate_config,
            commands::query_bbox,
            commands::get_trajectory,
            commands::get_aircraft_summary,
            commands::get_time_distribution,
            commands::get_storage_stats,
            commands::get_detection_range,
            commands::get_hourly_heatmap,
            commands::get_raw_messages,
            commands::get_raw_message_count,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Load config from the Tauri store, falling back to defaults.
fn load_config(app: &tauri::App) -> Config {
    match app.store(CONFIG_STORE_FILE) {
        Ok(store) => {
            if let Some(value) = store.get(CONFIG_STORE_KEY) {
                match serde_json::from_value::<Config>(value.clone()) {
                    Ok(config) => {
                        info!("Config loaded from store");
                        return config;
                    }
                    Err(e) => {
                        warn!("Failed to deserialize stored config (using defaults): {e}");
                    }
                }
            } else {
                info!("No saved config found, using defaults");
            }
        }
        Err(e) => {
            warn!("Failed to open config store (using defaults): {e}");
        }
    }
    Config::default()
}

/// Save config to the Tauri store for persistence across restarts.
pub fn persist_config(app: &tauri::AppHandle, config: &Config) -> Result<(), String> {
    let store = app
        .store(CONFIG_STORE_FILE)
        .map_err(|e| format!("Failed to open config store: {e}"))?;
    let value =
        serde_json::to_value(config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    store.set(CONFIG_STORE_KEY.to_string(), value);
    store
        .save()
        .map_err(|e| format!("Failed to save config store: {e}"))?;
    Ok(())
}

/// Initialize DuckDB storage in the Tauri app data directory.
///
/// Returns `None` if initialization fails (app continues without history).
fn init_storage(app: &tauri::App) -> Option<StorageHandle> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let db_path = app_data_dir.join("adsb_history.db");

    match StorageHandle::open(StorageConfig {
        db_path: Some(db_path.clone()),
        source_id: "desktop".to_string(),
    }) {
        Ok(handle) => {
            info!("Storage initialized: {}", db_path.display());
            Some(handle)
        }
        Err(e) => {
            warn!("Storage init failed (continuing without history): {e}");
            None
        }
    }
}
