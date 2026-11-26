//! OpenSky polls and service status arriving over MQTT.
//!
//! The OpenSky service publishes each poll (not retained) and its status and
//! availability (retained) beside the feed. Payloads are decoded here, in Rust,
//! so a malformed message never reaches the webview.
//!
//! **Nothing here touches the ingest pipeline.** OpenSky positions never enter
//! `positions`: coverage and range statistics stay what this receiver heard.
//! An embedded desktop records them, and each fetched track, in their own
//! tables (`opensky_states`, `opensky_tracks`) through the data server's
//! `opensky` module, so both writers store identically. The relay emits its
//! own events.

use adsb_opensky_server::api::{Area, DEFAULT_HTTP_PORT, WatchRequest};
use adsb_opensky_server::states::{OpenSkyTrack, StatesMessage};
use adsb_opensky_server::status::{Availability, OpenSkyStatus};
use adsb_pulsar_client::Config;
use serde::Serialize;
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use tracing::{info, warn};

/// The OpenSky service, as the desktop last heard it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OpenSkyServiceView {
    pub status: Option<OpenSkyStatus>,
    pub availability: Option<Availability>,
}

/// What the relay keeps, outliving a feed restart.
#[derive(Debug, Clone, Default)]
pub struct OpenSkyShared {
    /// The last poll: answers a UI that mounts between two polls.
    pub states: Arc<RwLock<Option<StatesMessage>>>,
    pub service: Arc<RwLock<OpenSkyServiceView>>,
}

/// Where the OpenSky service's control API is: an explicit
/// `opensky_api_url`, else beside the broker on the default port.
pub fn opensky_api_url(config: &Config) -> String {
    let explicit = config.opensky_api_url.trim();
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    format!("http://{}:{DEFAULT_HTTP_PORT}", config.mqtt_broker)
}

/// The id this desktop's watch list is leased under. Its own: two desktops
/// on one stack keep separate lists, and the service polls their union.
pub fn watch_client_id(config: &Config) -> String {
    let id: String = config
        .source_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .take(56)
        .collect();
    format!("{id}-desktop")
}

/// The watch request for what the UI asked. Validation is the service's: it
/// answers 400 with the reason, which reaches the UI as the error.
pub fn watch_request(icao24: Vec<String>, areas: Vec<Area>) -> WatchRequest {
    WatchRequest { icao24, areas }
}

/// Whether this desktop records what OpenSky publishes: only with its own
/// database (in remote mode the data server is the writer, and a write through
/// the Quack views would fail), unless `ADSB_OPENSKY_RECORD` says no.
pub fn records_opensky(mode: &crate::storage_mode::StorageMode, env: Option<&str>) -> bool {
    let off = env.is_some_and(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "false" | "0" | "no" | "off"
        )
    });
    matches!(mode, crate::storage_mode::StorageMode::Embedded) && !off
}

/// A track for the UI, and whether it came from storage (no credits spent).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrackReply {
    pub track: Option<OpenSkyTrack>,
    pub stored: bool,
}

/// Serves a past flight from storage when it is there, else fetches it.
/// `time = None` asks for the live flight, which is still growing: never from
/// storage. A storage error is not a failure: OpenSky is asked instead.
pub async fn cache_first<F, Fut>(
    time: Option<i64>,
    stored: Result<Option<OpenSkyTrack>, String>,
    fetch: F,
) -> Result<TrackReply, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Option<OpenSkyTrack>, String>>,
{
    if time.is_some()
        && let Ok(Some(track)) = stored
    {
        return Ok(TrackReply {
            track: Some(track),
            stored: true,
        });
    }
    Ok(TrackReply {
        track: fetch().await?,
        stored: false,
    })
}

/// A payload from one of the service's topics.
#[derive(Debug, Clone, PartialEq)]
pub enum Payload {
    States(Vec<u8>),
    Status(Vec<u8>),
    Availability(Vec<u8>),
}

/// What a payload changed, for the relay to emit.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    States(Box<StatesMessage>),
    Service(OpenSkyServiceView),
    Nothing,
}

