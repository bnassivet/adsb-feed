//! MQTT-based message forwarder.
//!
//! Publishes raw SBS-1 lines to an MQTT topic. This is the lightweight LAN
//! transport that lets `adsb-data-server` and the desktop app consume the feed
//! without an Apache Pulsar broker — i.e. it is what makes a no-Pulsar
//! deployment possible. Pulsar remains available as an additional fan-out leg
//! for the Spark/Delta analytics path.
//!
//! # Loss posture
//!
//! The default QoS is 0 and publishing is non-blocking ([`AsyncClient::try_publish`]).
//! The client fans out to every forwarder in sequence, so a slow or wedged MQTT
//! broker must never stall the socket read loop or the Pulsar leg. A full
//! outbound queue is therefore reported as an error (which the caller's retry
//! queue accounts for) rather than awaited.

use crate::backoff::{Backoff, looks_like_id_collision, should_log, should_reset, was_short_lived};
use crate::config::Config;
use crate::error::{ClientError, Result};
use crate::forwarder::MessageForwarder;
use crate::receiver_location::ReceiverLocationMessage;
use rumqttc::{AsyncClient, Event, Incoming, LastWill, MqttOptions, QoS};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// Maps the configured `u8` QoS onto rumqttc's enum.
///
/// Values are validated by [`Config::validate`]; anything out of range here
/// falls back to at-most-once rather than panicking on a programmatically
/// constructed config.
fn qos_from_u8(qos: u8) -> QoS {
    match qos {
        1 => QoS::AtLeastOnce,
        2 => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    }
}

/// MQTT message forwarder.
pub struct MqttForwarder {
    broker: String,
    port: u16,
    topic: String,
    client_id: String,
    qos: QoS,
    keep_alive: Duration,
    client: Option<AsyncClient>,
    connected: Arc<AtomicBool>,
    announcement: Option<(String, Vec<u8>)>,
    availability_topic: String,
}

impl MqttForwarder {
    /// Creates a new `MqttForwarder` from a [`Config`].
    pub fn new(config: &Config) -> Self {
        Self {
            broker: config.mqtt_broker.clone(),
            port: config.mqtt_port,
            topic: config.publish_topic(),
            client_id: config.mqtt_client_id().to_string(),
            qos: qos_from_u8(config.mqtt_qos),
            keep_alive: config.socket_timeout(),
            client: None,
            connected: Arc::new(AtomicBool::new(false)),
            // Built once: `since_ms` is when this process started with this
            // position, which is what a recorder should date it from.
            announcement: ReceiverLocationMessage::from_config(config, now_ms())
                .map(|msg| (config.receiver_announce_topic(), msg.to_json())),
            availability_topic: config.receiver_availability_topic(),
        }
    }

    /// The topic this forwarder publishes to.
    pub fn topic(&self) -> &str {
        &self.topic
    }

    /// The MQTT client id in use.
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Where this feed says `online` (on connect) or, through its last will,
    /// `offline`. Retained both ways.
    pub fn availability_topic(&self) -> &str {
        &self.availability_topic
    }

    /// Connection options: keep-alive, and the retained `offline` last will
    /// the broker publishes if this feed vanishes without disconnecting.
    pub fn mqtt_options(&self) -> MqttOptions {
        let mut options = MqttOptions::new(&self.client_id, &self.broker, self.port);
        options.set_keep_alive(self.keep_alive);
        options.set_last_will(LastWill::new(
            &self.availability_topic,
            AVAILABILITY_OFFLINE,
            QoS::AtLeastOnce,
            true,
        ));
        options
    }

    /// The retained location announcement published on every connect, as
    /// (topic, payload), when the receiver's position is configured.
    pub fn announcement(&self) -> Option<&(String, Vec<u8>)> {
        self.announcement.as_ref()
    }
}

