//! The command side: the operator's enabled setting.
//!
//! This is the only writer of the *desired* state. It never touches what the
//! refresh loop reports: a command changes what the service should do, and
//! the status topic shows what it is doing once it has done it.

use crate::state_file::{StateFileError, StateStore};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// Accepts enable/disable commands.
#[derive(Debug)]
pub struct Control {
    store: Arc<StateStore>,
    desired: watch::Sender<bool>,
    /// Serialises commands, so two racing ones cannot leave the file saying
    /// one thing and the channel the other.
    commands: Mutex<()>,
}

impl Control {
    /// Starts from the setting the store holds.
    pub fn new(store: Arc<StateStore>) -> Self {
        let (desired, _) = watch::channel(store.get().enabled);
        Self {
            store,
            desired,
            commands: Mutex::new(()),
        }
    }

    /// The desired setting, for the refresh loop and the status projection.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.desired.subscribe()
    }

    /// The desired setting now.
    pub fn enabled(&self) -> bool {
        *self.desired.borrow()
    }

    /// Sets the desired state. Idempotent.
    ///
    /// Persisted first: if the write fails, nothing changes and the error is
    /// returned, so the service never acts on a setting a restart would lose.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), StateFileError> {
        let _serialised = self.commands.lock().unwrap_or_else(|e| e.into_inner());
        self.store.update(|s| s.enabled = enabled)?;
        // Only a real change wakes the subscribers: repeating a command must
        // not look like a new one to the refresh loop.
        self.desired.send_if_modified(|current| {
            let changed = *current != enabled;
            *current = enabled;
            changed
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_file;

    #[test]
    fn starts_from_the_stored_setting() {
        let store = Arc::new(StateStore::in_memory());
        store.update(|s| s.enabled = false).unwrap();
        assert!(!Control::new(store).enabled());
    }

    #[tokio::test]
    async fn disabling_is_persisted_then_published() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let (store, _) = StateStore::open(Some(path.clone()));
        let control = Control::new(Arc::new(store));
        let mut rx = control.subscribe();

        control.set_enabled(false).unwrap();

        rx.changed().await.unwrap();
        assert!(!*rx.borrow());
        assert!(!state_file::load(&path).unwrap().unwrap().enabled);
    }

    #[test]
    fn repeating_a_command_does_not_wake_subscribers() {
        let control = Control::new(Arc::new(StateStore::in_memory()));
        let rx = control.subscribe();

        control.set_enabled(true).unwrap();
        assert!(!rx.has_changed().unwrap());
    }

    #[test]
    fn a_failed_write_is_an_error_and_nothing_is_published() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, "").unwrap();
        let (store, _) = StateStore::open(Some(blocker.join("state.json")));
        let control = Control::new(Arc::new(store));
        let rx = control.subscribe();

        assert!(control.set_enabled(false).is_err());
        assert!(control.enabled());
        assert!(!rx.has_changed().unwrap());
    }
}