/// Applies a payload. An empty status or availability clears that half (a
/// cleared retained message); an empty poll is ignored. Anything unparseable
/// is an error and changes nothing.
pub fn apply(shared: &OpenSkyShared, payload: Payload) -> Result<Change, String> {
    match payload {
        Payload::States(bytes) => {
            if bytes.is_empty() {
                return Ok(Change::Nothing);
            }
            let message = StatesMessage::from_json(&bytes).map_err(|e| e.to_string())?;
            if let Ok(mut held) = shared.states.write() {
                *held = Some(message.clone());
            }
            Ok(Change::States(Box::new(message)))
        }
        Payload::Status(bytes) => {
            let next = if bytes.is_empty() {
                None
            } else {
                Some(OpenSkyStatus::from_json(&bytes).map_err(|e| e.to_string())?)
            };
            update_view(shared, |v| {
                let changed = v.status != next;
                v.status = next;
                changed
            })
        }
        Payload::Availability(bytes) => {
            let next = if bytes.is_empty() {
                None
            } else {
                Some(Availability::parse(&bytes).ok_or_else(|| {
                    format!(
                        "unrecognised availability payload '{}'",
                        String::from_utf8_lossy(&bytes)
                    )
                })?)
            };
            update_view(shared, |v| {
                let changed = v.availability != next;
                v.availability = next;
                changed
            })
        }
    }
}

fn update_view(
    shared: &OpenSkyShared,
    change: impl FnOnce(&mut OpenSkyServiceView) -> bool,
) -> Result<Change, String> {
    let mut view = shared.service.write().map_err(|e| e.to_string())?;
    Ok(if change(&mut view) {
        Change::Service(view.clone())
    } else {
        Change::Nothing
    })
}

/// The three receivers the bridge hands the relay.
pub struct OpenSkyReceivers {
    pub states: watch::Receiver<Option<Vec<u8>>>,
    pub status: watch::Receiver<Option<Vec<u8>>>,
    pub availability: watch::Receiver<Option<Vec<u8>>>,
}

