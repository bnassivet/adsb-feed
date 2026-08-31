//! Where the desktop app's historical data lives.
//!
//! Two modes, chosen explicitly and never by runtime fallback. A client that
//! "fell back" to opening the shared database locally while a daemon still held
//! it would be a second exclusive-lock owner, which is how a DuckDB file gets
//! corrupted -- so a failed remote connection surfaces as degraded storage, not
//! as a silent switch to embedded.

use adsb_data_engine::StorageConfig;
use adsb_data_engine::types::RemoteConfig;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Database file owned by this app when it records its own history.
const EMBEDDED_DB: &str = "adsb_history.db";

/// Database file used in remote mode, for the tables that stay local.
///
/// Deliberately *not* the embedded file: remote mode replaces the observed
/// table names with views over the daemon's catalog, and those views cannot
/// take names that real tables already hold. Using one file would mean dropping
/// a user's recorded history to make room.
const LOCAL_DB: &str = "adsb_local.db";

/// Source of the app's historical data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum StorageMode {
    /// This app owns and records its own database (the default).
    #[default]
    Embedded,
    /// Observed data is read from an `adsb-data-server` over Quack; scenarios
    /// and events of interest stay local.
    Remote {
        uri: String,
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        disable_ssl: Option<bool>,
    },
}

impl StorageMode {
    /// Builds the storage configuration this mode implies.
    pub fn to_storage_config(
        &self,
        app_data_dir: &Path,
        share: Option<adsb_data_engine::ShareConfig>,
    ) -> StorageConfig {
        let (file, remote) = match self {
            StorageMode::Embedded => (EMBEDDED_DB, None),
            StorageMode::Remote {
                uri,
                token,
                disable_ssl,
            } => (
                LOCAL_DB,
                Some(RemoteConfig {
                    uri: uri.clone(),
                    token: token.clone().filter(|t| !t.trim().is_empty()),
                    disable_ssl: *disable_ssl,
                }),
            ),
        };

        StorageConfig {
            db_path: Some(PathBuf::from(app_data_dir).join(file)),
            source_id: "desktop".to_string(),
            gap_threshold_ms: 3_600_000,
            share,
            remote,
        }
    }

    /// Checks the mode is usable before anything tries to open it.
    ///
    /// Catching a bad URI here is worth it: DuckDB's own failure for a
    /// malformed `ATTACH` is far less legible than saying what is wrong.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            StorageMode::Embedded => Ok(()),
            StorageMode::Remote { uri, .. } => {
                let uri = uri.trim();
                if uri.is_empty() {
                    return Err("Remote URI cannot be empty".into());
                }
                if !uri.starts_with("quack:") {
                    return Err(format!("Remote URI must start with 'quack:' (got '{uri}')"));
                }
                Ok(())
            }
        }
    }

    /// Human-readable label for logs and status text.
    pub fn label(&self) -> String {
        match self {
            StorageMode::Embedded => "embedded".to_string(),
            StorageMode::Remote { uri, .. } => format!("remote ({uri})"),
        }
    }
}

/// Decides the effective mode from what is stored and what the environment says.
///
/// A **stored** choice always wins. The environment only seeds the mode when
/// nothing has been stored -- otherwise a leftover `ADSB_REMOTE_URI` would
/// override the settings UI, and the toggle would appear to do nothing.
pub fn resolve_mode(stored: Option<StorageMode>, from_env: Option<StorageMode>) -> StorageMode {
    stored.or(from_env).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir() -> PathBuf {
        PathBuf::from("/app/data")
    }

    #[test]
    fn embedded_is_the_default() {
        assert_eq!(StorageMode::default(), StorageMode::Embedded);
    }

    #[test]
    fn embedded_owns_the_history_database() {
        let cfg = StorageMode::Embedded.to_storage_config(&dir(), None);
        assert_eq!(cfg.db_path, Some(dir().join("adsb_history.db")));
        assert!(cfg.remote.is_none(), "embedded mode attaches nothing");
    }

    #[test]
    fn remote_uses_a_separate_local_file() {
        // Remote mode replaces the observed table names with views. Pointing it
        // at adsb_history.db would mean dropping the user's real tables to make
        // room for those views.
        let cfg = remote("quack:pi.lan:9494").to_storage_config(&dir(), None);
        assert_eq!(cfg.db_path, Some(dir().join("adsb_local.db")));
        assert_ne!(cfg.db_path, Some(dir().join("adsb_history.db")));
    }

    #[test]
    fn remote_carries_the_connection_details() {
        let mode = StorageMode::Remote {
            uri: "quack:pi.lan:9494".into(),
            token: Some("tok".into()),
            disable_ssl: Some(true),
        };
        let remote = mode.to_storage_config(&dir(), None).remote.expect("remote");
        assert_eq!(remote.uri, "quack:pi.lan:9494");
        assert_eq!(remote.token.as_deref(), Some("tok"));
        assert_eq!(remote.disable_ssl, Some(true));
    }

    #[test]
    fn switching_modes_changes_the_file_that_is_opened() {
        // The guard that keeps embedded history safe from a mode switch.
        let a = StorageMode::Embedded
            .to_storage_config(&dir(), None)
            .db_path;
        let b = remote("quack:pi:9494")
            .to_storage_config(&dir(), None)
            .db_path;
        assert_ne!(a, b);
    }

    #[test]
    fn a_blank_remote_uri_is_rejected() {
        assert!(remote("   ").validate().is_err());
        assert!(remote("quack:pi:9494").validate().is_ok());
        assert!(StorageMode::Embedded.validate().is_ok());
    }

    #[test]
    fn a_uri_without_the_quack_scheme_is_rejected() {
        // A bare host is the likeliest typo, and the resulting ATTACH failure
        // from DuckDB is far less legible than saying so here.
        let e = remote("pi.lan:9494").validate().unwrap_err();
        assert!(e.contains("quack:"), "{e}");
    }

    #[test]
    fn a_stored_mode_wins_over_the_environment() {
        // The UI must be authoritative: a stored choice that an env var could
        // override would make the settings toggle appear to do nothing.
        let stored = Some(remote("quack:stored:9494"));
        let env = Some(remote("quack:env:9494"));
        assert_eq!(resolve_mode(stored.clone(), env), stored.unwrap());
    }

    #[test]
    fn the_environment_seeds_the_mode_when_nothing_is_stored() {
        let env = remote("quack:env:9494");
        assert_eq!(resolve_mode(None, Some(env.clone())), env);
    }

    #[test]
    fn with_neither_stored_nor_env_the_app_is_embedded() {
        assert_eq!(resolve_mode(None, None), StorageMode::Embedded);
    }

    #[test]
    fn mode_round_trips_through_json() {
        for mode in [StorageMode::Embedded, remote("quack:pi:9494")] {
            let v = serde_json::to_value(&mode).unwrap();
            assert_eq!(serde_json::from_value::<StorageMode>(v).unwrap(), mode);
        }
    }

    #[test]
    fn the_json_tag_is_mode_so_the_typescript_union_can_match() {
        let v = serde_json::to_value(StorageMode::Embedded).unwrap();
        assert_eq!(v["mode"], "embedded");
        let v = serde_json::to_value(remote("quack:pi:9494")).unwrap();
        assert_eq!(v["mode"], "remote");
        assert_eq!(v["uri"], "quack:pi:9494");
    }

    fn remote(uri: &str) -> StorageMode {
        StorageMode::Remote {
            uri: uri.to_string(),
            token: None,
            disable_ssl: None,
        }
    }
}
