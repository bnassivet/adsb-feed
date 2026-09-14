//! MQTT subscription source.
//!
//! Subscribes to the topic published by
//! [`MqttForwarder`](crate::forwarder::mqtt_forwarder::MqttForwarder) and
//! republishes each SBS-1 line on a broadcast channel. This is what lets a
//! consumer — the desktop app, or `adsb-data-server` — read a live feed
//! produced by a *different* process with no Apache Pulsar involved.

use crate::backoff::{Backoff, looks_like_id_collision, should_log, should_reset, was_short_lived};
use crate::config::Config;
use crate::error::{ClientError, Result};
use crate::source::{MessageSource, SourceStatus, split_lines};
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, watch};
use tracing::{debug, info, warn};

/// Largest packet this subscriber accepts, in bytes.
///
/// rumqttc defaults to 10 KiB, and a weather snapshot on the aux topic is
/// larger. An oversized *incoming* packet is not dropped: it fails the event
/// loop, the client reconnects, the broker re-delivers the retained message,
/// and the cycle repeats -- a reconnect storm that takes the live SBS feed down
/// with it. Kept at least as large as `adsb_weather_server`'s publisher limit
/// by a test in that crate, which can depend on this one (not the reverse).
pub const MAX_INCOMING_PACKET_BYTES: usize = 1024 * 1024;

/// Where an incoming publish goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Raw SBS-1: split into lines and broadcast.
    Sbs,
    /// The auxiliary topic (weather): delivered whole, never line-split.
    Aux,
    /// Neither: ignored.
    Ignore,
}

/// Decides where a publish on `topic` goes.
///
/// The SBS topic is checked first: if a hand-edited config makes the aux topic
/// equal to it, the live feed keeps working and only the aux payload is lost.
pub fn route_publish(topic: &str, sbs_topic: &str, aux_topic: Option<&str>) -> Route {
    if topic == sbs_topic {
        Route::Sbs
    } else if aux_topic == Some(topic) {
        Route::Aux
    } else {
        Route::Ignore
    }
}

/// A [`MessageSource`] backed by an MQTT subscription.
pub struct MqttSource {
    broker: String,
    port: u16,
    topic: String,
    client_id: String,
    qos: QoS,
    keep_alive: Duration,
    message_tx: Option<broadcast::Sender<Vec<u8>>>,
    /// Optional second topic on the same connection (the weather snapshot).
    aux_topic: Option<String>,
    aux_tx: Option<watch::Sender<Option<Vec<u8>>>>,
    status_tx: watch::Sender<SourceStatus>,
    status_rx: watch::Receiver<SourceStatus>,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
}

impl MqttSource {
    /// Creates an MQTT source from a [`Config`].
    ///
    /// The client id is suffixed with `-sub` so a source and a forwarder built
    /// from the same config can coexist on one broker: brokers evict an
    /// existing session when a second client connects with the same id.
    pub fn new(config: &Config) -> Self {
        let (status_tx, status_rx) = watch::channel(SourceStatus::Disconnected);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        Self {
            broker: config.mqtt_broker.clone(),
            port: config.mqtt_port,
            topic: config.mqtt_topic.clone(),
            client_id: format!("{}-sub", config.mqtt_client_id()),
            qos: match config.mqtt_qos {
                1 => QoS::AtLeastOnce,
                2 => QoS::ExactlyOnce,
                _ => QoS::AtMostOnce,
            },
            keep_alive: config.socket_timeout(),
            message_tx: None,
            aux_topic: None,
            aux_tx: None,
            status_tx,
            status_rx,
            shutdown_tx,
            shutdown_rx,
        }
    }

    /// The topic this source subscribes to.
    pub fn topic(&self) -> &str {
        &self.topic
    }

    /// The MQTT client id in use.
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Also subscribes to `topic` on the same connection, delivering each
    /// payload whole through the returned watch channel (latest wins).
    ///
    /// Built for the retained weather snapshot: a JSON document rather than
    /// SBS-1, so it must never reach the line splitter or the SBS broadcast,
    /// and only the newest one matters. Calling it again replaces the topic and
    /// hands out another receiver on the same channel.
    pub fn with_aux_topic(&mut self, topic: impl Into<String>) -> watch::Receiver<Option<Vec<u8>>> {
        self.aux_topic = Some(topic.into());
        match &self.aux_tx {
            Some(tx) => tx.subscribe(),
            None => {
                let (tx, rx) = watch::channel(None);
                self.aux_tx = Some(tx);
                rx
            }
        }
    }

