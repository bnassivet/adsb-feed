//! Publishes polls and status over MQTT.
//!
//! - **states**: each poll's [`StatesMessage`], QoS 0, *not* retained. A
//!   position is live data: a subscriber that was not connected has missed
//!   nothing it can still use, and a retained one would be stale.
//! - **tracks**: each fetched track's [`TrackMessage`], QoS 0, *not*
//!   retained, for recorders to store. One fetch, one record.
//! - **status**: the retained [`OpenSkyStatus`], on change and on every
//!   ConnAck (the broker runs without persistence).
//! - **availability**: `online` on every ConnAck, `offline` as the retained
//!   last will and on a graceful shutdown.

use crate::states::{StatesMessage, TrackMessage};
use crate::status::{AVAILABILITY_OFFLINE, AVAILABILITY_ONLINE, OpenSkyStatus, OpenSkyTopics};
use adsb_pulsar_client::backoff::{
    Backoff, looks_like_id_collision, should_log, should_reset, was_short_lived,
};
use rumqttc::{AsyncClient, Event, EventLoop, Incoming, LastWill, MqttOptions, Outgoing, QoS};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

/// Packet size limit, both directions. A poll of four busy areas is well over
/// rumqttc's 10 KiB default; every subscriber needs the same headroom, or the
/// first large poll breaks its connection (see `rumqttc` in the weather
/// service's notes).
pub const MAX_PACKET_BYTES: usize = 1024 * 1024;

const OFFLINE_FLUSH: Duration = Duration::from_secs(2);

/// MQTT publisher settings.
#[derive(Debug, Clone)]
pub struct PublisherConfig {
    pub broker: String,
    pub port: u16,
    /// The states topic; status and availability derive from it.
    pub topic: String,
    pub client_id: String,
    pub keep_alive: Duration,
}

impl PublisherConfig {
    pub fn topics(&self) -> OpenSkyTopics {
        OpenSkyTopics::from_states_topic(&self.topic)
    }
}

/// Client id for this publisher: never the feed's, the recorder's, the
/// desktop's (`<id>-sub`) or the weather service's.
pub fn client_id(source_id: &str) -> String {
    format!("{source_id}-opensky")
}

pub fn mqtt_options(config: &PublisherConfig) -> MqttOptions {
    let mut options = MqttOptions::new(&config.client_id, &config.broker, config.port);
    options.set_keep_alive(config.keep_alive);
    options.set_max_packet_size(MAX_PACKET_BYTES, MAX_PACKET_BYTES);
    options.set_last_will(LastWill::new(
        config.topics().availability,
        AVAILABILITY_OFFLINE,
        QoS::AtLeastOnce,
        true,
    ));
    options
}

/// A poll's message, trimmed to fit a packet: an over-size payload would
/// break every subscriber's connection, so states are dropped from the end
/// (and a warning logged) rather than sent whole.
pub fn encode_states(message: &StatesMessage) -> Result<(Vec<u8>, usize), serde_json::Error> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() < MAX_PACKET_BYTES - 1024 {
        return Ok((bytes, 0));
    }
    let mut trimmed = message.clone();
    let mut dropped = 0;
    loop {
        let keep = trimmed.states.len() * 9 / 10;
        dropped += trimmed.states.len() - keep;
        trimmed.states.truncate(keep);
        let bytes = serde_json::to_vec(&trimmed)?;
        if bytes.len() < MAX_PACKET_BYTES - 1024 || trimmed.states.is_empty() {
            return Ok((bytes, dropped));
        }
    }
}

/// A track, whole, or `None` when it would not fit a packet. Never trimmed:
/// a track with waypoints missing would be stored as the wrong flight.
pub fn encode_track(message: &TrackMessage) -> Option<Vec<u8>> {
    serde_json::to_vec(message)
        .ok()
        .filter(|bytes| bytes.len() < MAX_PACKET_BYTES - 1024)
}

