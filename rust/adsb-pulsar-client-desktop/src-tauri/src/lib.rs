//! ADS-B Aircraft Tracker Desktop Application.
//!
//! Tauri v2 desktop app that wraps the adsb-pulsar-client library
//! and provides a real-time aircraft tracking dashboard with
//! DuckDB-backed historical storage.

mod bridge;
mod commands;
mod state;
mod storage_mode;

/// Default loopback port for the agent tool server. Override with
/// `ADSB_AGENT_TOOL_SERVER_PORT`. The Python agent must point
/// `ADSB_AGENT_TOOL_SERVER_URL` at the same port.
const DEFAULT_TOOL_SERVER_PORT: u16 = 8787;

use adsb_data_engine::{
    ShareConfig, StatusEvent, StatusEventStatus, StatusEventType, StorageConfig, StorageHandle,
};
use adsb_pulsar_client::Config;
use state::AppState;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

pub const CONFIG_STORE_FILE: &str = "config.json";
const CONFIG_STORE_KEY: &str = "config";
/// Store key for the persisted storage mode. Separate from the feed `config`
/// key: this is about where history lives, not about the feed.
pub const STORAGE_MODE_STORE_KEY: &str = "storage_mode";

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
            let (storage, storage_config, storage_mode) = init_storage(app);

            // Load persisted config from Tauri store (falls back to defaults).
            let config = load_config(app);
            let state = AppState::with_config(config, storage, storage_config, storage_mode);

            // Start the loopback tool server for the Python agent BEFORE the
            // state is moved into Tauri's managed store — it shares the same
            // `SharedStorage` Arc, so agent queries see live data and respect
            // release/reclaim.
            let tool_server_port = std::env::var("ADSB_AGENT_TOOL_SERVER_PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
                .unwrap_or(DEFAULT_TOOL_SERVER_PORT);
            // Tauri's runtime, not tokio::spawn: `setup` runs before any tokio
            // runtime is in scope, and spawning there aborts the app at launch
            // with "there is no reactor running".
            tauri::async_runtime::spawn(adsb_data_server::server::serve(
                std::sync::Arc::clone(&state.storage),
                tool_server_port,
            ));

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
            commands::query_bbox_arrow,
            commands::get_trajectory,
            commands::get_trajectories_batch_arrow,
            commands::get_all_trajectories_arrow,
            commands::get_aircraft_summary,
            commands::get_flight_summary,
            commands::get_flight_summary_arrow,
            commands::get_time_distribution,
            commands::get_storage_stats,
            commands::get_detection_range,
            commands::get_hourly_heatmap,
            commands::get_raw_messages,
            commands::get_raw_messages_arrow,
            commands::get_raw_message_count,
            commands::get_recording_state,
            commands::set_recording_state,
            commands::get_storage_status,
            commands::release_storage,
            commands::reclaim_storage,
            commands::export_database,
            commands::start_sharing,
            commands::stop_sharing,
            commands::sharing_status,
            commands::preview_import_database,
            commands::import_database,
            commands::swap_database,
            commands::get_status_timeline,
            commands::create_event_of_interest,
            commands::get_events_of_interest,
            commands::get_event_of_interest,
            commands::update_event_of_interest,
            commands::delete_event_of_interest,
            commands::list_scenarios,
            commands::get_scenario,
            commands::create_scenario,
            commands::update_scenario,
            commands::delete_scenario,
            commands::create_scenario_track,
            commands::update_scenario_track,
            commands::delete_scenario_track,
            commands::reorder_scenario_tracks,
            commands::get_storage_mode,
            commands::set_storage_mode,
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
                        return apply_env_overrides(config, &|k| std::env::var(k).ok());
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
    apply_env_overrides(Config::default(), &|k| std::env::var(k).ok())
}