    /// Every topic this source subscribes to on connect, SBS first.
    ///
    /// An aux topic equal to the SBS topic is not subscribed twice; routing
    /// already treats it as SBS.
    pub fn topics(&self) -> Vec<&str> {
        std::iter::once(self.topic.as_str())
            .chain(self.aux_topic.as_deref().filter(|aux| *aux != self.topic))
            .collect()
    }

    /// Connection options: keep-alive, and a packet limit large enough for the
    /// aux payload.
    fn mqtt_options(&self) -> MqttOptions {
        let mut options = MqttOptions::new(&self.client_id, &self.broker, self.port);
        options.set_keep_alive(self.keep_alive);
        options.set_max_packet_size(MAX_INCOMING_PACKET_BYTES, MAX_INCOMING_PACKET_BYTES);
        options
    }
}

#[async_trait::async_trait]
impl MessageSource for MqttSource {
    fn subscribe(&mut self, capacity: usize) -> broadcast::Receiver<Vec<u8>> {
        if let Some(ref tx) = self.message_tx {
            tx.subscribe()
        } else {
            let (tx, rx) = broadcast::channel(capacity);
            self.message_tx = Some(tx);
            rx
        }
    }

    fn status(&self) -> watch::Receiver<SourceStatus> {
        self.status_rx.clone()
    }

