//! MQTT subscription source.
//!
//! Subscribes to the topic published by
//! [`MqttForwarder`](crate::forwarder::mqtt_forwarder::MqttForwarder) and
//! republishes each SBS-1 line on a broadcast channel. This is what lets a
//! consumer — the desktop app, or `adsb-data-server` — read a live feed
//! produced by a *different* process with no Apache Pulsar involved.

use crate::config::Config;
use crate::error::{ClientError, Result};
use crate::source::{MessageSource, SourceStatus, split_lines};
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS};
use std::time::Duration;
use tokio::sync::{broadcast, watch};
use tracing::{debug, info, warn};

/// A [`MessageSource`] backed by an MQTT subscription.
pub struct MqttSource {
    broker: String,
    port: u16,
    topic: String,
    client_id: String,
    qos: QoS,
    keep_alive: Duration,
    message_tx: Option<broadcast::Sender<Vec<u8>>>,
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

        let mut options = MqttOptions::new(&self.client_id, &self.broker, self.port);
        options.set_keep_alive(self.keep_alive);

        let (client, mut eventloop) = AsyncClient::new(options, 1024);
        let _ = self.status_tx.send(SourceStatus::Connecting);

        let broker = format!("{}:{}", self.broker, self.port);
        let mut shutdown_rx = self.shutdown_rx.clone();

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
                            if let Err(e) = client.subscribe(&self.topic, self.qos).await {
                                warn!("MQTT subscribe to '{}' failed: {}", self.topic, e);
                            } else {
                                info!("Subscribed to MQTT topic '{}' at {}", self.topic, broker);
                                let _ = self.status_tx.send(SourceStatus::Connected);
                            }
                        }
                        Ok(Event::Incoming(Incoming::Publish(publish))) => {
                            for line in split_lines(&publish.payload) {
                                // Fire-and-forget: with no subscribers, or a
                                // lagging one, dropping is correct — this is a
                                // live feed, not a queue.
                                let _ = tx.send(line);
                            }
                        }
                        Ok(_) => {}
                        Err(e) => {
                            if *self.status_tx.borrow() == SourceStatus::Connected {
                                warn!("MQTT connection to {} lost: {}", broker, e);
                            } else {
                                debug!("MQTT connection to {} pending: {}", broker, e);
                            }
                            let _ = self.status_tx.send(SourceStatus::Connecting);
                            // rumqttc applies its own backoff before retrying.
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
}
