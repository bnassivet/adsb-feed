//! Recording what the OpenSky service publishes: each poll's states and each
//! fetched track, into `opensky_states` and `opensky_tracks`.
//!
//! Both writers use this module -- the recorder here, and an embedded desktop
//! -- so they store identically. Both topics are **not retained**, and each
//! message is a record, so they arrive through `MqttSource::with_aux_stream`
//! (every payload) rather than `with_aux_topic` (latest wins).
//!
//! Never into `positions`: OpenSky's view of an aircraft is kept beside the
//! receiver's own, so coverage, range and statistics stay what this receiver
//! heard.

use adsb_data_engine::{OpenSkyStateRow, OpenSkyTrackRecord, SharedStorage};
use adsb_opensky_server::states::{Match, OpenSkyTrack, StatesMessage, TrackMessage};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

/// The OpenSky service's two record streams, as `MqttSource::with_aux_stream`
/// hands them out.
pub struct OpenSkyStreams {
    pub states: broadcast::Receiver<Vec<u8>>,
    pub tracks: broadcast::Receiver<Vec<u8>>,
}

impl OpenSkyStreams {
    /// Spawns one recording task per stream.
    pub fn spawn(self, storage: SharedStorage) -> [tokio::task::JoinHandle<()>; 2] {
        [
            tokio::spawn(persist_opensky_states(storage.clone(), self.states)),
            tokio::spawn(persist_opensky_tracks(storage, self.tracks)),
        ]
    }
}

/// A poll's states as rows. A state without a position, or without the time
/// it was measured, says nothing worth keeping and is skipped.
pub fn state_rows(message: &StatesMessage) -> Vec<OpenSkyStateRow> {
    message
        .states
        .iter()
        .filter_map(|m| {
            let s = &m.state;
            Some(OpenSkyStateRow {
                icao24: s.icao24.to_lowercase(),
                time_position_s: s.time_position?,
                fetched_ms: message.fetched_ms,
                data_time_s: message.data_time,
                callsign: s.callsign.clone(),
                latitude: s.latitude?,
                longitude: s.longitude?,
                altitude_ft: s.altitude_ft,
                ground_speed_kt: s.ground_speed_kt,
                track_deg: s.track_deg,
                vertical_rate_fpm: s.vertical_rate_fpm,
                on_ground: Some(s.on_ground),
                matched: matched_text(&m.matched),
            })
        })
        .collect()
}

