//! Pulsar-based message forwarder.
//!
//! Wraps the Apache Pulsar client and producer, handling connection,
//! reconnection, and batched message sending.

use crate::config::Config;
use crate::error::{ClientError, Result};
use crate::forwarder::MessageForwarder;
use pulsar::{producer, Producer, Pulsar, TokioExecutor};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tracing::{info, warn};

/// Pulsar message forwarder.
///
/// Owns the Pulsar client and producer, handling connection lifecycle
/// and background reconnection.
pub struct PulsarForwarder {
    broker: String,
    topic: String,
    producer_name: String,
    batch_max_messages: u32,
    initial_retry_delay: Duration,
    max_retry_delay: Duration,
    client: Option<Pulsar<TokioExecutor>>,
    producer: Option<Producer<TokioExecutor>>,
    reconnect_rx: mpsc::UnboundedReceiver<(Pulsar<TokioExecutor>, Producer<TokioExecutor>)>,
    reconnect_tx: mpsc::UnboundedSender<(Pulsar<TokioExecutor>, Producer<TokioExecutor>)>,
    reconnect_task_running: bool,
}

impl PulsarForwarder {
    /// Creates a new PulsarForwarder from a Config.
    pub fn new(config: &Config) -> Self {
        let (reconnect_tx, reconnect_rx) = mpsc::unbounded_channel();
        Self {
            broker: config.pulsar_broker.clone(),
            topic: config.pulsar_topic.clone(),
            producer_name: config.source_id.clone(),
            batch_max_messages: config.pulsar_batch_max_messages,
            initial_retry_delay: config.initial_retry_delay(),
            max_retry_delay: config.max_retry_delay(),
            client: None,
            producer: None,
            reconnect_rx,
            reconnect_tx,
            reconnect_task_running: false,
        }
    }

    /// Polls the reconnect channel without blocking.
    fn poll_reconnect(&mut self) {
        if let Ok((client, producer)) = self.reconnect_rx.try_recv() {
            info!("Pulsar reconnected successfully");
            self.client = Some(client);
            self.producer = Some(producer);
            self.reconnect_task_running = false;
        }
    }

    /// Spawns a background task to reconnect to Pulsar.
    fn start_reconnect_task(&mut self) {
        if self.producer.is_some() || self.reconnect_task_running {
            return;
        }

        let broker = self.broker.clone();
        let topic = self.topic.clone();
        let producer_name = self.producer_name.clone();
        let batch_max_messages = self.batch_max_messages;
        let initial_retry_delay = self.initial_retry_delay;
        let max_retry_delay = self.max_retry_delay;
        let tx = self.reconnect_tx.clone();

        self.reconnect_task_running = true;

        tokio::spawn(async move {
            let mut retry_delay = initial_retry_delay;
            let mut attempt = 0u32;

            loop {
                attempt += 1;
                info!(
                    "Connecting to Pulsar broker at {} (attempt {})",
                    broker, attempt
                );

                let connect_result = Pulsar::builder(&broker, TokioExecutor).build().await;

                match connect_result {
                    Ok(pulsar) => {
                        let producer_result = pulsar
                            .producer()
                            .with_topic(&topic)
                            .with_name(&producer_name)
                            .with_options(producer::ProducerOptions {
                                batch_size: Some(batch_max_messages),
                                ..Default::default()
                            })
                            .build()
                            .await;

                        match producer_result {
                            Ok(producer) => {
                                info!(
                                    "Successfully connected to Pulsar. Topic: {}, Producer: {}",
                                    topic, producer_name
                                );
                                let _ = tx.send((pulsar, producer));
                                return;
                            }
                            Err(e) => {
                                warn!(
                                    "Failed to create Pulsar producer: {}. Retrying in {:?}...",
                                    e, retry_delay
                                );
                            }
                        }
                    }
                    Err(e) => {
                        warn!(
                            "Failed to connect to Pulsar: {}. Retrying in {:?}...",
                            e, retry_delay
                        );
                    }
                }

                sleep(retry_delay).await;
                retry_delay = std::cmp::min(retry_delay * 2, max_retry_delay);
            }
        });
    }
}

#[async_trait::async_trait]
impl MessageForwarder for PulsarForwarder {
    async fn connect(&mut self) -> Result<()> {
        self.start_reconnect_task();
        Ok(())
    }

    async fn send(&mut self, message: &[u8]) -> Result<()> {
        // Check for reconnection result
        self.poll_reconnect();

        if let Some(producer) = &mut self.producer {
            producer
                .send_non_blocking(message)
                .await
                .map_err(|e: pulsar::error::Error| ClientError::Pulsar(e))?;
            Ok(())
        } else {
            Err(ClientError::Forwarder(
                "Pulsar producer not connected".into(),
            ))
        }
    }

    async fn flush(&mut self) -> Result<()> {
        self.poll_reconnect();
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        self.producer = None;
        self.client = None;
        self.start_reconnect_task();
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.producer.is_some()
    }

    fn name(&self) -> &str {
        "pulsar"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        let mut config = Config::default();
        config.test_mode = true;
        config
    }

    #[test]
    fn test_pulsar_forwarder_not_connected_initially() {
        let forwarder = PulsarForwarder::new(&test_config());
        assert!(!forwarder.is_connected());
    }

    #[test]
    fn test_pulsar_forwarder_name() {
        let forwarder = PulsarForwarder::new(&test_config());
        assert_eq!(forwarder.name(), "pulsar");
    }
}
