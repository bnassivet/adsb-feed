//! Recording the weather grid the weather service publishes.
//!
//! The service publishes one **retained** snapshot an hour to its own MQTT
//! topic. The recorder subscribes to that topic on the connection it already
//! has for the live SBS feed (`MqttSource::with_aux_topic`) and stores each
//! distinct model hour.
//!
//! The recorder is the writer because DuckDB takes an exclusive file lock and
//! this process holds it — `adsb-weather-server` could not write to the
//! database even if it wanted to, which is also why the two talk over MQTT
//! rather than sharing a file.
//!
//! Retained means the broker re-delivers the message on **every** reconnect, so
//! "we already have this one" is the ordinary case rather than an error. It is
//! caught twice: here, against the last hour stored, and authoritatively in the
//! database's anti-join, which also survives a restart.

use adsb_data_engine::{SharedStorage, WeatherSnapshotRecord};
use adsb_weather_server::WeatherSnapshot;
use tokio::sync::watch;
use tracing::{info, warn};

/// What an incoming payload should do.
#[derive(Debug, Clone, PartialEq)]
pub enum WeatherAction {
    /// A model hour we do not have. Boxed: a snapshot dwarfs the other
    /// variants, and an un-boxed one would bloat every value of this enum.
    Store(Box<WeatherSnapshot>),
    /// The model hour last stored — a retained re-delivery after a reconnect.
    Duplicate,
    /// An empty payload, which is how a retained message is cleared. A no-op:
    /// never an error, and never a reason to delete what was already recorded.
    Cleared,
    /// Unusable. Carries the reason for the log; nothing is stored.
    Rejected(String),
}

/// Decides what to do with a payload from the weather topic.
///
/// Keyed on `valid_time_ms` rather than on whole-snapshot equality, which is
/// what the desktop relay compares. The desktop holds a snapshot to draw and
/// cares whether any field changed; the recorder stores one row per model hour
/// and cares only which hour this is.
pub fn next_weather(last_valid_time_ms: Option<i64>, payload: &[u8]) -> WeatherAction {
    if payload.is_empty() {
        return WeatherAction::Cleared;
    }
    match WeatherSnapshot::from_json(payload) {
        Ok(snapshot) if Some(snapshot.valid_time_ms) == last_valid_time_ms => {
            WeatherAction::Duplicate
        }
        Ok(snapshot) => WeatherAction::Store(Box::new(snapshot)),
        Err(e) => WeatherAction::Rejected(e.to_string()),
    }
}

/// Builds the stored row: metadata lifted out of the snapshot, payload verbatim.
///
/// `payload` is the bytes as received, **not** a re-serialisation of `snapshot`.
/// Round-tripping through serde would be free to reorder keys or reformat
/// numbers, and the point of the payload column is that a replay is identical
/// to what was published.
///
/// `source_id` is left empty: the storage layer stamps its own, exactly as it
/// does for raw SBS messages, so a recorder can only ever claim its own
/// identity.
pub fn record_from_snapshot(
    snapshot: &WeatherSnapshot,
    payload: &[u8],
    received_at_ms: i64,
) -> WeatherSnapshotRecord {
    WeatherSnapshotRecord {
        source_id: String::new(),
        valid_time_ms: snapshot.valid_time_ms,
        fetched_at_ms: snapshot.fetched_at_ms,
        received_at_ms,
        source: snapshot.source.clone(),
        model: snapshot.model.clone(),
        version: snapshot.version,
        lat0: snapshot.grid.lat0,
        lon0: snapshot.grid.lon0,
        dlat: snapshot.grid.dlat,
        dlon: snapshot.grid.dlon,
        nlat: snapshot.grid.nlat as u32,
        nlon: snapshot.grid.nlon as u32,
        // BTreeMap iterates ascending, so the levels are ordered without
        // sorting them here.
        levels: snapshot
            .levels
            .keys()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join(","),
        payload: String::from_utf8_lossy(payload).into_owned(),
    }
}

