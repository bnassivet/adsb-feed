//! MQTT subscription source.
//!
//! Subscribes to the topic published by
//! [`MqttForwarder`](crate::forwarder::mqtt_forwarder::MqttForwarder) and
//! republishes each SBS-1 line on a broadcast channel. This is what lets a
//! consumer — the desktop app, or `adsb-data-server` — read a live feed
//! produced by a *different* process with no Apache Pulsar involved.

use crate::backoff::{Backoff, looks_like_id_collision, should_log, should_reset, was_short_lived};
use crate::config::{Config, receiver_from_topic};
use crate::error::{ClientError, Result};
use crate::source::{MessageSource, SourceStatus, split_lines};
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS};
use std::sync::Arc;
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
pub enum Route<'a> {
    /// Raw SBS-1: split into lines and broadcast. `receiver` is the feed's id
    /// when it published to `<topic>/<source_id>`, `None` on the base topic.
    Sbs { receiver: Option<&'a str> },
    /// A feed announcing its own location (`.../receiver/<source_id>`).
    Announcement { receiver: &'a str },
    /// An auxiliary topic, by its index in registration order: delivered
    /// whole, never line-split.
    Aux(usize),
    /// None of them: ignored.
    Ignore,
}

/// Decides where a publish on `topic` goes.
///
/// The SBS topic is checked first, and before the aux topics are even looked
/// at: this runs for every SBS publish, so that path must stay allocation-free
/// -- hence an iterator rather than a slice built per call. If a hand-edited
/// config makes an aux topic equal to the SBS topic, the live feed keeps
/// working and only that aux payload is lost.
///
/// Then exact aux topics, then a feed's own topic one level below the SBS
/// topic, then -- when `announce_prefix` is given -- a location announcement
/// one level below it.
pub fn route_publish<'t, 'a>(
    topic: &'t str,
    sbs_topic: &str,
    announce_prefix: Option<&str>,
    aux_topics: impl IntoIterator<Item = &'a str>,
) -> Route<'t> {
    if topic == sbs_topic {
        return Route::Sbs { receiver: None };
    }
    if let Some(index) = aux_topics.into_iter().position(|aux| aux == topic) {
        return Route::Aux(index);
    }
    if let Some(receiver) = receiver_from_topic(topic, sbs_topic) {
        return Route::Sbs {
            receiver: Some(receiver),
        };
    }
    match announce_prefix.and_then(|prefix| receiver_from_topic(topic, prefix)) {
        Some(receiver) => Route::Announcement { receiver },
        None => Route::Ignore,
    }
}

/// One SBS-1 line and the receiver whose topic it arrived on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourcedLine {
    /// `None` for a feed publishing to the base topic: the subscriber
    /// attributes those to its own default.
    pub receiver: Option<Arc<str>>,
    pub line: Vec<u8>,
}

/// A receiver's location announcement: the receiver named by the topic, and
/// the payload as published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    pub receiver: String,
    pub payload: Vec<u8>,
}

/// Which keyed prefix `topic` falls under, and its key: `<prefix>/<key>`,
/// exactly one level below. Checked only for publishes nothing else claimed.
pub fn route_keyed<'t, 'a>(
    topic: &'t str,
    prefixes: impl IntoIterator<Item = &'a str>,
) -> Option<(usize, &'t str)> {
    prefixes
        .into_iter()
        .enumerate()
        .find_map(|(i, prefix)| receiver_from_topic(topic, prefix).map(|key| (i, key)))
}

/// The latest payload per key under one prefix.
pub type KeyedPayloads = std::collections::BTreeMap<String, Vec<u8>>;

/// A keyed auxiliary prefix and the channel its payloads are kept in.
struct KeyedAux {
    prefix: String,
    tx: watch::Sender<KeyedPayloads>,
}

