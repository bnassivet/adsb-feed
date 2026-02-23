//! ADS-B Aircraft Tracker Desktop Application.
//!
//! Tauri v2 desktop app that wraps the adsb-pulsar-client library
//! and provides a real-time aircraft tracking dashboard with
//! DuckDB-backed historical storage.

mod bridge;
mod commands;
mod state;

use adsb_data_engine::{StorageConfig, StorageHandle};
use state::AppState;
use tauri::Manager;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

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
            app.manage(AppState::new(storage));
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
            commands::get_storage_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