/// Records every distinct snapshot arriving on the weather topic.
///
/// Runs until the channel closes. Nothing here is fatal: a storage failure is
/// logged and the next snapshot is still attempted, because a recorder that
/// stopped recording weather on one bad write would also stop noticing when
/// weather came back.
pub async fn persist_weather(
    storage: SharedStorage,
    mut payloads: watch::Receiver<Option<Vec<u8>>>,
) {
    let mut last_valid_time_ms: Option<i64> = None;

    while payloads.changed().await.is_ok() {
        // Cloned out of the guard before any await: `watch::Ref` is not `Send`,
        // so holding it across one would not compile — and would hold a read
        // lock on the channel while we wait on the database.
        let payload = match payloads.borrow_and_update().clone() {
            Some(bytes) => bytes,
            None => continue,
        };

        match next_weather(last_valid_time_ms, &payload) {
            WeatherAction::Store(snapshot) => {
                let record = record_from_snapshot(&snapshot, &payload, now_ms());
                let guard = storage.read().await;
                let Some(s) = guard.as_ref() else {
                    warn!("Weather snapshot dropped: storage is unavailable");
                    continue;
                };
                match s.insert_weather_snapshot(record).await {
                    Ok(stored) => {
                        // Remember the hour either way: whether this process
                        // wrote it or a previous run did, we have it now.
                        last_valid_time_ms = Some(snapshot.valid_time_ms);
                        if stored {
                            info!(
                                "Recorded weather snapshot for model hour {}",
                                snapshot.valid_time_ms
                            );
                        }
                    }
                    Err(e) => warn!("Could not store weather snapshot: {e}"),
                }
            }
            WeatherAction::Rejected(reason) => {
                warn!("Ignoring weather payload: {reason}")
            }
            WeatherAction::Duplicate | WeatherAction::Cleared => {}
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_data_engine::{StorageConfig, StorageHandle, WeatherSnapshotQuery};
    use adsb_weather_server::grid::GridSpec;
    use adsb_weather_server::snapshot::{LevelFields, SurfaceFields};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn sample_snapshot(valid_time_ms: i64) -> WeatherSnapshot {
        let n = 6;
        let mut levels = BTreeMap::new();
        // Inserted out of order on purpose: the stored `levels` string must
        // come back ascending, which is BTreeMap order, not insertion order.
        for level in [850u16, 250, 500] {
            levels.insert(
                level,
                LevelFields {
                    wind_speed_kt: vec![Some(120.0); n],
                    wind_dir_deg: vec![Some(270.0); n],
                },
            );
        }
        WeatherSnapshot {
            version: 1,
            source: "open-meteo".into(),
            attribution: "Weather data by Open-Meteo.com (CC BY 4.0)".into(),
            model: "best_match".into(),
            fetched_at_ms: valid_time_ms + 7 * 60_000,
            valid_time_ms,
            grid: GridSpec {
                lat0: 46.0,
                lon0: -3.0,
                dlat: 1.0,
                dlon: 1.0,
                nlat: 2,
                nlon: 3,
            },
            surface: SurfaceFields {
                mslp_hpa: vec![Some(1013.2); n],
                wind_speed_kt: vec![Some(8.0); n],
                wind_dir_deg: vec![None; n],
            },
            levels,
        }
    }

    fn payload_of(snapshot: &WeatherSnapshot) -> Vec<u8> {
        serde_json::to_vec(snapshot).unwrap()
    }

    fn in_memory_storage() -> SharedStorage {
        let handle = StorageHandle::open(StorageConfig {
            db_path: None,
            source_id: "test-edge".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
            remote: None,
        })
        .expect("open");
        Arc::new(RwLock::new(Some(handle)))
    }

    #[test]
    fn a_snapshot_becomes_a_record_with_its_metadata() {
        let snapshot = sample_snapshot(1_789_000_000_000);
        let payload = payload_of(&snapshot);
        let record = record_from_snapshot(&snapshot, &payload, 1_789_000_500_000);

        assert_eq!(record.valid_time_ms, 1_789_000_000_000);
        assert_eq!(record.fetched_at_ms, snapshot.fetched_at_ms);
        assert_eq!(record.received_at_ms, 1_789_000_500_000);
        assert_eq!(record.source, "open-meteo");
        assert_eq!(record.model, "best_match");
        assert_eq!(record.version, 1);
        assert_eq!(record.nlat, 2);
        assert_eq!(record.nlon, 3);
        assert_eq!(record.lat0, 46.0);
        assert_eq!(record.levels, "250,500,850", "levels are stored ascending");
        // The storage layer stamps the receiver identity; this function must
        // not invent one.
        assert!(record.source_id.is_empty());
    }

    #[test]
    fn the_payload_is_the_bytes_received_not_a_reserialisation() {
        // A snapshot round-tripped through serde could come back with keys in
        // another order. Whatever was published is what gets stored.
        let snapshot = sample_snapshot(1_789_000_000_000);
        let wire = br#"{"version":1,"source":"open-meteo","spacing":"  odd  "}"#;
        let record = record_from_snapshot(&snapshot, wire, 0);
        assert_eq!(record.payload.as_bytes(), wire);
    }

    #[test]
    fn an_empty_payload_is_a_cleared_retained_message() {
        // Publishing an empty retained message is how a topic is cleared. It
        // must not look like a parse failure, and must never delete anything.
        assert_eq!(next_weather(Some(1), b""), WeatherAction::Cleared);
    }

    #[test]
    fn the_same_model_hour_again_is_a_duplicate() {
        // Every ConnAck re-delivers the retained message.
        let snapshot = sample_snapshot(1_789_000_000_000);
        let action = next_weather(Some(1_789_000_000_000), &payload_of(&snapshot));
        assert_eq!(action, WeatherAction::Duplicate);
    }

    #[test]
    fn a_newer_model_hour_is_stored() {
        let snapshot = sample_snapshot(1_789_003_600_000);
        match next_weather(Some(1_789_000_000_000), &payload_of(&snapshot)) {
            WeatherAction::Store(s) => assert_eq!(s.valid_time_ms, 1_789_003_600_000),
            other => panic!("expected Store, got {other:?}"),
        }
    }

    #[test]
    fn the_first_snapshot_of_a_run_is_stored() {
        let snapshot = sample_snapshot(1_789_000_000_000);
        assert!(matches!(
            next_weather(None, &payload_of(&snapshot)),
            WeatherAction::Store(_)
        ));
    }

    #[test]
    fn a_wrong_version_payload_is_rejected() {
        // A recorder older than the weather service would see this on every
        // publish, so the reason has to reach the log.
        let mut snapshot = sample_snapshot(1_789_000_000_000);
        snapshot.version = 99;
        match next_weather(None, &payload_of(&snapshot)) {
            WeatherAction::Rejected(reason) => assert!(
                reason.contains("version"),
                "the reason must name the version: {reason}"
            ),
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[test]
    fn an_sbs_line_on_the_weather_topic_is_rejected_not_a_panic() {
        assert!(matches!(
            next_weather(None, b"MSG,3,1,1,A1B2C3,1"),
            WeatherAction::Rejected(_)
        ));
    }

    #[tokio::test]
    async fn the_persist_task_stores_one_snapshot_per_model_hour() {
        let storage = in_memory_storage();
        let (tx, rx) = watch::channel(None);
        let task = tokio::spawn(persist_weather(storage.clone(), rx));

        let first = payload_of(&sample_snapshot(1_789_000_000_000));
        // The same retained message three times, as three reconnects deliver it.
        for _ in 0..3 {
            tx.send(Some(first.clone())).unwrap();
            tokio::task::yield_now().await;
        }
        tx.send(Some(payload_of(&sample_snapshot(1_789_003_600_000))))
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        task.abort();

        let guard = storage.read().await;
        let rows = guard
            .as_ref()
            .unwrap()
            .query_weather_snapshots_sync(&WeatherSnapshotQuery::default())
            .unwrap();
        assert_eq!(rows.len(), 2, "one row per model hour, not per delivery");
        assert_eq!(
            rows[0].source_id, "test-edge",
            "storage stamps the identity"
        );
    }

    #[tokio::test]
    async fn a_storage_failure_does_not_end_the_persist_task() {
        // Storage released (None) is the degraded mode the desktop runs in, and
        // a recorder must survive it rather than silently stopping.
        let storage: SharedStorage = Arc::new(RwLock::new(None));
        let (tx, rx) = watch::channel(None);
        let task = tokio::spawn(persist_weather(storage, rx));

        tx.send(Some(payload_of(&sample_snapshot(1_789_000_000_000))))
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert!(!task.is_finished(), "the task must still be listening");
        task.abort();
    }
}