/// An auxiliary topic and the channel its latest payload is kept in, plus,
/// when asked for, a queue of every payload.
struct AuxTopic {
    topic: String,
    tx: watch::Sender<Option<Vec<u8>>>,
    stream: Option<broadcast::Sender<Vec<u8>>>,
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
    /// Lines paired with their receiver, for a consumer that must attribute
    /// them (the recorder). Only filled when someone asked for it.
    sourced_tx: Option<broadcast::Sender<SourcedLine>>,
    /// `.../receiver`: where feeds announce their location.
    announce_prefix: String,
    announce_tx: Option<broadcast::Sender<Announcement>>,
    /// Further topics on the same connection (the weather service's grid,
    /// status and availability), in registration order.
    aux: Vec<AuxTopic>,
    /// Prefixes whose `<prefix>/<key>` topics are kept per key (every
    /// receiver's weather grid).
    keyed: Vec<KeyedAux>,
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
            sourced_tx: None,
            announce_prefix: config
                .receiver_announce_filter()
                .trim_end_matches("/+")
                .to_string(),
            announce_tx: None,
            aux: Vec::new(),
            keyed: Vec::new(),
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
    /// Built for retained documents -- the weather grid, and the weather
    /// service's status and availability: never SBS-1, so they must never
    /// reach the line splitter or the SBS broadcast, and only the newest one
    /// matters. Each topic gets its own channel; asking for a topic already
    /// registered hands out another receiver on that topic's channel.
    pub fn with_aux_topic(&mut self, topic: impl Into<String>) -> watch::Receiver<Option<Vec<u8>>> {
        let topic = topic.into();
        if let Some(existing) = self.aux.iter().find(|aux| aux.topic == topic) {
            return existing.tx.subscribe();
        }
        let (tx, rx) = watch::channel(None);
        self.aux.push(AuxTopic {
            topic,
            tx,
            stream: None,
        });
        rx
    }

    /// Also subscribes to `topic`, delivering **every** payload whole, in
    /// order, through the returned broadcast channel.
    ///
    /// For non-retained records that must each be kept (fetched OpenSky
    /// tracks, polls): `with_aux_topic`'s "latest wins" would drop one
    /// arriving before the previous was read. Shares the topic's subscription
    /// with `with_aux_topic`; a reader lagging by more than `capacity` loses
    /// the oldest, as any live feed would.
    pub fn with_aux_stream(
        &mut self,
        topic: impl Into<String>,
        capacity: usize,
    ) -> broadcast::Receiver<Vec<u8>> {
        let topic = topic.into();
        let index = match self.aux.iter().position(|aux| aux.topic == topic) {
            Some(index) => index,
            None => {
                let _ = self.with_aux_topic(topic);
                self.aux.len() - 1
            }
        };
        self.aux[index]
            .stream
            .get_or_insert_with(|| broadcast::channel(capacity).0)
            .subscribe()
    }

    /// Hands one aux publish to its readers: the latest-wins watch (which
    /// stores it even before anyone is watching) and the stream, if any.
    fn deliver_aux(&self, index: usize, payload: &[u8]) {
        let aux = &self.aux[index];
        aux.tx.send_replace(Some(payload.to_vec()));
        if let Some(stream) = &aux.stream {
            // No reader yet, or none left: nothing to keep it for.
            let _ = stream.send(payload.to_vec());
        }
    }

    /// Also subscribes to `<prefix>/+`, keeping the latest payload of each
    /// `<prefix>/<key>` whole, by key. An empty payload (a cleared retained
    /// message) removes the key. Asking twice for one prefix shares its
    /// channel.
    pub fn with_keyed_aux(&mut self, prefix: impl Into<String>) -> watch::Receiver<KeyedPayloads> {
        let prefix = prefix.into();
        if let Some(existing) = self.keyed.iter().find(|k| k.prefix == prefix) {
            return existing.tx.subscribe();
        }
        let (tx, rx) = watch::channel(KeyedPayloads::new());
        self.keyed.push(KeyedAux { prefix, tx });
        rx
    }

    /// Files one publish under its keyed prefix, if it has one. Returns
    /// whether it did.
    fn deliver_keyed(&self, topic: &str, payload: &[u8]) -> bool {
        let Some((index, key)) = route_keyed(topic, self.keyed.iter().map(|k| k.prefix.as_str()))
        else {
            return false;
        };
        // send_modify stores it even before anyone is watching.
        self.keyed[index].tx.send_modify(|held| {
            if payload.is_empty() {
                held.remove(key);
            } else {
                held.insert(key.to_string(), payload.to_vec());
            }
        });
        true
    }

