//! Publishes the latest snapshot as one retained MQTT message.
//!
//! Retained, because a subscriber that connects after the last fetch -- the
//! desktop app started mid-hour -- must get the current grid immediately
//! instead of waiting up to an hour for the next one.
//!
//! Republished on **every** ConnAck, not only when a new snapshot arrives. The
//! broker runs without persistence, so a broker restart erases the retained
//! message; the only way to put it back is for this process to send it again.
//!
//! The same connection carries the service's control-plane topics, derived
//! from the grid topic by [`WeatherTopics`]:
//! - **status**: the retained [`WeatherStatus`], on change and on every ConnAck;
//! - **availability**: `online` on every ConnAck (the birth message) and
//!   `offline` as the retained last will, which the broker publishes if this
//!   process dies. A graceful shutdown sends `offline` itself, because a clean
//!   disconnect does not fire the will.

use crate::snapshot::WeatherSnapshot;
use crate::status::{AVAILABILITY_OFFLINE, AVAILABILITY_ONLINE, WeatherStatus, WeatherTopics};
use adsb_pulsar_client::backoff::{
    Backoff, looks_like_id_collision, should_log, should_reset, was_short_lived,
};
use rumqttc::{AsyncClient, Event, EventLoop, Incoming, LastWill, MqttOptions, Outgoing, QoS};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tracing::{debug, info, warn};

/// Packet size limit for the publisher, both directions.
///
/// rumqttc defaults to 10 KiB, and a default-grid snapshot is larger than that
/// (see `default_grid_snapshot_needs_more_than_the_rumqttc_default`). Every
/// client that *subscribes* to the weather topic needs the same headroom, or
/// the retained message breaks its connection on every reconnect.
pub const MAX_PACKET_BYTES: usize = 1024 * 1024;

/// What happened on the connection or the snapshot channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// The broker accepted a (re)connection.
    ConnAck,
    /// The refresh loop produced a new snapshot.
    NewSnapshot,
    /// The status projection changed.
    NewStatus,
}

/// How long a graceful shutdown waits for `offline` and the disconnect to
/// leave. Past it the broker's keep-alive timeout fires the will anyway.
const OFFLINE_FLUSH: Duration = Duration::from_secs(2);

/// MQTT publisher settings.
#[derive(Debug, Clone)]
pub struct PublisherConfig {
    pub broker: String,
    pub port: u16,
    pub topic: String,
    pub client_id: String,
    pub keep_alive: Duration,
}

impl PublisherConfig {
    /// The grid topic and the control-plane topics derived from it.
    pub fn topics(&self) -> WeatherTopics {
        WeatherTopics::from_grid_topic(&self.topic)
    }
}

/// Connection options: keep-alive, the packet limit, and the last will that
/// marks the service offline if this process goes away without saying so.
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

/// Client id for the weather publisher.
///
/// Derived from the receiver's `source_id` but never equal to it or to
/// `<id>-sub`: those belong to the feed client and the recorder, and a broker
/// evicts an existing session when a second client arrives with the same id.
pub fn client_id(source_id: &str) -> String {
    format!("{source_id}-weather")
}

/// Serialises a snapshot for the wire.
pub fn encode(snapshot: &WeatherSnapshot) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(snapshot)
}

/// Whether `trigger` should result in a publish.
///
/// - ConnAck: yes, whenever there is something to publish -- the retained copy
///   may have died with the broker.
/// - New snapshot: only while connected. Offline, the next ConnAck publishes
///   whatever is latest by then, so nothing is queued or lost.
pub fn should_publish(trigger: Trigger, connected: bool, have_snapshot: bool) -> bool {
    have_snapshot
        && match trigger {
            Trigger::ConnAck => true,
            Trigger::NewSnapshot => connected,
            Trigger::NewStatus => false,
        }
}

/// Whether `trigger` should result in a status publish.
///
/// Same rules as the grid: every ConnAck (the retained copy may have died with
/// the broker), and a change only while connected -- offline, the next
/// ConnAck publishes whatever is current by then.
pub fn should_publish_status(trigger: Trigger, connected: bool) -> bool {
    match trigger {
        Trigger::ConnAck => true,
        Trigger::NewStatus => connected,
        Trigger::NewSnapshot => false,
    }
}

