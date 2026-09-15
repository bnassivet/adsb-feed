//! Weather snapshots arriving on the MQTT aux topic.
//!
//! Payloads are decoded and validated here, in Rust, so a malformed or foreign
//! message never reaches the webview. The last good snapshot is held in state
//! and re-served to a late-mounting UI through `get_weather_snapshot`.

use adsb_pulsar_client::{Config, SourceKind};
use adsb_weather_server::WeatherSnapshot;
use adsb_weather_server::api::DEFAULT_HTTP_PORT;
use adsb_weather_server::status::{Availability, WeatherStatus};
use serde::Serialize;
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use tracing::{info, warn};

/// Last good snapshot, shared by the relay task and the commands.
pub type SharedWeather = Arc<RwLock<Option<WeatherSnapshot>>>;

/// What the desktop last heard from the weather service itself.
///
/// The query side of the service's control plane, as the desktop sees it.
/// Written only by [`relay_weather_service`], from the retained MQTT topics:
/// never by the enable/disable command, whose effect shows up here when the
/// service reports it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct WeatherServiceView {
    /// The service's last published status: what it wants and what it does.
    pub status: Option<WeatherStatus>,
    /// Whether its publisher is connected: `offline` is its MQTT last will.
    pub availability: Option<Availability>,
}

/// The weather service view, shared by its relay task and the commands.
pub type SharedWeatherService = Arc<RwLock<WeatherServiceView>>;

/// A payload from one of the service's control-plane topics.
#[derive(Debug, Clone, PartialEq)]
pub enum ServicePayload {
    Status(Vec<u8>),
    Availability(Vec<u8>),
}

/// Applies a payload to the view. `Ok(true)` when the view changed.
///
/// An empty payload is how a retained message is cleared, so it clears that
/// half of the view. Anything unparseable is rejected and the view kept: a
/// stray publish must not blank the switch or mark the service online.
pub fn apply_service_payload(
    view: &mut WeatherServiceView,
    payload: ServicePayload,
) -> Result<bool, String> {
    match payload {
        ServicePayload::Status(bytes) => {
            let next = if bytes.is_empty() {
                None
            } else {
                Some(WeatherStatus::from_json(&bytes).map_err(|e| e.to_string())?)
            };
            let changed = view.status != next;
            view.status = next;
            Ok(changed)
        }
        ServicePayload::Availability(bytes) => {
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
            let changed = view.availability != next;
            view.availability = next;
            Ok(changed)
        }
    }
}

/// Where the weather service's control API is.
///
/// An explicit `weather_api_url` wins. Otherwise the service is assumed to
/// run beside the broker, on the API's default port -- the arrangement every
/// stack topology uses.
pub fn weather_api_url(config: &Config) -> String {
    let explicit = config.weather_api_url.trim();
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    format!("http://{}:{DEFAULT_HTTP_PORT}", config.mqtt_broker)
}

/// One log line for the service view: the reported state, the setting it
/// holds (plus failures and any rate limit), and whether it is online.
///
/// The relay writes it only when the view changes, so the retained messages
/// re-delivered on every reconnect stay quiet.
pub fn describe_service_view(view: &WeatherServiceView) -> String {
    let status = match &view.status {
        None => "no status".to_string(),
        Some(status) => {
            let setting = if status.enabled {
                "enabled"
            } else {
                "disabled"
            };
            let mut details = vec![setting.to_string()];
            match status.consecutive_failures {
                0 => {}
                1 => details.push("1 failure".to_string()),
                n => details.push(format!("{n} failures")),
            }
            if let Some(scope) = status.rate_limit {
                details.push(format!("{} limit", wire_word(&scope)));
            }
            format!("{} ({})", wire_word(&status.state), details.join(", "))
        }
    };
    let availability = view.availability.map_or("unknown", Availability::as_str);
    format!("{status}, availability: {availability}")
}

/// The word serde writes for a unit variant: the log uses the wire's words.
fn wire_word<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "?".to_string())
}

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