    /// Lines with the receiver each came from (see [`SourcedLine`]).
    /// Idempotent: a second call shares the channel.
    pub fn subscribe_sourced(&mut self, capacity: usize) -> broadcast::Receiver<SourcedLine> {
        match &self.sourced_tx {
            Some(tx) => tx.subscribe(),
            None => {
                let (tx, rx) = broadcast::channel(capacity);
                self.sourced_tx = Some(tx);
                rx
            }
        }
    }

    /// Also subscribes to every feed's location announcement.
    pub fn with_receiver_announcements(&mut self) -> broadcast::Receiver<Announcement> {
        // Retained, one per receiver, replayed on every reconnect: a small
        // channel is plenty, and a lagging reader only loses repeats.
        self.announce_tx
            .get_or_insert_with(|| broadcast::channel(64).0)
            .subscribe()
    }

    /// Delivers one SBS publish to whoever subscribed: line-split, to the
    /// plain channel and, with its receiver, to the sourced one.
    fn deliver_sbs(&self, payload: &[u8], receiver: Option<&str>) {
        // One allocation per publish, and only when someone attributes lines.
        let receiver: Option<Arc<str>> = self.sourced_tx.as_ref().and(receiver).map(Arc::from);
        for line in split_lines(payload) {
            // Fire-and-forget: with no subscribers, or a lagging one,
            // dropping is correct -- this is a live feed, not a queue.
            if let Some(tx) = &self.sourced_tx {
                let _ = tx.send(SourcedLine {
                    receiver: receiver.clone(),
                    line: line.clone(),
                });
            }
            if let Some(tx) = &self.message_tx {
                let _ = tx.send(line);
            }
        }
    }

