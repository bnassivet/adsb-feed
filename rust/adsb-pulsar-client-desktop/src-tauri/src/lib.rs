//! ADS-B Aircraft Tracker Desktop Application.
//!
//! Tauri v2 desktop app that wraps the adsb-pulsar-client library
//! and provides a real-time aircraft tracking dashboard.

mod bridge;
mod commands;
mod sbs_parser;
mod state;

use state::AppState;
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
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::start_feed,
            commands::stop_feed,
            commands::get_status,
            commands::get_metrics,
            commands::get_config,
            commands::save_config,
            commands::validate_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