/// Runs until `shutdown` turns true.
pub async fn run(
    config: PublisherConfig,
    mut states: watch::Receiver<Option<StatesMessage>>,
    mut tracks: mpsc::Receiver<TrackMessage>,
    mut status: watch::Receiver<OpenSkyStatus>,
    mut shutdown: watch::Receiver<bool>,
) {
    let topics = config.topics();
    let (client, mut eventloop) = AsyncClient::new(mqtt_options(&config), 16);
    let broker = format!("{}:{}", config.broker, config.port);
    let backoff = Backoff::default();
    let mut attempt: u32 = 0;
    let mut connected = false;
    let mut connected_at: Option<Instant> = None;
    let mut short_lived: u32 = 0;
    let mut states_open = true;
    let mut tracks_open = true;
    let mut status_open = true;

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    go_offline(&client, &mut eventloop, &topics.availability, connected).await;
                    return;
                }
            }
            changed = states.changed(), if states_open => {
                if changed.is_err() {
                    states_open = false;
                } else if connected {
                    // Encode inside the borrow, publish outside it.
                    let encoded = states.borrow().as_ref().map(encode_states);
                    match encoded {
                        Some(Ok((bytes, dropped))) => {
                            if dropped > 0 {
                                warn!("OpenSky poll too large for one MQTT packet: dropped {dropped} aircraft");
                            }
                            if let Err(e) = client.publish(&topics.states, QoS::AtMostOnce, false, bytes).await {
                                warn!("Could not publish to '{}': {e}", topics.states);
                            }
                        }
                        Some(Err(e)) => warn!("Could not encode an OpenSky poll: {e}"),
                        None => {}
                    }
                }
            }
            track = tracks.recv(), if tracks_open => match track {
                None => tracks_open = false,
                // Not connected: the record is lost, as an SBS line would be.
                Some(_) if !connected => warn!("OpenSky track not published: MQTT is down"),
                Some(m) => match encode_track(&m) {
                    Some(bytes) => {
                        if let Err(e) = client.publish(&topics.tracks, QoS::AtMostOnce, false, bytes).await {
                            warn!("Could not publish to '{}': {e}", topics.tracks);
                        }
                    }
                    None => warn!("OpenSky track for {} too large for one MQTT packet: not published", m.track.icao24),
                },
            },
            changed = status.changed(), if status_open => {
                if changed.is_err() {
                    status_open = false;
                } else if connected {
                    publish_status(&client, &topics.status, &status).await;
                }
            }
            event = eventloop.poll() => match event {
                Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                    info!("OpenSky publisher connected to MQTT broker at {broker}");
                    connected = true;
                    connected_at = Some(Instant::now());
                    publish_retained(&client, &topics.availability, AVAILABILITY_ONLINE.as_bytes().to_vec()).await;
                    publish_status(&client, &topics.status, &status).await;
                }
                Ok(_) => {}
                Err(e) => {
                    connected = false;
                    if let Some(t) = connected_at.take() {
                        if should_reset(t.elapsed()) {
                            attempt = 0;
                            short_lived = 0;
                        } else if was_short_lived(t.elapsed()) {
                            short_lived = short_lived.saturating_add(1);
                        }
                    }
                    if should_log(attempt) {
                        if looks_like_id_collision(short_lived) {
                            warn!(
                                "OpenSky publisher keeps being disconnected from {broker}: \
                                 another client is probably using the id '{}'. Last error: {e}",
                                config.client_id
                            );
                        } else if attempt > 0 {
                            warn!("OpenSky publisher lost {broker}: {e} (retry {attempt})");
                        } else {
                            debug!("OpenSky publisher connection to {broker} pending: {e}");
                        }
                    }
                    tokio::time::sleep(backoff.delay(attempt)).await;
                    attempt = attempt.saturating_add(1);
                }
            }
        }
    }
}

async fn publish_retained(client: &AsyncClient, topic: &str, payload: Vec<u8>) {
    if let Err(e) = client.publish(topic, QoS::AtLeastOnce, true, payload).await {
        warn!("Could not publish to '{topic}': {e}");
    }
}

async fn publish_status(
    client: &AsyncClient,
    topic: &str,
    status: &watch::Receiver<OpenSkyStatus>,
) {
    let payload = serde_json::to_vec(&*status.borrow());
    match payload {
        Ok(bytes) => publish_retained(client, topic, bytes).await,
        Err(e) => warn!("Could not encode the OpenSky status: {e}"),
    }
}