    /// Every topic this source subscribes to on connect, SBS first.
    ///
    /// An aux topic equal to the SBS topic is not subscribed twice; routing
    /// already treats it as SBS.
    pub fn topics(&self) -> Vec<String> {
        let mut topics = vec![self.topic.clone(), format!("{}/+", self.topic)];
        topics.extend(
            self.aux
                .iter()
                .map(|aux| aux.topic.clone())
                .filter(|aux| *aux != self.topic),
        );
        if self.announce_tx.is_some() {
            topics.push(format!("{}/+", self.announce_prefix));
        }
        topics.extend(self.keyed.iter().map(|k| format!("{}/+", k.prefix)));
        topics
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
        if self.message_tx.is_none() && self.sourced_tx.is_none() {
            return Err(ClientError::Config(
                "MqttSource::run called before subscribe".into(),
            ));
        }

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
                                match client.subscribe(&topic, self.qos).await {
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
                                self.announce_tx.as_ref().map(|_| self.announce_prefix.as_str()),
                                self.aux.iter().map(|aux| aux.topic.as_str()),
                            ) {
                                Route::Sbs { receiver } => {
                                    self.deliver_sbs(&publish.payload, receiver);
                                }
                                Route::Announcement { receiver } => {
                                    if let Some(tx) = &self.announce_tx {
                                        let _ = tx.send(Announcement {
                                            receiver: receiver.to_string(),
                                            payload: publish.payload.to_vec(),
                                        });
                                    }
                                }
                                Route::Aux(index) => {
                                    self.deliver_aux(index, &publish.payload);
                                }
                                Route::Ignore => {
                                    self.deliver_keyed(&publish.topic, &publish.payload);
                                }
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
        assert_eq!(
            route_publish(SBS, SBS, None, Some(WEATHER)),
            Route::Sbs { receiver: None }
        );
    }

    const STATUS: &str = "adsb/dev/weather/status";
    const AVAILABILITY: &str = "adsb/dev/weather/availability";

    #[test]
    fn test_aux_topic_is_delivered_whole() {
        assert_eq!(
            route_publish(WEATHER, SBS, None, Some(WEATHER)),
            Route::Aux(0)
        );
    }

    #[test]
    fn test_each_aux_topic_routes_to_its_own_index() {
        let aux = [WEATHER, STATUS, AVAILABILITY];
        assert_eq!(route_publish(WEATHER, SBS, None, aux), Route::Aux(0));
        assert_eq!(route_publish(STATUS, SBS, None, aux), Route::Aux(1));
        assert_eq!(route_publish(AVAILABILITY, SBS, None, aux), Route::Aux(2));
        assert_eq!(
            route_publish(SBS, SBS, None, aux),
            Route::Sbs { receiver: None }
        );
    }

    #[test]
    fn test_several_aux_topics_are_each_subscribed_once() {
        let config = mqtt_config();
        let mut source = MqttSource::new(&config);
        let _w = source.with_aux_topic(WEATHER);
        let _s = source.with_aux_topic(STATUS);
        let _w_again = source.with_aux_topic(WEATHER);
        assert_eq!(
            source.topics(),
            vec![
                config.mqtt_topic.as_str(),
                "adsb/sbs/raw/+",
                WEATHER,
                STATUS
            ]
        );
    }

    #[test]
    fn test_each_aux_topic_has_its_own_channel() {
        // A status payload must never land in the weather grid's channel.
        let mut source = MqttSource::new(&mqtt_config());
        let weather = source.with_aux_topic(WEATHER);
        let status = source.with_aux_topic(STATUS);

        source.aux[1].tx.send_replace(Some(b"status".to_vec()));
        assert_eq!(status.borrow().as_deref(), Some(&b"status"[..]));
        assert!(weather.borrow().is_none());
    }

    const TRACKS: &str = "adsb/dev/opensky/tracks";

    #[test]
    fn test_an_aux_stream_delivers_every_payload_in_order() {
        // Non-retained records (fetched OpenSky tracks) must not be lost to
        // "latest wins": two in quick succession are both delivered.
        let mut source = MqttSource::new(&mqtt_config());
        let mut stream = source.with_aux_stream(TRACKS, 8);
        let latest = source.with_aux_topic(TRACKS);
        source.deliver_aux(0, b"one");
        source.deliver_aux(0, b"two");
        assert_eq!(stream.try_recv().unwrap(), b"one".to_vec());
        assert_eq!(stream.try_recv().unwrap(), b"two".to_vec());
        // The same topic's watch still holds the latest, and it is subscribed once.
        assert_eq!(latest.borrow().as_deref(), Some(&b"two"[..]));
        assert_eq!(source.topics().iter().filter(|t| *t == TRACKS).count(), 1);
    }

    #[test]
    fn test_without_an_aux_topic_other_topics_are_ignored() {
        // Before weather existed, a stray publish could never reach the SBS
        // parser; that must still hold.
        assert_eq!(route_publish(WEATHER, SBS, None, None), Route::Ignore);
    }

    #[test]
    fn test_an_unrelated_topic_is_ignored() {
        assert_eq!(
            route_publish("other/topic", SBS, None, Some(WEATHER)),
            Route::Ignore
        );
    }

    #[test]
    fn test_an_aux_topic_equal_to_the_sbs_topic_keeps_the_live_feed() {
        assert_eq!(
            route_publish(SBS, SBS, None, Some(SBS)),
            Route::Sbs { receiver: None }
        );
    }

    #[test]
    fn test_by_default_the_sbs_topic_and_one_level_below_are_subscribed() {
        // One level below is where feeds that name themselves publish.
        let config = mqtt_config();
        let source = MqttSource::new(&config);
        assert_eq!(
            source.topics(),
            vec![config.mqtt_topic.as_str(), "adsb/sbs/raw/+"]
        );
    }

    #[test]
    fn test_with_aux_topic_adds_a_second_subscription() {
        let config = mqtt_config();
        let mut source = MqttSource::new(&config);
        let _rx = source.with_aux_topic(WEATHER);
        assert_eq!(
            source.topics(),
            vec![config.mqtt_topic.as_str(), "adsb/sbs/raw/+", WEATHER]
        );
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
        assert_eq!(source.aux[0].tx.receiver_count(), 2);
        assert_eq!(
            source.topics().len(),
            3,
            "the topic must not be added twice"
        );
        drop((rx_a, rx_b));
    }

    const ANNOUNCE: &str = "adsb/dev/receiver";

    #[test]
    fn test_a_feed_s_own_topic_routes_to_the_sbs_path_with_its_id() {
        assert_eq!(
            route_publish("adsb/dev/sbs/raw/pi-a", SBS, Some(ANNOUNCE), Some(WEATHER)),
            Route::Sbs {
                receiver: Some("pi-a")
            }
        );
        // Two levels below is not a feed topic.
        assert_eq!(
            route_publish("adsb/dev/sbs/raw/pi-a/x", SBS, Some(ANNOUNCE), None),
            Route::Ignore
        );
    }

    #[test]
    fn test_an_announcement_routes_only_when_asked_for() {
        let topic = "adsb/dev/receiver/pi-a";
        assert_eq!(
            route_publish(topic, SBS, Some(ANNOUNCE), None),
            Route::Announcement { receiver: "pi-a" }
        );
        assert_eq!(route_publish(topic, SBS, None, None), Route::Ignore);
    }

    #[test]
    fn test_announcements_add_their_filter_once() {
        let mut source = MqttSource::new(&mqtt_config());
        let _a = source.with_receiver_announcements();
        let _b = source.with_receiver_announcements();
        assert_eq!(
            source.topics(),
            vec!["adsb/sbs/raw", "adsb/sbs/raw/+", "adsb/receiver/+"]
        );
    }

    #[test]
    fn test_sbs_lines_reach_both_channels_with_their_receiver() {
        let mut source = MqttSource::new(&mqtt_config());
        let mut plain = source.subscribe(16);
        let mut sourced = source.subscribe_sourced(16);
        source.deliver_sbs(b"MSG,1\nMSG,3", Some("pi-a"));
        source.deliver_sbs(b"MSG,4", None);

        assert_eq!(plain.try_recv().unwrap(), b"MSG,1");
        assert_eq!(plain.try_recv().unwrap(), b"MSG,3");
        assert_eq!(plain.try_recv().unwrap(), b"MSG,4");
        let first = sourced.try_recv().unwrap();
        assert_eq!(first.receiver.as_deref(), Some("pi-a"));
        assert_eq!(first.line, b"MSG,1");
        assert_eq!(
            sourced.try_recv().unwrap().receiver.as_deref(),
            Some("pi-a")
        );
        assert_eq!(sourced.try_recv().unwrap().receiver, None);
    }

    #[tokio::test]
    async fn test_a_sourced_subscriber_alone_can_run_the_source() {
        // The recorder subscribes only to the sourced channel; run() must not
        // demand the plain one. (It fails to connect here, which is fine: the
        // point is that it gets past the subscriber check.)
        let mut source = MqttSource::new(&Config {
            mqtt_broker: "127.0.0.1".into(),
            mqtt_port: 1,
            ..mqtt_config()
        });
        let _rx = source.subscribe_sourced(16);
        let handle = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_millis(200), source.run()).await
        });
        assert!(
            handle.await.unwrap().is_err(),
            "still running when the timeout hit, i.e. it did not refuse to start"
        );
    }

    const GRIDS: &str = "adsb/dev/weather/grid";

    #[test]
    fn test_keyed_topics_route_one_level_below_their_prefix() {
        let prefixes = ["adsb/dev/other", GRIDS];
        assert_eq!(
            route_keyed("adsb/dev/weather/grid/pi-a", prefixes),
            Some((1, "pi-a"))
        );
        assert_eq!(
            route_keyed(GRIDS, prefixes),
            None,
            "the prefix itself is not keyed"
        );
        assert_eq!(route_keyed("adsb/dev/weather/grid/a/b", prefixes), None);
        assert_eq!(route_keyed("adsb/dev/weather/status", prefixes), None);
    }

    #[test]
    fn test_keyed_payloads_are_kept_per_key_and_cleared_by_an_empty_one() {
        let mut source = MqttSource::new(&mqtt_config());
        let grids = source.with_keyed_aux(GRIDS);
        let again = source.with_keyed_aux(GRIDS);
        assert_eq!(source.keyed.len(), 1, "one channel per prefix");
        assert!(source.topics().contains(&format!("{GRIDS}/+")));

        assert!(source.deliver_keyed("adsb/dev/weather/grid/pi-a", b"A1"));
        assert!(source.deliver_keyed("adsb/dev/weather/grid/pi-b", b"B1"));
        assert!(source.deliver_keyed("adsb/dev/weather/grid/pi-a", b"A2"));
        assert!(!source.deliver_keyed("adsb/dev/weather/status", b"x"));
        let held: Vec<(String, Vec<u8>)> = grids.borrow().clone().into_iter().collect();
        assert_eq!(
            held,
            vec![
                ("pi-a".into(), b"A2".to_vec()),
                ("pi-b".into(), b"B1".to_vec())
            ]
        );
        assert!(source.deliver_keyed("adsb/dev/weather/grid/pi-b", b""));
        assert_eq!(again.borrow().len(), 1);
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
