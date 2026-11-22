//! Periodic quarantine of impossible positions, for embedded storage.
//!
//! The desktop is the ingest owner only in embedded mode. In remote mode the
//! daemon owns the observed tables and sweeps them itself; the engine's sweep
//! is a no-op there, so this loop needs no mode check of its own.

use adsb_data_engine::{QuarantineCursor, SharedStorage};
use std::time::Duration;
use tracing::warn;

/// How often the desktop sweeps, matching the daemon's default checkpoint.
pub const QUARANTINE_PERIOD: Duration = Duration::from_secs(300);
/// Lets startup queries (map history preload, DB History) go first: the first
/// sweep covers the whole history and holds the storage lock while it runs.
pub const QUARANTINE_INITIAL_DELAY: Duration = Duration::from_secs(30);

/// Sweep forever. `receiver` is read on every tick, so a location changed in
/// Settings applies without a restart. Storage that is released, or reopened
/// in another mode, is simply picked up on the next tick.
pub async fn run_quarantine(
    storage: SharedStorage,
    receiver: impl Fn() -> Option<(f64, f64)>,
    initial_delay: Duration,
    period: Duration,
) {
    tokio::time::sleep(initial_delay).await;
    let mut cursor = QuarantineCursor::default();
    loop {
        {
            let guard = storage.read().await;
            if let Some(s) = guard.as_ref() {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                // The engine logs what it moved; only a failure is ours to report.
                if let Err(e) = cursor.sweep(s, receiver(), now_ms).await {
                    warn!("Quarantine failed: {e}");
                }
            }
        }
        tokio::time::sleep(period).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_data_engine::{AircraftPosition, StorageConfig, StorageHandle};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::RwLock;

    fn fix(lat: f64, lon: f64, ts: &str) -> AircraftPosition {
        AircraftPosition {
            hex_ident: "Q1".to_string(),
            callsign: None,
            altitude: Some(36000.0),
            ground_speed: None,
            track: None,
            latitude: Some(lat),
            longitude: Some(lon),
            vertical_rate: None,
            squawk: None,
            is_on_ground: None,
            timestamp: ts.to_string(),
            message_count: 0,
        }
    }

    #[tokio::test]
    async fn the_loop_quarantines_with_the_current_receiver() {
        let handle = StorageHandle::open(StorageConfig {
            db_path: None,
            source_id: "desktop".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
            remote: None,
        })
        .unwrap();
        handle
            .insert_batch_sync(
                &[
                    fix(45.50, -73.0, "2024/01/15 10:00:00.000"),
                    fix(83.721, 58.224, "2024/01/15 10:00:09.000"),
                    fix(83.720, 58.214, "2024/01/15 10:00:09.900"),
                    fix(45.52, -73.0, "2024/01/15 10:00:15.000"),
                ],
                "UTC",
            )
            .unwrap();
        let storage = Arc::new(RwLock::new(Some(handle)));

        let task = tokio::spawn(run_quarantine(
            Arc::clone(&storage),
            || Some((45.0, -73.0)),
            Duration::ZERO,
            Duration::from_millis(20),
        ));
        tokio::time::sleep(Duration::from_millis(300)).await;
        task.abort();

        let guard = storage.read().await;
        let page = guard
            .as_ref()
            .unwrap()
            .get_rejected_positions_sync(Default::default())
            .unwrap();
        assert_eq!(page.total, 2);
    }

    #[tokio::test]
    async fn the_loop_survives_released_storage() {
        let storage: adsb_data_engine::SharedStorage = Arc::new(RwLock::new(None));
        let task = tokio::spawn(run_quarantine(
            storage,
            || None,
            Duration::ZERO,
            Duration::from_millis(10),
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !task.is_finished(),
            "released storage must not end the loop"
        );
        task.abort();
    }
}