/// Says `offline` and disconnects, driving the event loop until both leave:
/// rumqttc only queues outgoing packets.
async fn go_offline(client: &AsyncClient, eventloop: &mut EventLoop, topic: &str, connected: bool) {
    if connected {
        publish_retained(client, topic, AVAILABILITY_OFFLINE.as_bytes().to_vec()).await;
    }
    let _ = client.disconnect().await;
    if !connected {
        return;
    }
    let flushed = tokio::time::timeout(OFFLINE_FLUSH, async {
        loop {
            match eventloop.poll().await {
                Ok(Event::Outgoing(Outgoing::Disconnect)) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;
    if flushed.is_err() {
        warn!("OpenSky publisher could not say 'offline' in time; the last will covers it");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::states::{MatchedState, OpenSkyState, STATES_VERSION};

    fn config() -> PublisherConfig {
        PublisherConfig {
            broker: "localhost".into(),
            port: 1883,
            topic: "adsb/dev/opensky/states".into(),
            client_id: client_id("pi-roof-dev"),
            keep_alive: Duration::from_secs(30),
        }
    }

    fn message(n: usize) -> StatesMessage {
        let state = |i: usize| OpenSkyState {
            icao24: format!("{i:06x}"),
            callsign: Some("ABCD1234".into()),
            origin_country: Some("Some Long Country Name".into()),
            time_position: Some(1),
            last_contact: Some(1),
            latitude: Some(47.123456),
            longitude: Some(-2.123456),
            altitude_ft: Some(35_000.0),
            geo_altitude_ft: Some(35_500.0),
            on_ground: false,
            ground_speed_kt: Some(450.0),
            track_deg: Some(270.5),
            vertical_rate_fpm: Some(-1_000.0),
            squawk: Some("1000".into()),
            position_source: None,
        };
        StatesMessage {
            version: STATES_VERSION,
            fetched_ms: 0,
            data_time: 0,
            states: (0..n)
                .map(|i| MatchedState {
                    state: state(i),
                    matched: vec![],
                })
                .collect(),
        }
    }

    fn track(waypoints: usize) -> TrackMessage {
        use crate::states::{OpenSkyTrack, Waypoint};
        let w = |i: usize| Waypoint {
            time: i as i64,
            latitude: 47.123456,
            longitude: -2.123456,
            altitude_ft: Some(35_000.0),
            track_deg: Some(270.5),
            on_ground: false,
        };
        TrackMessage::new(
            1,
            OpenSkyTrack {
                icao24: "3c6444".into(),
                callsign: Some("DLH9LF".into()),
                start_time: 0,
                end_time: waypoints as i64,
                path: (0..waypoints).map(w).collect(),
            },
        )
    }

    #[test]
    fn a_track_is_encoded_whole_or_not_at_all() {
        let bytes = encode_track(&track(300)).expect("fits");
        assert_eq!(TrackMessage::from_json(&bytes).unwrap(), track(300));
        // Trimming waypoints would store a wrong flight: an oversize one is dropped.
        assert!(encode_track(&track(20_000)).is_none());
    }

    #[test]
    fn the_client_id_is_its_own() {
        let id = client_id("pi-roof-prod");
        assert_eq!(id, "pi-roof-prod-opensky");
        for other in ["pi-roof-prod", "pi-roof-prod-sub", "pi-roof-prod-weather"] {
            assert_ne!(id, other);
        }
    }

    #[test]
    fn the_last_will_marks_the_service_offline() {
        let will = mqtt_options(&config()).last_will().expect("a last will");
        assert_eq!(will.topic, "adsb/dev/opensky/availability");
        assert_eq!(&will.message[..], AVAILABILITY_OFFLINE.as_bytes());
        assert!(will.retain);
    }

    #[test]
    fn a_busy_poll_needs_more_than_the_rumqttc_default() {
        let (bytes, dropped) = encode_states(&message(200)).unwrap();
        assert!(bytes.len() > 10 * 1024, "{} bytes", bytes.len());
        assert_eq!(dropped, 0);
    }

    #[test]
    fn an_oversize_poll_is_trimmed_to_fit_a_packet() {
        let (bytes, dropped) = encode_states(&message(5_000)).unwrap();
        assert!(bytes.len() < MAX_PACKET_BYTES, "{} bytes", bytes.len());
        assert!(dropped > 0);
        assert!(StatesMessage::from_json(&bytes).is_ok());
    }

    #[test]
    fn subscribers_accept_what_this_publisher_can_send() {
        // The desktop subscribes through MqttSource in adsb-pulsar-client;
        // a payload above its limit would break its connection, live feed
        // included. Checked when the test target compiles.
        const {
            assert!(
                adsb_pulsar_client::source::mqtt_source::MAX_INCOMING_PACKET_BYTES
                    >= MAX_PACKET_BYTES
            )
        };
    }
}