    async fn run(&mut self) -> Result<()> {
        let tx = self
            .message_tx
            .clone()
            .ok_or_else(|| ClientError::Config("MqttSource::run called before subscribe".into()))?;

        let (client, mut eventloop) = AsyncClient::new(self.mqtt_options(), 1024);
        let _ = self.status_tx.send(SourceStatus::Connecting);

        let broker = format!("{}:{}", self.broker, self.port);
        let mut shutdown_rx = self.shutdown_rx.clone();
        let backoff = Backoff::default();
        let mut attempt: u32 = 0;
        let mut connected_at: Option<Instant> = None;
        let mut short_lived: u32 = 0;

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        let _ = client.disconnect().await;
                        break;
                    }
                }
                event = eventloop.poll() => {
                    match event {
                        Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                            // Subscribing on every ConnAck, not once before the
                            // loop, is what makes reconnection actually resume
                            // delivery: rumqttc reconnects transparently but the
                            // broker has forgotten the subscription.
                            //
                            // Connected means the SBS subscription succeeded. A
                            // failed aux subscription costs the weather layer,
                            // never the live feed's status.
                            let mut sbs_subscribed = false;
                            for topic in self.topics() {
                                match client.subscribe(topic, self.qos).await {
                                    Ok(()) => {
                                        info!("Subscribed to MQTT topic '{}' at {}", topic, broker);
                                        sbs_subscribed |= topic == self.topic;
                                    }
                                    Err(e) => warn!("MQTT subscribe to '{}' failed: {}", topic, e),
                                }
                            }
                            if sbs_subscribed {
                                connected_at = Some(Instant::now());
                                let _ = self.status_tx.send(SourceStatus::Connected);
                            }
                        }
                        Ok(Event::Incoming(Incoming::Publish(publish))) => {
                            match route_publish(
                                &publish.topic,
                                &self.topic,
                                self.aux_topic.as_deref(),
                            ) {
                                Route::Sbs => {
                                    for line in split_lines(&publish.payload) {
                                        // Fire-and-forget: with no subscribers,
                                        // or a lagging one, dropping is correct
                                        // — this is a live feed, not a queue.
                                        let _ = tx.send(line);
                                    }
                                }
                                Route::Aux => {
                                    if let Some(aux_tx) = &self.aux_tx {
                                        // Latest wins; send_replace stores it
                                        // even before anyone is watching.
                                        aux_tx.send_replace(Some(publish.payload.to_vec()));
                                    }
                                }
                                Route::Ignore => {}
                            }
                        }
                        Ok(_) => {}
                        Err(e) => {
                            let was_connected =
                                *self.status_tx.borrow() == SourceStatus::Connected;

                            // Only a connection that held counts as recovery.
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
                                        "MQTT subscription to {broker} keeps dropping ({attempt} \
                                         times). Another client is probably connected with the \
                                         same id ('{}') and evicting this one. Last error: {e}",
                                        self.client_id
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

                            let _ = self.status_tx.send(SourceStatus::Connecting);

                            // rumqttc does NOT pace this: poll() returns the
                            // error immediately, so without a sleep this spins.
                            tokio::time::sleep(backoff.delay(attempt)).await;
                            attempt = attempt.saturating_add(1);
                        }
                    }
                }
            }
        }

        let _ = self.status_tx.send(SourceStatus::Disconnected);
        Ok(())
    }

    fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
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
            source_id: "pi-roof".to_string(),
            ..Config::default()
        }
    }

    #[test]
    fn test_mqtt_source_name() {
        let source = MqttSource::new(&mqtt_config());
        assert_eq!(source.name(), "mqtt");
    }

    #[test]
    fn test_mqtt_source_starts_disconnected() {
        let source = MqttSource::new(&mqtt_config());
        assert_eq!(*source.status().borrow(), SourceStatus::Disconnected);
    }

    #[test]
    fn test_client_id_is_distinct_from_forwarder() {
        // A source and a forwarder from the same config must not collide on
        // the broker, which evicts a duplicate client id.
        let config = mqtt_config();
        let source = MqttSource::new(&config);
        assert_ne!(source.client_id(), config.mqtt_client_id());
        assert_eq!(source.client_id(), "pi-roof-sub");
    }

    #[test]
    fn test_topic_from_config() {
        let config = Config {
            mqtt_topic: "adsb/custom".to_string(),
            ..mqtt_config()
        };
        assert_eq!(MqttSource::new(&config).topic(), "adsb/custom");
    }

    #[tokio::test]
    async fn test_run_without_subscribe_is_an_error() {
        let mut source = MqttSource::new(&mqtt_config());
        assert!(source.run().await.is_err());
    }

    #[tokio::test]
    async fn test_subscribe_is_idempotent() {
        let mut source = MqttSource::new(&mqtt_config());
        let rx_a = source.subscribe(16);
        let rx_b = source.subscribe(16);
        // Both must observe the same broadcast channel.
        let tx = source.message_tx.as_ref().unwrap();
        assert_eq!(tx.receiver_count(), 2);
        drop((rx_a, rx_b));
    }

    const SBS: &str = "adsb/dev/sbs/raw";
    const WEATHER: &str = "adsb/dev/weather/grid";

    #[test]
    fn test_sbs_topic_routes_to_the_line_splitter() {
        assert_eq!(route_publish(SBS, SBS, Some(WEATHER)), Route::Sbs);
    }

    #[test]
    fn test_aux_topic_is_delivered_whole() {
        assert_eq!(route_publish(WEATHER, SBS, Some(WEATHER)), Route::Aux);
    }

    #[test]
    fn test_without_an_aux_topic_other_topics_are_ignored() {
        // Before weather existed, a stray publish could never reach the SBS
        // parser; that must still hold.
        assert_eq!(route_publish(WEATHER, SBS, None), Route::Ignore);
    }

    #[test]
    fn test_an_unrelated_topic_is_ignored() {
        assert_eq!(
            route_publish("other/topic", SBS, Some(WEATHER)),
            Route::Ignore
        );
    }

    #[test]
    fn test_an_aux_topic_equal_to_the_sbs_topic_keeps_the_live_feed() {
        assert_eq!(route_publish(SBS, SBS, Some(SBS)), Route::Sbs);
    }

    #[test]
    fn test_only_the_sbs_topic_is_subscribed_by_default() {
        let config = mqtt_config();
        let source = MqttSource::new(&config);
        assert_eq!(source.topics(), vec![config.mqtt_topic.as_str()]);
    }

    #[test]
    fn test_with_aux_topic_adds_a_second_subscription() {
        let config = mqtt_config();
        let mut source = MqttSource::new(&config);
        let _rx = source.with_aux_topic(WEATHER);
        assert_eq!(source.topics(), vec![config.mqtt_topic.as_str(), WEATHER]);
    }

    #[test]
    fn test_aux_receiver_starts_empty() {
        let mut source = MqttSource::new(&mqtt_config());
        let rx = source.with_aux_topic(WEATHER);
        assert!(rx.borrow().is_none());
    }

    #[test]
    fn test_with_aux_topic_twice_shares_one_channel() {
        let mut source = MqttSource::new(&mqtt_config());
        let rx_a = source.with_aux_topic(WEATHER);
        let rx_b = source.with_aux_topic(WEATHER);
        assert_eq!(source.aux_tx.as_ref().unwrap().receiver_count(), 2);
        assert_eq!(
            source.topics().len(),
            2,
            "the topic must not be added twice"
        );
        drop((rx_a, rx_b));
    }

    #[test]
    fn test_packet_limit_admits_more_than_the_rumqttc_default() {
        // The rumqttc default (10 KiB) is smaller than a weather snapshot, and
        // an oversized retained message turns into a reconnect storm.
        assert!(MAX_INCOMING_PACKET_BYTES > 10 * 1024);
        let source = MqttSource::new(&mqtt_config());
        assert_eq!(
            source.mqtt_options().max_packet_size(),
            MAX_INCOMING_PACKET_BYTES
        );
    }
}