/// Payloads of [`Config::receiver_availability_topic`], as the weather
/// service uses for its own availability.
pub const AVAILABILITY_ONLINE: &str = "online";
pub const AVAILABILITY_OFFLINE: &str = "offline";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[async_trait::async_trait]
impl MessageForwarder for MqttForwarder {
    async fn connect(&mut self) -> Result<()> {
        let (client, mut eventloop) = AsyncClient::new(self.mqtt_options(), 1024);
        self.client = Some(client);

        // rumqttc only makes progress while its event loop is polled, and the
        // loop is also the only place connection state is observable. It owns
        // its own reconnection, so this task runs for the life of the
        // forwarder and reports transitions through `connected`.
        let connected = Arc::clone(&self.connected);
        let announcer = self.client.clone().zip(self.announcement.clone());
        let availability = self
            .client
            .clone()
            .map(|c| (c, self.availability_topic.clone()));
        let broker = format!("{}:{}", self.broker, self.port);
        let client_id = self.client_id.clone();
        tokio::spawn(async move {
            let backoff = Backoff::default();
            let mut attempt: u32 = 0;
            let mut connected_at: Option<Instant> = None;
            let mut short_lived: u32 = 0;

            loop {
                match eventloop.poll().await {
                    Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                        if attempt > 0 {
                            if should_log(attempt) {
                                info!("Reconnected to MQTT broker at {}", broker);
                            }
                        } else {
                            info!("Connected to MQTT broker at {}", broker);
                        }
                        // Deliberately NOT resetting `attempt` here: see below.
                        connected_at = Some(Instant::now());
                        connected.store(true, Ordering::Relaxed);

                        // Retained, so a subscriber that connects later still
                        // learns where this receiver is; re-sent on every
                        // connect in case the broker lost its retained store.
                        if let Some((client, topic)) = &availability
                            && let Err(e) = client.try_publish(
                                topic,
                                QoS::AtLeastOnce,
                                true,
                                AVAILABILITY_ONLINE,
                            )
                        {
                            warn!("Receiver availability on '{topic}' failed: {e}");
                        }
                        if let Some((client, (topic, payload))) = &announcer
                            && let Err(e) =
                                client.try_publish(topic, QoS::AtLeastOnce, true, payload.clone())
                        {
                            warn!("Receiver location announcement on '{topic}' failed: {e}");
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        let was_connected = connected.swap(false, Ordering::Relaxed);

                        // Reset only if the connection actually held. An
                        // eviction storm connects successfully and is kicked
                        // milliseconds later; resetting on connect would pin
                        // the backoff at its minimum forever.
                        if let Some(t) = connected_at {
                            if should_reset(t.elapsed()) {
                                attempt = 0;
                                short_lived = 0;
                            } else if was_short_lived(t.elapsed()) {
                                short_lived = short_lived.saturating_add(1);
                            }
                        }
                        connected_at = None;

                        if should_log(attempt) {
                            if looks_like_id_collision(short_lived) {
                                warn!(
                                    "MQTT connection to {broker} keeps dropping ({attempt} times). \
                                     Another client is probably connected with the same id \
                                     ('{client_id}') and evicting this one -- check for a second \
                                     adsb-pulsar-client, or set a distinct mqtt_client_id. Last \
                                     error: {e}"
                                );
                            } else if was_connected || attempt > 0 {
                                warn!(
                                    "MQTT connection to {} lost: {} (retry {})",
                                    broker, e, attempt
                                );
                            } else {
                                debug!("MQTT connection to {} pending: {}", broker, e);
                            }
                        }

                        // rumqttc does NOT pace this for us: poll() returns the
                        // error immediately, so without a sleep this is a hot
                        // spin loop. Measured at ~2500 reconnects/second.
                        tokio::time::sleep(backoff.delay(attempt)).await;
                        attempt = attempt.saturating_add(1);
                    }
                }
            }
        });

        Ok(())
    }

    async fn send(&mut self, message: &[u8]) -> Result<()> {
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| ClientError::Forwarder("MQTT client not connected".into()))?;