/// Runs the publisher until `shutdown` turns true or the snapshot channel
/// closes.
pub async fn run(
    config: PublisherConfig,
    mut snapshots: watch::Receiver<Option<WeatherSnapshot>>,
    mut status: watch::Receiver<WeatherStatus>,
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
    let mut status_open = true;

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    go_offline(&client, &mut eventloop, &topics.availability, connected).await;
                    return;
                }
            }
            changed = snapshots.changed() => {
                if changed.is_err() {
                    // The refresh loop is gone; nothing more will ever arrive.
                    go_offline(&client, &mut eventloop, &topics.availability, connected).await;
                    return;
                }
                let have = snapshots.borrow().is_some();
                if should_publish(Trigger::NewSnapshot, connected, have) {
                    publish_latest(&client, &config.topic, &snapshots).await;
                }
            }
            changed = status.changed(), if status_open => {
                if changed.is_err() {
                    // The projection is gone. The retained status stays as the
                    // last word; the grid keeps flowing.
                    status_open = false;
                } else if should_publish_status(Trigger::NewStatus, connected) {
                    publish_status(&client, &topics.status, &status).await;
                }
            }
            event = eventloop.poll() => match event {
                Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                    info!("Weather publisher connected to MQTT broker at {broker}");
                    connected = true;
                    connected_at = Some(Instant::now());
                    // Birth first, so a subscriber never sees a fresh status
                    // under a stale "offline".
                    publish_retained(&client, &topics.availability, AVAILABILITY_ONLINE.as_bytes().to_vec()).await;
                    if should_publish_status(Trigger::ConnAck, connected) {
                        publish_status(&client, &topics.status, &status).await;
                    }
                    let have = snapshots.borrow().is_some();
                    if should_publish(Trigger::ConnAck, connected, have) {
                        publish_latest(&client, &config.topic, &snapshots).await;
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    connected = false;

                    // Same pacing rules as the feed's MQTT legs: reset only
                    // after a connection that held, and name the duplicate-id
                    // case, which otherwise reads as a flaky broker.
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
                                "Weather publisher keeps being disconnected from {broker}: \
                                 another client is probably using the id '{}'. Last error: {e}",
                                config.client_id
                            );
                        } else if attempt > 0 {
                            warn!("Weather publisher lost {broker}: {e} (retry {attempt})");
                        } else {
                            debug!("Weather publisher connection to {broker} pending: {e}");
                        }
                    }
                    // rumqttc does not pace reconnects; without this it spins.
                    tokio::time::sleep(backoff.delay(attempt)).await;
                    attempt = attempt.saturating_add(1);
                }
            }
        }
    }
}

/// Publishes one small retained message at QoS 1, logging a failure.
async fn publish_retained(client: &AsyncClient, topic: &str, payload: Vec<u8>) {
    if let Err(e) = client.publish(topic, QoS::AtLeastOnce, true, payload).await {
        warn!("Could not publish to '{topic}': {e}");
    }
}

async fn publish_status(
    client: &AsyncClient,
    topic: &str,
    status: &watch::Receiver<WeatherStatus>,
) {
    // Encode inside the borrow, publish outside it.
    let payload = serde_json::to_vec(&*status.borrow());
    match payload {
        Ok(bytes) => {
            debug!("Publishing weather status to '{topic}'");
            publish_retained(client, topic, bytes).await;
        }
        Err(e) => warn!("Could not encode weather status: {e}"),
    }
}

/// Says `offline` and disconnects, then drives the event loop until both have
/// left. rumqttc only queues outgoing packets; nothing reaches the socket
/// unless the event loop is polled, so returning straight after
/// `disconnect()` would send neither.
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
        warn!(
            "Weather publisher could not say 'offline' in time; the broker's last will covers it"
        );
    }
}