/// Relays polls and status into state and the webview until the feed stops.
/// Emits `adsb:opensky` per poll and `adsb:opensky-service` on a real change.
pub async fn relay(
    app: AppHandle,
    mut rx: OpenSkyReceivers,
    shared: OpenSkyShared,
    mut alive_rx: watch::Receiver<bool>,
) {
    loop {
        let payload = tokio::select! {
            changed = rx.states.changed() => {
                if changed.is_err() { break; }
                match rx.states.borrow_and_update().clone() {
                    Some(b) => Payload::States(b),
                    None => continue,
                }
            }
            changed = rx.status.changed() => {
                if changed.is_err() { break; }
                match rx.status.borrow_and_update().clone() {
                    Some(b) => Payload::Status(b),
                    None => continue,
                }
            }
            changed = rx.availability.changed() => {
                if changed.is_err() { break; }
                match rx.availability.borrow_and_update().clone() {
                    Some(b) => Payload::Availability(b),
                    None => continue,
                }
            }
            _ = alive_rx.changed() => break,
        };
        match apply(&shared, payload) {
            Ok(Change::States(message)) => {
                let _ = app.emit("adsb:opensky", &*message);
            }
            Ok(Change::Service(view)) => {
                let state = view
                    .status
                    .as_ref()
                    .and_then(|s| serde_json::to_value(s.state).ok())
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "no status".into());
                info!(
                    "OpenSky service: {state}, availability: {:?}",
                    view.availability
                );
                let _ = app.emit("adsb:opensky-service", &view);
            }
            Ok(Change::Nothing) => {}
            Err(reason) => warn!("Ignoring OpenSky payload: {reason}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_opensky_server::states::STATES_VERSION;

    #[test]
    fn only_an_embedded_desktop_records_and_the_env_can_turn_it_off() {
        use crate::storage_mode::StorageMode;
        let remote = StorageMode::Remote {
            uri: "quack:pi:9494".into(),
            token: None,
            disable_ssl: None,
        };
        assert!(records_opensky(&StorageMode::Embedded, None));
        assert!(records_opensky(&StorageMode::Embedded, Some("true")));
        // The data server is the writer; a write through Quack views would fail.
        assert!(!records_opensky(&remote, None));
        for off in ["false", "0", "no", "off", " FALSE "] {
            assert!(!records_opensky(&StorageMode::Embedded, Some(off)), "{off}");
        }
    }

    fn a_track() -> OpenSkyTrack {
        OpenSkyTrack {
            icao24: "3c6444".into(),
            callsign: None,
            start_time: 1,
            end_time: 2,
            path: vec![],
        }
    }

    #[tokio::test]
    async fn a_stored_flight_is_served_without_asking_opensky() {
        let reply = cache_first(Some(1_000), Ok(Some(a_track())), || async {
            panic!("must not fetch")
        })
        .await
        .unwrap();
        assert_eq!(
            reply,
            TrackReply {
                track: Some(a_track()),
                stored: true
            }
        );
    }

    #[tokio::test]
    async fn otherwise_opensky_is_asked() {
        let fetch = || async { Ok(Some(a_track())) };
        let fetched = TrackReply {
            track: Some(a_track()),
            stored: false,
        };
        // Not stored, or no storage to look in.
        assert_eq!(
            cache_first(Some(1_000), Ok(None), fetch).await.unwrap(),
            fetched
        );
        assert_eq!(
            cache_first(Some(1_000), Err("Storage not available".into()), fetch)
                .await
                .unwrap(),
            fetched
        );
        // A live flight is never served from storage: it is still growing.
        assert_eq!(
            cache_first(None, Ok(Some(a_track())), fetch).await.unwrap(),
            fetched
        );
    }

    fn config(broker: &str, url: &str) -> Config {
        Config {
            mqtt_broker: broker.into(),
            opensky_api_url: url.into(),
            ..Config::default()
        }
    }

    #[test]
    fn the_api_is_beside_the_broker_unless_named() {
        assert_eq!(
            opensky_api_url(&config("pi-roof.lan", "")),
            "http://pi-roof.lan:8791"
        );
        assert_eq!(
            opensky_api_url(&config("x", " http://127.0.0.1:9000 ")),
            "http://127.0.0.1:9000"
        );
    }

    #[test]
    fn the_watch_client_id_is_this_desktop_s_and_path_safe() {
        let c = Config {
            source_id: "dev laptop/dev".into(),
            ..Config::default()
        };
        assert_eq!(watch_client_id(&c), "dev-laptop-dev-desktop");
    }

    fn poll() -> Vec<u8> {
        serde_json::to_vec(&StatesMessage {
            version: STATES_VERSION,
            fetched_ms: 1,
            data_time: 2,
            states: vec![],
        })
        .unwrap()
    }

    #[test]
    fn a_poll_is_held_and_emitted() {
        let shared = OpenSkyShared::default();
        let change = apply(&shared, Payload::States(poll())).unwrap();
        assert!(matches!(change, Change::States(_)));
        assert_eq!(
            shared.states.read().unwrap().as_ref().unwrap().fetched_ms,
            1
        );
    }

    #[test]
    fn a_malformed_poll_is_rejected_and_the_last_one_kept() {
        let shared = OpenSkyShared::default();
        apply(&shared, Payload::States(poll())).unwrap();
        assert!(apply(&shared, Payload::States(b"{nope".to_vec())).is_err());
        assert!(shared.states.read().unwrap().is_some());
    }

    #[test]
    fn availability_changes_once_and_repeats_are_quiet() {
        let shared = OpenSkyShared::default();
        let first = apply(&shared, Payload::Availability(b"online".to_vec())).unwrap();
        assert!(
            matches!(first, Change::Service(ref v) if v.availability == Some(Availability::Online))
        );
        let again = apply(&shared, Payload::Availability(b"online".to_vec())).unwrap();
        assert_eq!(again, Change::Nothing);
        assert!(apply(&shared, Payload::Availability(b"maybe".to_vec())).is_err());
    }

    #[test]
    fn a_status_is_decoded_and_an_empty_one_clears_it() {
        let shared = OpenSkyShared::default();
        let status = serde_json::to_vec(&OpenSkyStatus::initial(true, true, 4000, 5)).unwrap();
        assert!(matches!(
            apply(&shared, Payload::Status(status)).unwrap(),
            Change::Service(_)
        ));
        assert!(matches!(
            apply(&shared, Payload::Status(vec![])).unwrap(),
            Change::Service(ref v) if v.status.is_none()
        ));
    }
}