/// Why an aircraft was polled, as stored: `icao24`, `area:<id>`, comma-separated.
fn matched_text(matched: &[Match]) -> String {
    matched
        .iter()
        .map(|m| match m {
            Match::Aircraft => "icao24".to_string(),
            Match::Area { id } => format!("area:{id}"),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// A fetched track as its stored record, the waypoints kept verbatim as JSON.
pub fn track_record(message: &TrackMessage) -> Result<OpenSkyTrackRecord, serde_json::Error> {
    let t = &message.track;
    Ok(OpenSkyTrackRecord {
        icao24: t.icao24.to_lowercase(),
        callsign: t.callsign.clone(),
        start_time_s: t.start_time,
        end_time_s: t.end_time,
        fetched_ms: message.fetched_ms,
        waypoint_count: i32::try_from(t.path.len()).unwrap_or(i32::MAX),
        path_json: serde_json::to_string(&t.path)?,
    })
}

/// The settled stored flight of `icao24` that was in the air at `time_s`, as
/// the track OpenSky returned -- the cache a fetch tries first. `Err` when no
/// storage is open, so the caller can tell "not stored" from "cannot look".
pub async fn find_stored_track(
    storage: &SharedStorage,
    icao24: &str,
    time_s: i64,
) -> Result<Option<OpenSkyTrack>, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| crate::tool_service::STORAGE_UNAVAILABLE.to_string())?;
    let Some(record) = s
        .find_opensky_track(icao24.to_string(), time_s)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let path = serde_json::from_str(&record.path_json)
        .map_err(|e| format!("stored OpenSky track is unreadable: {e}"))?;
    Ok(Some(OpenSkyTrack {
        icao24: record.icao24,
        callsign: record.callsign,
        start_time: record.start_time_s,
        end_time: record.end_time_s,
        path,
    }))
}

/// The next payload, or `None` once the channel is closed. A reader that fell
/// behind loses the oldest messages, says so, and carries on.
async fn next_payload(payloads: &mut broadcast::Receiver<Vec<u8>>, what: &str) -> Option<Vec<u8>> {
    loop {
        match payloads.recv().await {
            Ok(bytes) => return Some(bytes),
            Err(broadcast::error::RecvError::Lagged(n)) => {
                warn!("OpenSky {what} recorder fell behind: {n} message(s) not stored")
            }
            Err(broadcast::error::RecvError::Closed) => return None,
        }
    }
}

/// Stores every poll arriving on `payloads` until the channel closes.
pub async fn persist_opensky_states(
    storage: SharedStorage,
    mut payloads: broadcast::Receiver<Vec<u8>>,
) {
    while let Some(bytes) = next_payload(&mut payloads, "states").await {
        let rows = match StatesMessage::from_json(&bytes) {
            Ok(message) => state_rows(&message),
            Err(e) => {
                warn!("Ignoring OpenSky states payload: {e}");
                continue;
            }
        };
        if rows.is_empty() {
            continue;
        }
        let guard = storage.read().await;
        let Some(s) = guard.as_ref() else {
            warn!("OpenSky states dropped: storage is unavailable");
            continue;
        };
        match s.insert_opensky_states(rows).await {
            Ok(n) => debug!("Recorded {n} new OpenSky state(s)"),
            Err(e) => warn!("Could not store OpenSky states: {e}"),
        }
    }
}

/// Stores every fetched track arriving on `payloads` until the channel closes.
pub async fn persist_opensky_tracks(
    storage: SharedStorage,
    mut payloads: broadcast::Receiver<Vec<u8>>,
) {
    while let Some(bytes) = next_payload(&mut payloads, "tracks").await {
        let record = match TrackMessage::from_json(&bytes).map(|m| track_record(&m)) {
            Ok(Ok(record)) => record,
            Ok(Err(e)) => {
                warn!("Could not encode an OpenSky track: {e}");
                continue;
            }
            Err(e) => {
                warn!("Ignoring OpenSky track payload: {e}");
                continue;
            }
        };
        let guard = storage.read().await;
        let Some(s) = guard.as_ref() else {
            warn!("OpenSky track dropped: storage is unavailable");
            continue;
        };
        let what = format!("{} from {}", record.icao24, record.start_time_s);
        match s.upsert_opensky_track(record).await {
            Ok(true) => info!("Recorded OpenSky track {what}"),
            Ok(false) => debug!("OpenSky track {what}: a more complete copy is already stored"),
            Err(e) => warn!("Could not store OpenSky track {what}: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_data_engine::{StorageConfig, StorageHandle};
    use adsb_opensky_server::states::{MatchedState, OpenSkyState, STATES_VERSION, Waypoint};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn in_memory_storage() -> SharedStorage {
        Arc::new(RwLock::new(Some(
            StorageHandle::open(StorageConfig::default()).expect("open"),
        )))
    }

    fn os_state(icao: &str, time: Option<i64>, lat: Option<f64>) -> OpenSkyState {
        OpenSkyState {
            icao24: icao.into(),
            callsign: Some("DLH9LF".into()),
            origin_country: Some("Germany".into()),
            time_position: time,
            last_contact: time,
            latitude: lat,
            longitude: Some(-2.0),
            altitude_ft: Some(35_000.0),
            geo_altitude_ft: None,
            on_ground: false,
            ground_speed_kt: Some(450.0),
            track_deg: Some(270.0),
            vertical_rate_fpm: Some(-500.0),
            squawk: None,
            position_source: None,
        }
    }

    fn poll(states: Vec<MatchedState>) -> StatesMessage {
        StatesMessage {
            version: STATES_VERSION,
            fetched_ms: 1_764_000_000_500,
            data_time: 1_764_000_000,
            states,
        }
    }

    fn fetched(end: i64, fetched_ms: i64) -> TrackMessage {
        let w = |t: i64| Waypoint {
            time: t,
            latitude: 47.0,
            longitude: -2.0,
            altitude_ft: Some(30_000.0),
            track_deg: None,
            on_ground: false,
        };
        TrackMessage::new(
            fetched_ms,
            OpenSkyTrack {
                icao24: "3c6444".into(),
                callsign: Some("DLH9LF".into()),
                start_time: 1_000,
                end_time: end,
                path: vec![w(1_000), w(end)],
            },
        )
    }

    #[test]
    fn a_poll_becomes_rows_with_why_each_aircraft_was_polled() {
        let rows = state_rows(&poll(vec![
            MatchedState {
                state: os_state("3c6444", Some(1_763_999_995), Some(47.0)),
                matched: vec![Match::Aircraft, Match::Area { id: "west".into() }],
            },
            // No position, or no time it was measured: nothing to keep.
            MatchedState {
                state: os_state("39de4f", Some(1_763_999_990), None),
                matched: vec![Match::Aircraft],
            },
            MatchedState {
                state: os_state("4ca7b2", None, Some(47.0)),
                matched: vec![Match::Aircraft],
            },
        ]));
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(
            (r.icao24.as_str(), r.time_position_s),
            ("3c6444", 1_763_999_995)
        );
        assert_eq!(
            (r.fetched_ms, r.data_time_s),
            (1_764_000_000_500, 1_764_000_000)
        );
        assert_eq!(r.matched, "icao24,area:west");
        assert_eq!(r.on_ground, Some(false));
        assert_eq!(r.vertical_rate_fpm, Some(-500.0));
    }

    #[test]
    fn a_track_keeps_its_waypoints_verbatim() {
        let r = track_record(&fetched(9_000, 20_000_000)).unwrap();
        assert_eq!(
            (r.start_time_s, r.end_time_s, r.fetched_ms),
            (1_000, 9_000, 20_000_000)
        );
        assert_eq!(r.waypoint_count, 2);
        let path: Vec<Waypoint> = serde_json::from_str(&r.path_json).unwrap();
        assert_eq!(path, fetched(9_000, 20_000_000).track.path);
    }

    #[tokio::test]
    async fn every_published_track_is_stored_even_in_a_burst() {
        let storage = in_memory_storage();
        let (tx, rx) = broadcast::channel(8);
        let task = tokio::spawn(persist_opensky_tracks(storage.clone(), rx));
        // Mid-flight, then the finished flight, back to back; and junk between.
        tx.send(serde_json::to_vec(&fetched(5_000, 5_000_000)).unwrap())
            .unwrap();
        tx.send(b"not json".to_vec()).unwrap();
        tx.send(serde_json::to_vec(&fetched(9_000, 20_000_000)).unwrap())
            .unwrap();
        drop(tx);
        task.await.unwrap();
        let guard = storage.read().await;
        let s = guard.as_ref().unwrap();
        let found = s
            .find_opensky_track_sync("3c6444", 8_000)
            .unwrap()
            .expect("stored");
        assert_eq!(found.end_time_s, 9_000);
    }

    #[tokio::test]
    async fn a_stored_flight_reads_back_as_the_track_that_was_fetched() {
        let storage = in_memory_storage();
        let message = fetched(9_000, 20_000_000);
        {
            let guard = storage.read().await;
            let s = guard.as_ref().unwrap();
            s.upsert_opensky_track_sync(&track_record(&message).unwrap())
                .unwrap();
        }
        let found = find_stored_track(&storage, "3C6444", 5_000).await.unwrap();
        assert_eq!(found, Some(message.track));
        assert_eq!(
            find_stored_track(&storage, "3c6444", 10_000).await.unwrap(),
            None
        );
        // No storage is an error, not "not stored": the caller then asks OpenSky.
        let none: SharedStorage = Arc::new(RwLock::new(None));
        assert!(find_stored_track(&none, "3c6444", 5_000).await.is_err());
    }

    #[tokio::test]
    async fn polls_are_stored_as_they_arrive() {
        let storage = in_memory_storage();
        let (tx, rx) = broadcast::channel(8);
        let task = tokio::spawn(persist_opensky_states(storage.clone(), rx));
        let p = poll(vec![MatchedState {
            state: os_state("3c6444", Some(100), Some(47.0)),
            matched: vec![Match::Aircraft],
        }]);
        tx.send(serde_json::to_vec(&p).unwrap()).unwrap();
        tx.send(serde_json::to_vec(&p).unwrap()).unwrap();
        drop(tx);
        task.await.unwrap();
        let guard = storage.read().await;
        let rows = guard
            .as_ref()
            .unwrap()
            .query_opensky_states_sync("3c6444", 0, 1_000)
            .unwrap();
        assert_eq!(rows.len(), 1);
    }
}