/// Relays the weather service's status and availability into state and the
/// webview until the feed stops. The only writer of [`SharedWeatherService`].
///
/// Emits `adsb:weather-service` with the whole view on every real change.
pub async fn relay_weather_service(
    app: AppHandle,
    mut status: watch::Receiver<Option<Vec<u8>>>,
    mut availability: watch::Receiver<Option<Vec<u8>>>,
    shared: SharedWeatherService,
    mut alive_rx: watch::Receiver<bool>,
) {
    loop {
        let payload = tokio::select! {
            changed = status.changed() => {
                if changed.is_err() {
                    break;
                }
                match status.borrow_and_update().clone() {
                    Some(bytes) => ServicePayload::Status(bytes),
                    None => continue,
                }
            }
            changed = availability.changed() => {
                if changed.is_err() {
                    break;
                }
                match availability.borrow_and_update().clone() {
                    Some(bytes) => ServicePayload::Availability(bytes),
                    None => continue,
                }
            }
            _ = alive_rx.changed() => break,
        };

        // Decide and copy under the lock; emit outside it.
        let outcome = match shared.write() {
            Ok(mut view) => apply_service_payload(&mut view, payload)
                .map(|changed| changed.then(|| view.clone())),
            Err(_) => continue,
        };
        match outcome {
            Ok(Some(view)) => {
                info!("Weather service status: {}", describe_service_view(&view));
                let _ = app.emit("adsb:weather-service", &view);
            }
            Ok(None) => {}
            Err(reason) => warn!("Ignoring weather service payload: {reason}"),
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

    // --- the weather service view -------------------------------------------

    use adsb_weather_server::status::{STATUS_VERSION, ServiceState};

    fn status(enabled: bool, state: ServiceState) -> WeatherStatus {
        WeatherStatus {
            version: STATUS_VERSION,
            enabled,
            state,
            consecutive_failures: 0,
            rate_limit: None,
            last_success_ms: None,
            last_error: None,
            next_fetch_ms: None,
            snapshot_valid_time_ms: None,
            updated_at_ms: 1,
        }
    }

    fn status_payload(s: &WeatherStatus) -> ServicePayload {
        ServicePayload::Status(serde_json::to_vec(s).unwrap())
    }

    #[test]
    fn a_status_fills_the_view() {
        let mut view = WeatherServiceView::default();
        let disabled = status(false, ServiceState::Disabled);
        assert_eq!(
            apply_service_payload(&mut view, status_payload(&disabled)),
            Ok(true)
        );
        assert_eq!(view.status, Some(disabled));
    }

    #[test]
    fn a_redelivered_status_changes_nothing() {
        // Every reconnect re-delivers the retained status.
        let mut view = WeatherServiceView::default();
        let idle = status(true, ServiceState::Idle);
        apply_service_payload(&mut view, status_payload(&idle)).unwrap();
        assert_eq!(
            apply_service_payload(&mut view, status_payload(&idle)),
            Ok(false)
        );
    }

    #[test]
    fn a_malformed_status_is_rejected_and_the_view_kept() {
        let mut view = WeatherServiceView::default();
        let idle = status(true, ServiceState::Idle);
        apply_service_payload(&mut view, status_payload(&idle)).unwrap();

        let result = apply_service_payload(&mut view, ServicePayload::Status(b"{\"trunc".to_vec()));
        assert!(result.is_err());
        assert_eq!(view.status, Some(idle));
    }

    #[test]
    fn an_empty_retained_status_clears_it() {
        let mut view = WeatherServiceView::default();
        apply_service_payload(&mut view, status_payload(&status(true, ServiceState::Idle)))
            .unwrap();
        assert_eq!(
            apply_service_payload(&mut view, ServicePayload::Status(vec![])),
            Ok(true)
        );
        assert_eq!(view.status, None);
    }

    #[test]
    fn going_offline_keeps_the_last_status() {
        // The will says the service is gone; what it last reported still
        // explains what it was doing ("offline, was paused").
        let mut view = WeatherServiceView::default();
        let paused = status(false, ServiceState::Disabled);
        apply_service_payload(&mut view, status_payload(&paused)).unwrap();
        apply_service_payload(&mut view, ServicePayload::Availability(b"online".to_vec())).unwrap();

        assert_eq!(
            apply_service_payload(&mut view, ServicePayload::Availability(b"offline".to_vec())),
            Ok(true)
        );
        assert_eq!(view.availability, Some(Availability::Offline));
        assert_eq!(view.status, Some(paused));
    }

    #[test]
    fn an_unknown_availability_word_is_rejected() {
        let mut view = WeatherServiceView::default();
        apply_service_payload(&mut view, ServicePayload::Availability(b"online".to_vec())).unwrap();
        assert!(
            apply_service_payload(&mut view, ServicePayload::Availability(b"maybe".to_vec()))
                .is_err()
        );
        assert_eq!(view.availability, Some(Availability::Online));
    }

    #[test]
    fn the_view_serialises_for_the_webview() {
        let view = WeatherServiceView {
            status: Some(status(true, ServiceState::RateLimited)),
            availability: Some(Availability::Online),
        };
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["availability"], "online");
        assert_eq!(json["status"]["state"], "rate_limited");
        assert_eq!(
            serde_json::to_value(WeatherServiceView::default()).unwrap(),
            serde_json::json!({ "status": null, "availability": null })
        );
    }

    #[test]
    fn an_explicit_api_url_wins() {
        let config = Config {
            weather_api_url: " http://pi-roof:9000 ".into(),
            mqtt_broker: "broker.lan".into(),
            ..Config::default()
        };
        assert_eq!(weather_api_url(&config), "http://pi-roof:9000");
    }

    #[test]
    fn without_an_api_url_the_service_is_beside_the_broker() {
        let config = Config {
            mqtt_broker: "pi-roof.lan".into(),
            ..Config::default()
        };
        assert_eq!(weather_api_url(&config), "http://pi-roof.lan:8789");
    }

    // --- the log line ---------------------------------------------------------

    #[test]
    fn the_log_line_names_state_setting_and_availability() {
        let view = WeatherServiceView {
            status: Some(status(true, ServiceState::Idle)),
            availability: Some(Availability::Online),
        };
        assert_eq!(
            describe_service_view(&view),
            "idle (enabled), availability: online"
        );
    }

    #[test]
    fn a_pause_not_acted_on_yet_shows_both_halves() {
        // Desired and reported disagree: the log must show the gap, not hide it.
        let view = WeatherServiceView {
            status: Some(status(false, ServiceState::Fetching)),
            availability: Some(Availability::Online),
        };
        assert_eq!(
            describe_service_view(&view),
            "fetching (disabled), availability: online"
        );
    }

    #[test]
    fn the_log_line_carries_failures_and_the_rate_limit() {
        use adsb_weather_server::status::RateLimitScope;
        let mut limited = status(true, ServiceState::RateLimited);
        limited.consecutive_failures = 2;
        limited.rate_limit = Some(RateLimitScope::Daily);
        let view = WeatherServiceView {
            status: Some(limited),
            availability: Some(Availability::Offline),
        };
        assert_eq!(
            describe_service_view(&view),
            "rate_limited (enabled, 2 failures, daily limit), availability: offline"
        );
    }

    #[test]
    fn the_log_line_says_what_has_not_been_heard_yet() {
        assert_eq!(
            describe_service_view(&WeatherServiceView::default()),
            "no status, availability: unknown"
        );
    }
}
