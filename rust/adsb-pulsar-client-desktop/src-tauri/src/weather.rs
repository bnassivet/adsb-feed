//! Weather snapshots arriving on the MQTT aux topic.
//!
//! Payloads are decoded and validated here, in Rust, so a malformed or foreign
//! message never reaches the webview. The last good snapshot is held in state
//! and re-served to a late-mounting UI through `get_weather_snapshot`.

use adsb_pulsar_client::SourceKind;
use adsb_weather_server::WeatherSnapshot;
use serde::Serialize;
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use tracing::{info, warn};

/// Last good snapshot, shared by the relay task and the commands.
pub type SharedWeather = Arc<RwLock<Option<WeatherSnapshot>>>;

/// What the weather layer can show, so the UI can explain an empty layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WeatherAvailability {
    /// A snapshot is held. It may be stale; the UI judges that from
    /// `valid_time_ms`.
    Available,
    /// MQTT is the live source, but no snapshot has arrived yet.
    Waiting,
    /// Weather only travels over MQTT, and the live source is the socket.
    UnsupportedSource,
}

/// What to do with an incoming payload.
#[derive(Debug, Clone, PartialEq)]
pub enum WeatherUpdate {
    /// A valid snapshot that differs from the one held: store it and emit it.
    /// Boxed: a snapshot dwarfs the other variants.
    Replace(Box<WeatherSnapshot>),
    /// Identical to the one held -- a retained re-delivery after a reconnect.
    Unchanged,
    /// Rejected; the held snapshot stays. Carries the reason for the log.
    Rejected(String),
}

/// Classifies the layer's state for the UI.
pub fn availability(source_kind: SourceKind, has_snapshot: bool) -> WeatherAvailability {
    match (source_kind, has_snapshot) {
        (SourceKind::Socket, _) => WeatherAvailability::UnsupportedSource,
        (SourceKind::Mqtt, true) => WeatherAvailability::Available,
        (SourceKind::Mqtt, false) => WeatherAvailability::Waiting,
    }
}

/// Decides what an incoming payload does to the held snapshot.
pub fn next_update(current: Option<&WeatherSnapshot>, payload: &[u8]) -> WeatherUpdate {
    match WeatherSnapshot::from_json(payload) {
        Ok(snapshot) if current == Some(&snapshot) => WeatherUpdate::Unchanged,
        Ok(snapshot) => WeatherUpdate::Replace(Box::new(snapshot)),
        Err(e) => WeatherUpdate::Rejected(e.to_string()),
    }
}

