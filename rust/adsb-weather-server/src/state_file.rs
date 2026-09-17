//! The service's own durable state, kept across restarts.
//!
//! Two facts must survive a reboot or they quietly undo themselves:
//! - the operator's **enabled** setting: a disabled node that comes back
//!   enabled spends the quota the operator meant to save;
//! - the **not-before** time after a rate limit: a service restarted straight
//!   after a daily 429 would otherwise ask again at once.
//!
//! They have different writers -- the command side sets `enabled`, the
//! refresh loop sets `not_before_ms` -- so the file has one owner,
//! [`StateStore`], which serialises every read-modify-write.

use crate::cache::write_atomic;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// Why the state file could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum StateFileError {
    #[error("weather state file {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("weather state file {} is unreadable: {source}", path.display())]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// What is persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedState {
    /// The operator's setting. A file without it predates the setting, and
    /// the service was always on then.
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// Epoch ms before which the provider must not be asked again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before_ms: Option<i64>,
}

fn enabled_by_default() -> bool {
    true
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            enabled: true,
            not_before_ms: None,
        }
    }
}

/// Loads the state file. A missing file is `Ok(None)`: a first run has none.
pub fn load(path: &Path) -> Result<Option<PersistedState>, StateFileError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(StateFileError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|source| StateFileError::Json {
            path: path.to_path_buf(),
            source,
        })
}

/// Writes the state file atomically.
pub fn save(path: &Path, state: &PersistedState) -> Result<(), StateFileError> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|source| StateFileError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    write_atomic(path, &bytes).map_err(|source| StateFileError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// The single owner of the state file.
#[derive(Debug)]
pub struct StateStore {
    /// `None` keeps the state in memory only.
    path: Option<PathBuf>,
    state: Mutex<PersistedState>,
}

impl StateStore {
    /// State that lives only as long as the process.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            state: Mutex::new(PersistedState::default()),
        }
    }

    /// Opens the store at `path`, or in memory when `path` is `None`.
    ///
    /// An unreadable file is not fatal: the store starts from the defaults and
    /// the error is handed back for the caller to log. The next update
    /// rewrites the file.
    pub fn open(path: Option<PathBuf>) -> (Self, Option<StateFileError>) {
        let (state, error) = match path.as_deref().map(load) {
            None | Some(Ok(None)) => (PersistedState::default(), None),
            Some(Ok(Some(state))) => (state, None),
            Some(Err(e)) => (PersistedState::default(), Some(e)),
        };
        (
            Self {
                path,
                state: Mutex::new(state),
            },
            error,
        )
    }

    /// Whether updates reach a file.
    pub fn is_persistent(&self) -> bool {
        self.path.is_some()
    }

    /// The current state.
    pub fn get(&self) -> PersistedState {
        *self.lock()
    }

    /// Applies `change` and persists the result.
    ///
    /// Written before it is applied: if the write fails, the in-memory state
    /// is unchanged and the error is returned, so what the service does never
    /// differs from what a restart would come back with. An update that
    /// changes nothing does not touch the disk.
    pub fn update(
        &self,
        change: impl FnOnce(&mut PersistedState),
    ) -> Result<PersistedState, StateFileError> {
        let mut state = self.lock();
        let mut next = *state;
        change(&mut next);
        if next == *state {
            return Ok(next);
        }
        if let Some(path) = &self.path {
            save(path, &next)?;
        }
        *state = next;
        Ok(next)
    }

    fn lock(&self) -> MutexGuard<'_, PersistedState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disabled_until(ms: i64) -> PersistedState {
        PersistedState {
            enabled: false,
            not_before_ms: Some(ms),
        }
    }

    #[test]
    fn a_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&dir.path().join("state.json")).unwrap(), None);
    }

    #[test]
    fn state_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/state.json");
        save(&path, &disabled_until(42)).unwrap();
        assert_eq!(load(&path).unwrap(), Some(disabled_until(42)));
    }

    #[test]
    fn a_file_with_only_some_fields_takes_defaults_for_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "{}").unwrap();
        assert_eq!(load(&path).unwrap(), Some(PersistedState::default()));
    }

    #[test]
    fn a_new_store_is_enabled_with_no_deadline() {
        let (store, error) = StateStore::open(None);
        assert!(error.is_none());
        assert_eq!(store.get(), PersistedState::default());
        assert!(!store.is_persistent());
    }

    #[test]
    fn a_store_starts_from_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        save(&path, &disabled_until(7)).unwrap();

        let (store, error) = StateStore::open(Some(path));
        assert!(error.is_none());
        assert_eq!(store.get(), disabled_until(7));
    }

    #[test]
    fn an_unreadable_file_starts_from_defaults_and_reports_why() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "{ not json").unwrap();

        let (store, error) = StateStore::open(Some(path));
        assert!(matches!(error, Some(StateFileError::Json { .. })));
        assert_eq!(store.get(), PersistedState::default());
    }

    #[test]
    fn an_update_is_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let (store, _) = StateStore::open(Some(path.clone()));

        store.update(|s| s.enabled = false).unwrap();
        store.update(|s| s.not_before_ms = Some(99)).unwrap();

        // Two writers, one file: neither update erased the other.
        assert_eq!(load(&path).unwrap(), Some(disabled_until(99)));
    }

    #[test]
    fn a_failed_write_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        // The parent "directory" is a file, so the write cannot succeed.
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, "").unwrap();
        let (store, _) = StateStore::open(Some(blocker.join("state.json")));

        assert!(store.update(|s| s.enabled = false).is_err());
        assert!(
            store.get().enabled,
            "memory must match what a restart would load"
        );
    }

    #[test]
    fn an_update_that_changes_nothing_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let (store, _) = StateStore::open(Some(path.clone()));

        store.update(|s| s.enabled = true).unwrap();
        assert!(!path.exists());
    }
}