async fn publish_latest(
    client: &AsyncClient,
    topic: &str,
    snapshots: &watch::Receiver<Option<WeatherSnapshot>>,
) {
    // Encode inside the borrow, publish outside it: a watch guard must not be
    // held across an await.
    let payload = match snapshots.borrow().as_ref().map(encode) {
        Some(Ok(bytes)) => bytes,
        Some(Err(e)) => {
            warn!("Could not encode weather snapshot: {e}");
            return;
        }
        None => return,
    };
    let size = payload.len();
    // QoS 1: one message an hour is the only copy on the bus; losing it to a
    // dropped connection would leave the retained slot empty until next hour.
    match client.publish(topic, QoS::AtLeastOnce, true, payload).await {
        Ok(()) => info!("Published retained weather snapshot to '{topic}' ({size} bytes)"),
        Err(e) => warn!("Could not publish weather snapshot to '{topic}': {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::variables_per_location;
    use crate::grid::GridSpec;
    use crate::snapshot::{LevelFields, SNAPSHOT_VERSION, SurfaceFields};
    use std::collections::BTreeMap;

    /// A worst-case default-grid snapshot: every value present, realistic width.
    fn full_default_snapshot() -> WeatherSnapshot {
        let grid = GridSpec::centered(46.717915, -2.33716964, 300.0, 1.0).unwrap();
        let n = grid.len();
        let levels: BTreeMap<u16, LevelFields> = [850, 700, 500, 300, 250, 200]
            .into_iter()
            .map(|l| {
                let fields = LevelFields {
                    wind_speed_kt: vec![Some(123.4); n],
                    wind_dir_deg: vec![Some(271.0); n],
                };
                (l, fields)
            })
            .collect();
        WeatherSnapshot {
            version: SNAPSHOT_VERSION,
            source: "open-meteo".into(),
            attribution: "Weather data by Open-Meteo.com (CC BY 4.0)".into(),
            model: "best_match".into(),
            fetched_at_ms: 1_789_413_000_000,
            valid_time_ms: 1_789_412_400_000,
            grid,
            surface: SurfaceFields {
                mslp_hpa: vec![Some(1013.2); n],
                wind_speed_kt: vec![Some(12.3); n],
                wind_dir_deg: vec![Some(245.0); n],
            },
            levels,
        }
    }

    #[test]
    fn client_id_is_distinct_from_the_feed_and_the_recorder() {
        let id = client_id("pi-roof-prod");
        assert_eq!(id, "pi-roof-prod-weather");
        assert_ne!(id, "pi-roof-prod");
        assert_ne!(id, "pi-roof-prod-sub");
    }

    #[test]
    fn encode_round_trips() {
        let snap = full_default_snapshot();
        let bytes = encode(&snap).unwrap();
        assert_eq!(WeatherSnapshot::from_json(&bytes).unwrap(), snap);
    }

    #[test]
    fn default_grid_snapshot_needs_more_than_the_rumqttc_default() {
        // The reason MAX_PACKET_BYTES exists. If this ever stops holding, the
        // raised limit is harmless; if the second assertion fails, it is not
        // raised enough.
        let snap = full_default_snapshot();
        assert_eq!(variables_per_location(snap.levels.len()), 15);
        let size = encode(&snap).unwrap().len();
        assert!(size > 10 * 1024, "snapshot is only {size} bytes");
        assert!(size < MAX_PACKET_BYTES, "snapshot is {size} bytes");
    }

    #[test]
    fn a_connack_republishes_whatever_is_latest() {
        assert!(should_publish(Trigger::ConnAck, true, true));
    }

    #[test]
    fn a_connack_with_nothing_fetched_yet_publishes_nothing() {
        assert!(!should_publish(Trigger::ConnAck, true, false));
    }

    #[test]
    fn a_new_snapshot_is_published_while_connected() {
        assert!(should_publish(Trigger::NewSnapshot, true, true));
    }

    #[test]
    fn a_new_snapshot_waits_for_the_next_connack_while_offline() {
        assert!(!should_publish(Trigger::NewSnapshot, false, true));
    }

    #[test]
    fn a_new_status_does_not_republish_the_grid() {
        assert!(!should_publish(Trigger::NewStatus, true, true));
    }

    #[test]
    fn a_connack_republishes_the_status() {
        assert!(should_publish_status(Trigger::ConnAck, true));
    }

    #[test]
    fn a_new_status_is_published_while_connected() {
        assert!(should_publish_status(Trigger::NewStatus, true));
    }

    #[test]
    fn a_new_status_waits_for_the_next_connack_while_offline() {
        assert!(!should_publish_status(Trigger::NewStatus, false));
    }

    #[test]
    fn a_new_snapshot_does_not_republish_the_status() {
        assert!(!should_publish_status(Trigger::NewSnapshot, true));
    }

    fn config() -> PublisherConfig {
        PublisherConfig {
            broker: "localhost".into(),
            port: 1883,
            topic: "adsb/dev/weather/grid".into(),
            client_id: client_id("pi-roof-dev"),
            keep_alive: Duration::from_secs(30),
        }
    }

    #[test]
    fn control_topics_are_siblings_of_the_grid_topic() {
        let topics = config().topics();
        assert_eq!(topics.status, "adsb/dev/weather/status");
        assert_eq!(topics.availability, "adsb/dev/weather/availability");
    }

    #[test]
    fn the_last_will_marks_the_service_offline() {
        // Retained, or a desktop that connects after the crash would never
        // learn the service is gone.
        let will = mqtt_options(&config()).last_will().expect("a last will");
        assert_eq!(will.topic, "adsb/dev/weather/availability");
        assert_eq!(&will.message[..], AVAILABILITY_OFFLINE.as_bytes());
        assert_eq!(will.qos, QoS::AtLeastOnce);
        assert!(will.retain);
    }

    #[test]
    fn subscribers_accept_what_this_publisher_can_send() {
        // The subscriber (MqttSource, used by the desktop) lives in
        // adsb-pulsar-client, which cannot depend on this crate. This is the one
        // place both limits are visible, so the invariant is pinned here: a
        // snapshot larger than the subscriber's limit breaks its connection on
        // every reconnect, taking the live feed with it.
        //
        // Both sides are constants, so this is a const block: checked when the
        // test target compiles, and impossible to skip by filtering tests.
        const {
            assert!(
                adsb_pulsar_client::source::mqtt_source::MAX_INCOMING_PACKET_BYTES
                    >= MAX_PACKET_BYTES
            )
        };
    }
}