/// Relays aux-topic payloads into state and the webview until the feed stops.
///
/// Ends when the feed's client task exits (its `alive` sender drops) or the
/// source goes away, like the bridge's other background tasks.
pub async fn relay_weather(
    app: AppHandle,
    mut payloads: watch::Receiver<Option<Vec<u8>>>,
    shared: SharedWeather,
    mut alive_rx: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = payloads.changed() => {
                if changed.is_err() {
                    break;
                }
                let Some(payload) = payloads.borrow_and_update().clone() else {
                    continue;
                };
                // Decide under a read guard; nothing here awaits.
                let update = match shared.read() {
                    Ok(held) => next_update(held.as_ref(), &payload),
                    Err(_) => next_update(None, &payload),
                };
                match update {
                    WeatherUpdate::Replace(snapshot) => {
                        info!(
                            "Weather snapshot received: {} points, {} levels, valid at {} ms",
                            snapshot.grid.len(),
                            snapshot.levels.len(),
                            snapshot.valid_time_ms
                        );
                        if let Ok(mut held) = shared.write() {
                            *held = Some((*snapshot).clone());
                        }
                        let _ = app.emit("adsb:weather", &snapshot);
                    }
                    WeatherUpdate::Unchanged => {}
                    WeatherUpdate::Rejected(reason) => {
                        warn!("Ignoring weather payload, keeping the last good snapshot: {reason}");
                    }
                }
            }
            _ = alive_rx.changed() => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_weather_server::GridSpec;
    use adsb_weather_server::snapshot::{SNAPSHOT_VERSION, SurfaceFields};
    use std::collections::BTreeMap;

    fn snapshot(mslp: f32) -> WeatherSnapshot {
        WeatherSnapshot {
            version: SNAPSHOT_VERSION,
            source: "open-meteo".into(),
            attribution: "Weather data by Open-Meteo.com (CC BY 4.0)".into(),
            model: "best_match".into(),
            fetched_at_ms: 1,
            valid_time_ms: 2,
            grid: GridSpec {
                lat0: 47.0,
                lon0: -2.0,
                dlat: 1.0,
                dlon: 1.0,
                nlat: 1,
                nlon: 1,
            },
            surface: SurfaceFields {
                mslp_hpa: vec![Some(mslp)],
                wind_speed_kt: vec![None],
                wind_dir_deg: vec![None],
            },
            levels: BTreeMap::new(),
        }
    }

    fn payload(snap: &WeatherSnapshot) -> Vec<u8> {
        serde_json::to_vec(snap).unwrap()
    }

    #[test]
    fn mqtt_with_a_snapshot_is_available() {
        assert_eq!(
            availability(SourceKind::Mqtt, true),
            WeatherAvailability::Available
        );
    }

    #[test]
    fn mqtt_without_a_snapshot_is_waiting() {
        assert_eq!(
            availability(SourceKind::Mqtt, false),
            WeatherAvailability::Waiting
        );
    }

    #[test]
    fn the_socket_source_is_unsupported_even_with_a_held_snapshot() {
        // A snapshot kept from an earlier MQTT session must not make a socket
        // session look like it is receiving weather.
        assert_eq!(
            availability(SourceKind::Socket, true),
            WeatherAvailability::UnsupportedSource
        );
    }

    #[test]
    fn availability_serialises_as_snake_case() {
        // The TypeScript union matches on these strings.
        assert_eq!(
            serde_json::to_value(WeatherAvailability::UnsupportedSource).unwrap(),
            "unsupported_source"
        );
    }

    #[test]
    fn the_first_valid_snapshot_replaces_nothing() {
        let snap = snapshot(1013.0);
        assert_eq!(
            next_update(None, &payload(&snap)),
            WeatherUpdate::Replace(Box::new(snap))
        );
    }

    #[test]
    fn a_different_snapshot_replaces_the_held_one() {
        let held = snapshot(1013.0);
        let newer = snapshot(1009.0);
        assert_eq!(
            next_update(Some(&held), &payload(&newer)),
            WeatherUpdate::Replace(Box::new(newer))
        );
    }

    #[test]
    fn a_retained_redelivery_is_unchanged() {
        // Every reconnect re-delivers the retained message; re-emitting it
        // would re-render the layer for nothing.
        let held = snapshot(1013.0);
        assert_eq!(
            next_update(Some(&held), &payload(&held)),
            WeatherUpdate::Unchanged
        );
    }

    #[test]
    fn malformed_json_is_rejected() {
        let held = snapshot(1013.0);
        assert!(matches!(
            next_update(Some(&held), b"{\"version\": 1, \"trunc"),
            WeatherUpdate::Rejected(_)
        ));
    }

    #[test]
    fn a_snapshot_that_fails_validation_is_rejected() {
        let mut bad = snapshot(1013.0);
        bad.surface.mslp_hpa.push(Some(1000.0));
        match next_update(None, &payload(&bad)) {
            WeatherUpdate::Rejected(reason) => assert!(reason.contains("mslp_hpa"), "{reason}"),
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[test]
    fn sbs_lines_on_the_weather_topic_are_rejected() {
        assert!(matches!(
            next_update(None, b"MSG,3,1,1,4CA2D6,1,2026/09/14,12:00:00.000"),
            WeatherUpdate::Rejected(_)
        ));
    }
}
