//! Direct dump1090 TCP source.
//!
//! Wraps [`ADSBFeedClient`] so today's direct-socket behaviour is reachable
//! through the [`MessageSource`] trait alongside [`MqttSource`](super::mqtt_source::MqttSource).
//! Behaviour-preserving: the client still owns reconnection, heartbeat
//! detection and metrics.

use crate::client::ADSBFeedClient;
use crate::config::Config;
use crate::error::Result;
use crate::forwarder::{MessageForwarder, NoopForwarder};
use crate::metrics::Metrics;
use crate::source::{MessageSource, SourceStatus};
use tokio::sync::{broadcast, watch};

/// A [`MessageSource`] backed by a direct dump1090 TCP connection.
pub struct SocketSource {
    client: ADSBFeedClient,
    status_tx: watch::Sender<SourceStatus>,
    status_rx: watch::Receiver<SourceStatus>,
}

impl SocketSource {
    /// Creates a source that connects straight to dump1090.
    ///
    /// Uses a [`NoopForwarder`]: this path exists to *consume* the feed, so
    /// messages leave through the tap rather than through a forwarder.
    pub fn new(config: Config) -> Result<Self> {
        Self::with_forwarders(config, vec![Box::new(NoopForwarder)])
    }

    /// Creates a source with explicit forwarders, for callers that want to
    /// consume the feed *and* republish it.
    pub fn with_forwarders(
        config: Config,
        forwarders: Vec<Box<dyn MessageForwarder>>,
    ) -> Result<Self> {
        let client = ADSBFeedClient::new(config, forwarders)?;
        let (status_tx, status_rx) = watch::channel(SourceStatus::Disconnected);
        Ok(Self {
            client,
            status_tx,
            status_rx,
        })
    }

    /// Returns a clone of the underlying client's metrics handle.
    pub fn metrics(&self) -> Metrics {
        self.client.metrics()
    }
}

#[async_trait::async_trait]
impl MessageSource for SocketSource {
    fn subscribe(&mut self, capacity: usize) -> broadcast::Receiver<Vec<u8>> {
        self.client.with_message_tap(capacity)
    }

    fn status(&self) -> watch::Receiver<SourceStatus> {
        self.status_rx.clone()
    }

    async fn run(&mut self) -> Result<()> {
        let _ = self.status_tx.send(SourceStatus::Connecting);
        let result = self.client.run().await;
        let _ = self.status_tx.send(SourceStatus::Disconnected);
        result
    }

    fn shutdown(&self) {
        self.client.shutdown();
    }

    fn name(&self) -> &str {
        "socket"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_socket_source_name() {
        let source = SocketSource::new(Config::default()).unwrap();
        assert_eq!(source.name(), "socket");
    }

    #[test]
    fn test_socket_source_starts_disconnected() {
        let source = SocketSource::new(Config::default()).unwrap();
        assert_eq!(*source.status().borrow(), SourceStatus::Disconnected);
    }

    #[test]
    fn test_socket_source_rejects_invalid_config() {
        let config = Config {
            source_id: String::new(),
            ..Config::default()
        };
        assert!(SocketSource::new(config).is_err());
    }
}