        client
            .try_publish(&self.topic, self.qos, false, message)
            .map_err(|e| ClientError::Forwarder(format!("MQTT publish failed: {}", e)))
    }

    async fn flush(&mut self) -> Result<()> {
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        if let Some(client) = self.client.take() {
            let _ = client.disconnect().await;
        }
        self.connected.store(false, Ordering::Relaxed);
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    fn name(&self) -> &str {
        "mqtt"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ForwarderKind;

    fn mqtt_config() -> Config {
        Config {
            forwarders: vec![ForwarderKind::Mqtt],
            ..Config::default()
        }
    }

    #[test]
    fn test_mqtt_forwarder_not_connected_initially() {
        let forwarder = MqttForwarder::new(&mqtt_config());
        assert!(!forwarder.is_connected());
    }

    #[test]
    fn test_mqtt_forwarder_name() {
        let forwarder = MqttForwarder::new(&mqtt_config());
        assert_eq!(forwarder.name(), "mqtt");
    }

    #[tokio::test]
    async fn test_send_before_connect_is_an_error() {
        let mut forwarder = MqttForwarder::new(&mqtt_config());
        assert!(forwarder.send(b"MSG,3,1,1,ABC123,1").await.is_err());
    }

    #[test]
    fn test_forwarder_takes_topic_and_client_id_from_config() {
        let config = Config {
            source_id: "pi-roof".to_string(),
            mqtt_topic: "adsb/custom".to_string(),
            ..mqtt_config()
        };
        let forwarder = MqttForwarder::new(&config);
        assert_eq!(forwarder.topic(), "adsb/custom");
        assert_eq!(forwarder.client_id(), "pi-roof");
    }

    #[test]
    fn test_forwarder_publishes_under_its_own_id_when_per_receiver() {
        let config = Config {
            source_id: "pi-roof-prod".to_string(),
            mqtt_topic: "adsb/prod/sbs/raw".to_string(),
            mqtt_per_receiver_topic: true,
            ..mqtt_config()
        };
        assert_eq!(
            MqttForwarder::new(&config).topic(),
            "adsb/prod/sbs/raw/pi-roof-prod"
        );
    }

    #[test]
    fn test_a_located_forwarder_has_a_retained_announcement_to_publish() {
        let config = Config {
            source_id: "pi-roof-prod".to_string(),
            mqtt_topic: "adsb/prod/sbs/raw".to_string(),
            receiver_latitude: Some(46.7),
            receiver_longitude: Some(-2.3),
            ..mqtt_config()
        };
        let (topic, payload) = MqttForwarder::new(&config)
            .announcement()
            .expect("an announcement")
            .clone();
        assert_eq!(topic, "adsb/prod/receiver/pi-roof-prod");
        let msg = crate::receiver_location::ReceiverLocationMessage::parse(&payload).unwrap();
        assert_eq!((msg.latitude, msg.longitude), (46.7, -2.3));
        assert!(msg.since_ms > 0, "stamped with the forwarder's start");
    }

    #[test]
    fn test_the_forwarder_leaves_an_offline_will_and_says_online_on_connect() {
        let config = Config {
            source_id: "pi-roof-prod".to_string(),
            mqtt_topic: "adsb/prod/sbs/raw".to_string(),
            ..mqtt_config()
        };
        let forwarder = MqttForwarder::new(&config);
        let will = forwarder.mqtt_options().last_will().expect("a last will");
        assert_eq!(will.topic, "adsb/prod/receiver/pi-roof-prod/availability");
        assert_eq!(&will.message[..], b"offline");
        assert!(will.retain, "a late subscriber must still learn it is down");
        assert_eq!(
            forwarder.availability_topic(),
            "adsb/prod/receiver/pi-roof-prod/availability"
        );
    }

    #[test]
    fn test_an_unlocated_forwarder_announces_nothing() {
        assert!(MqttForwarder::new(&mqtt_config()).announcement().is_none());
    }

    #[test]
    fn test_qos_mapping() {
        assert_eq!(qos_from_u8(0), QoS::AtMostOnce);
        assert_eq!(qos_from_u8(1), QoS::AtLeastOnce);
        assert_eq!(qos_from_u8(2), QoS::ExactlyOnce);
        // Out-of-range degrades rather than panics; validate() rejects it first.
        assert_eq!(qos_from_u8(9), QoS::AtMostOnce);
    }
}