/// Applies `ADSB_*` environment overrides on top of a stored config.
///
/// The desktop loads its feed config from the Tauri store, never through
/// clap, so until this existed every `ADSB_*` variable the CLI advertises in
/// `--help` silently did nothing here. That was a trap for anyone scripting a
/// launch -- and it is what `scripts/stack.sh` needs in order to point the app
/// at a broker without writing into the app's own config store.
///
/// Precedence matches the CLI binaries: stored value beats the default,
/// environment beats the stored value. A blank or unparseable value is ignored
/// rather than fatal -- a typo in a launch script must not stop the app
/// starting, and `export ADSB_MQTT_BROKER=` is a common accident.
///
/// Only the fields a launch script needs are covered. The rest stay
/// UI-and-store only, deliberately: this is a scripting seam, not a second
/// configuration system.
fn apply_env_overrides(mut config: Config, get: &dyn Fn(&str) -> Option<String>) -> Config {
    let var = |name: &str| {
        get(name)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };

    if let Some(v) = var("ADSB_SOURCE_KIND")
        && let Ok(kind) = v.parse()
    {
        config.source_kind = kind;
    }
    if let Some(v) = var("ADSB_SOURCE_ID") {
        config.source_id = v;
    }
    if let Some(v) = var("ADSB_SOCKET_HOST") {
        config.socket_host = v;
    }
    if let Some(v) = var("ADSB_SOCKET_PORT")
        && let Ok(p) = v.parse()
    {
        config.socket_port = p;
    }
    if let Some(v) = var("ADSB_MQTT_BROKER") {
        config.mqtt_broker = v;
    }
    if let Some(v) = var("ADSB_MQTT_PORT")
        && let Ok(p) = v.parse()
    {
        config.mqtt_port = p;
    }
    if let Some(v) = var("ADSB_MQTT_TOPIC") {
        config.mqtt_topic = v;
    }

    config
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

/// Builds the Quack sharing config from environment lookups.
///
/// Split from the environment read so it can be tested without mutating
/// process-global state (env vars are shared across parallel test threads).
///
/// Returns `None` — sharing off, the default — unless at least one variable is
/// set. Setting a URI or token without `ADSB_SHARE_AUTO_START` is meaningful:
/// it pre-seeds what the UI toggle will use, so the token can be known in
/// advance rather than generated on the first click.
fn build_share_config(
    auto_start: Option<&str>,
    uri: Option<&str>,
    token: Option<&str>,
    allow_other_hostname: Option<&str>,
) -> Option<ShareConfig> {
    if auto_start.is_none() && uri.is_none() && token.is_none() && allow_other_hostname.is_none() {
        return None;
    }

    let defaults = ShareConfig::default();
    Some(ShareConfig {
        uri: uri
            .map(str::to_string)
            .filter(|u| !u.trim().is_empty())
            .unwrap_or(defaults.uri),
        token: token.map(str::to_string).filter(|t| !t.trim().is_empty()),
        allow_other_hostname: truthy(allow_other_hostname),
        auto_start: truthy(auto_start),
    })
}

/// Reads the sharing config from the environment.
///
/// | Variable | Effect |
/// |---|---|
/// | `ADSB_SHARE_AUTO_START` | Start sharing as soon as storage opens |
/// | `ADSB_SHARE_URI` | Bind URI (default `quack:localhost`, port 9494) |
/// | `ADSB_SHARE_TOKEN` | Use this token instead of a generated one |
/// | `ADSB_SHARE_ALLOW_OTHER_HOSTNAME` | Permit a non-local bind |
fn share_config_from_env() -> Option<ShareConfig> {
    let get = |k: &str| std::env::var(k).ok();
    build_share_config(
        get("ADSB_SHARE_AUTO_START").as_deref(),
        get("ADSB_SHARE_URI").as_deref(),
        get("ADSB_SHARE_TOKEN").as_deref(),
        get("ADSB_SHARE_ALLOW_OTHER_HOSTNAME").as_deref(),
    )
}

/// Whether an env-var string spells "yes".
fn truthy(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Reads the persisted storage mode, if one has been saved.
fn load_storage_mode(app: &tauri::App) -> Option<storage_mode::StorageMode> {
    let store = app.store(CONFIG_STORE_FILE).ok()?;
    let value = store.get(STORAGE_MODE_STORE_KEY)?;
    match serde_json::from_value(value.clone()) {
        Ok(mode) => Some(mode),
        Err(e) => {
            warn!("Ignoring unreadable stored storage mode: {e}");
            None
        }
    }
}

/// Builds a storage mode from the environment, if remote mode is requested.
fn storage_mode_from_env() -> Option<storage_mode::StorageMode> {
    remote_config_from_env().map(|r| storage_mode::StorageMode::Remote {
        uri: r.uri,
        token: r.token,
        disable_ssl: r.disable_ssl,
    })
}

/// Builds a [`RemoteConfig`] from the environment, if remote mode is requested.
///
/// Mode is explicit configuration, never a runtime fallback: a client that
/// "fell back" to opening the shared database locally while a daemon still held
/// it would be a second exclusive-lock owner, which is how the file gets
/// corrupted. Absent `ADSB_REMOTE_URI`, the app is embedded.
fn remote_config_from_env() -> Option<adsb_data_engine::types::RemoteConfig> {
    build_remote_config(
        std::env::var("ADSB_REMOTE_URI").ok().as_deref(),
        std::env::var("ADSB_REMOTE_TOKEN").ok().as_deref(),
        std::env::var("ADSB_REMOTE_DISABLE_SSL").ok().as_deref(),
    )
}

/// Pure form of [`remote_config_from_env`], so the rules are testable without
/// mutating process environment.
fn build_remote_config(
    uri: Option<&str>,
    token: Option<&str>,
    disable_ssl: Option<&str>,
) -> Option<adsb_data_engine::types::RemoteConfig> {
    let uri = uri.map(str::trim).filter(|u| !u.is_empty())?;
    Some(adsb_data_engine::types::RemoteConfig {
        uri: uri.to_string(),
        token: token
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(String::from),
        disable_ssl: disable_ssl.map(|v| truthy(Some(v))),
    })
}

/// Initialize DuckDB storage in the Tauri app data directory.
///
/// Returns `(handle, config)`. The config is kept for reopening after release.
/// Returns `(None, None)` if initialization fails (app continues without history).
fn init_storage(
    app: &tauri::App,
) -> (
    Option<StorageHandle>,
    Option<StorageConfig>,
    storage_mode::StorageMode,
) {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => return (None, None, storage_mode::StorageMode::default()),
    };
    // A stored choice wins; the environment only seeds the mode the first time.
    let mode = storage_mode::resolve_mode(load_storage_mode(app), storage_mode_from_env());
    info!("Storage mode: {}", mode.label());

    let config = mode.to_storage_config(&app_data_dir, share_config_from_env());
    let db_path = config.db_path.clone().unwrap_or_default();

    match StorageHandle::open(config.clone()) {
        Ok(handle) => {
            info!("Storage initialized: {}", db_path.display());
            let _ = handle.insert_status_event_sync(&StatusEvent::now(
                StatusEventType::Feed,
                StatusEventStatus::AppStart,
            ));
            (Some(handle), Some(config), mode)
        }
        Err(e) => {
            warn!("Storage init failed (continuing without history): {e}");
            (None, Some(config), mode)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::build_share_config;

    #[test]
    fn share_is_off_when_nothing_is_configured() {
        assert!(build_share_config(None, None, None, None).is_none());
    }

    #[test]
    fn auto_start_accepts_the_usual_spellings_of_yes() {
        for value in ["1", "true", "TRUE", "yes", "on", " true "] {
            let cfg = build_share_config(Some(value), None, None, None).expect("configured");
            assert!(cfg.auto_start, "{value:?} should enable auto_start");
        }
        for value in ["0", "false", "no", "off", ""] {
            let cfg = build_share_config(Some(value), None, None, None).expect("configured");
            assert!(!cfg.auto_start, "{value:?} should not enable auto_start");
        }
    }

    #[test]
    fn a_token_alone_pre_seeds_sharing_without_starting_it() {
        // The point of setting only a token: know it in advance, but still
        // require a deliberate click to expose the database.
        let cfg = build_share_config(None, None, Some("PRESET"), None).expect("configured");
        assert_eq!(cfg.token.as_deref(), Some("PRESET"));
        assert!(!cfg.auto_start);
        assert_eq!(cfg.uri, "quack:localhost");
    }

    #[test]
    fn blank_values_fall_back_to_defaults_rather_than_binding_nothing() {
        let cfg = build_share_config(Some("1"), Some("  "), Some(""), None).expect("configured");
        assert_eq!(cfg.uri, "quack:localhost");
        assert_eq!(
            cfg.token, None,
            "a blank token must generate one, not be used"
        );
    }

    #[test]
    fn uri_and_allow_other_hostname_are_carried_through() {
        let cfg = build_share_config(Some("1"), Some("quack:0.0.0.0:9500"), None, Some("true"))
            .expect("configured");
        assert_eq!(cfg.uri, "quack:0.0.0.0:9500");
        assert!(cfg.allow_other_hostname);
        assert!(cfg.auto_start);
    }
}

#[cfg(test)]
mod remote_mode_tests {
    use super::build_remote_config;

    #[test]
    fn absent_uri_means_embedded_mode() {
        // Mode is explicit configuration. Without a URI the app owns its own
        // database, exactly as before this feature existed.
        assert!(build_remote_config(None, Some("tok"), None).is_none());
    }

    #[test]
    fn a_blank_uri_is_treated_as_absent() {
        // An empty env var is a common accident (`export ADSB_REMOTE_URI=`);
        // it must not produce a remote config with a nonsense URI.
        assert!(build_remote_config(Some("   "), None, None).is_none());
    }

    #[test]
    fn a_uri_selects_remote_mode() {
        let c = build_remote_config(Some("quack:pi.lan:9494"), Some("tok"), None).unwrap();
        assert_eq!(c.uri, "quack:pi.lan:9494");
        assert_eq!(c.token.as_deref(), Some("tok"));
        assert_eq!(c.disable_ssl, None, "left to the host heuristic");
    }

    #[test]
    fn a_blank_token_is_none_rather_than_an_empty_string() {
        let c = build_remote_config(Some("quack:pi.lan:9494"), Some(""), None).unwrap();
        assert!(
            c.token.is_none(),
            "an empty token would be sent as TOKEN ''"
        );
    }

    #[test]
    fn disable_ssl_accepts_the_usual_spellings_of_yes() {
        for v in ["1", "true", "TRUE", "yes", "on"] {
            let c = build_remote_config(Some("quack:pi.lan:9494"), None, Some(v)).unwrap();
            assert_eq!(c.disable_ssl, Some(true), "{v:?}");
        }
        for v in ["0", "false", "no", "off", ""] {
            let c = build_remote_config(Some("quack:pi.lan:9494"), None, Some(v)).unwrap();
            assert_eq!(c.disable_ssl, Some(false), "{v:?}");
        }
    }
}

#[cfg(test)]
mod env_override_tests {
    use super::apply_env_overrides;
    use adsb_pulsar_client::{Config, SourceKind};

    /// Stands in for the process environment.
    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k: &str| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn nothing_set_leaves_the_stored_config_untouched() {
        let stored = Config {
            source_id: "from-store".into(),
            mqtt_broker: "store.lan".into(),
            ..Config::default()
        };
        let out = apply_env_overrides(stored.clone(), &env(&[]));
        assert_eq!(out.source_id, "from-store");
        assert_eq!(out.mqtt_broker, "store.lan");
    }

    #[test]
    fn env_beats_the_stored_config() {
        // Matches the precedence the CLI binaries already use. Without this the
        // desktop silently ignores every ADSB_* var it advertises in --help.
        let stored = Config {
            mqtt_broker: "store.lan".into(),
            ..Config::default()
        };
        let out = apply_env_overrides(stored, &env(&[("ADSB_MQTT_BROKER", "env.lan")]));
        assert_eq!(out.mqtt_broker, "env.lan");
    }

    #[test]
    fn source_kind_can_be_switched_from_the_environment() {
        let stored = Config::default();
        assert_eq!(stored.source_kind, SourceKind::Socket);
        let out = apply_env_overrides(stored, &env(&[("ADSB_SOURCE_KIND", "mqtt")]));
        assert_eq!(out.source_kind, SourceKind::Mqtt);
    }

    #[test]
    fn an_unparseable_value_is_ignored_rather_than_fatal() {
        // A typo in a launch script must not stop the app from starting.
        let stored = Config::default();
        let out = apply_env_overrides(
            stored,
            &env(&[
                ("ADSB_SOURCE_KIND", "carrier-pigeon"),
                ("ADSB_MQTT_PORT", "not-a-number"),
            ]),
        );
        assert_eq!(out.source_kind, SourceKind::Socket);
        assert_eq!(out.mqtt_port, 1883);
    }

    #[test]
    fn a_blank_value_is_treated_as_unset() {
        // `export ADSB_MQTT_BROKER=` is a common accident and must not blank
        // out a working stored value.
        let stored = Config {
            mqtt_broker: "store.lan".into(),
            ..Config::default()
        };
        let out = apply_env_overrides(stored, &env(&[("ADSB_MQTT_BROKER", "  ")]));
        assert_eq!(out.mqtt_broker, "store.lan");
    }

    #[test]
    fn socket_and_mqtt_endpoints_all_layer() {
        let out = apply_env_overrides(
            Config::default(),
            &env(&[
                ("ADSB_SOCKET_HOST", "10.0.0.9"),
                ("ADSB_SOCKET_PORT", "30005"),
                ("ADSB_MQTT_PORT", "1884"),
                ("ADSB_MQTT_TOPIC", "adsb/other"),
            ]),
        );
        assert_eq!(out.socket_host, "10.0.0.9");
        assert_eq!(out.socket_port, 30005);
        assert_eq!(out.mqtt_port, 1884);
        assert_eq!(out.mqtt_topic, "adsb/other");
    }
}
