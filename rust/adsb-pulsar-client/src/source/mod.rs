//! Pluggable message *input* sources.
//!
//! [`MessageSource`] is the mirror of [`crate::forwarder::MessageForwarder`]: where a
//! forwarder decides where raw SBS-1 lines *go*, a source decides where they
//! *come from*. Both ends of the crate therefore speak the same currency — a
//! `broadcast::Receiver<Vec<u8>>` of raw SBS-1 lines, the shape
//! [`crate::ADSBFeedClient::with_message_tap`] already produces — so every
//! consumer (the desktop app, `adsb-data-server`) works unchanged regardless of
//! which source feeds it.
//!
//! Two implementations:
//!
//! - [`socket_source::SocketSource`] — a direct dump1090 TCP connection, i.e.
//!   today's behaviour, wrapping [`crate::ADSBFeedClient`].
//! - [`mqtt_source::MqttSource`] — subscribes to the MQTT topic published by
//!   [`crate::forwarder::mqtt_forwarder::MqttForwarder`]. This is what lets a
//!   consumer read a live feed produced by a *different* process (typically the
//!   feed client on a Raspberry Pi) with no Apache Pulsar in the picture.

#[cfg(feature = "mqtt")]
pub mod mqtt_source;
pub mod socket_source;

use crate::error::Result;
use tokio::sync::{broadcast, watch};

/// Connection state of a [`MessageSource`].
///
/// Deliberately coarser than the desktop app's own status enum: a source
/// reports what it can observe about its transport, and the consumer layers
/// activity-based degradation (no messages for N seconds) on top.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SourceStatus {
    /// Not connected, and not currently trying.
    #[default]
    Disconnected,
    /// Attempting to establish the connection.
    Connecting,
    /// Transport is up and messages may flow.
    Connected,
}

/// Splits a received payload into individual SBS-1 lines.
///
/// [`MqttForwarder`](crate::forwarder::mqtt_forwarder::MqttForwarder) publishes
/// one line per message, but nothing in MQTT guarantees a producer will not
/// batch several lines into one payload, and a payload arrives as an opaque
/// blob with no framing of its own. Splitting here keeps the invariant every
/// consumer relies on: **one broadcast message is exactly one SBS-1 line**.
///
/// Blank lines are dropped and CRLF is normalised, matching the line handling
/// in [`crate::ADSBFeedClient`]'s socket path.
pub fn split_lines(payload: &[u8]) -> Vec<Vec<u8>> {
    payload
        .split(|&b| b == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line))
        .filter(|line| !line.is_empty())
        .map(|line| line.to_vec())
        .collect()
}

/// Trait for message input backends.
///
/// Implementors own their connection lifecycle and publish received SBS-1
/// lines to subscribers created via [`MessageSource::subscribe`].
#[async_trait::async_trait]
pub trait MessageSource: Send {
    /// Returns a receiver for raw SBS-1 lines.
    ///
    /// May be called multiple times; all subscribers share one broadcast
    /// channel, so a slow subscriber lags rather than blocking the source.
    fn subscribe(&mut self, capacity: usize) -> broadcast::Receiver<Vec<u8>>;

    /// Watch channel reporting transport connection state.
    fn status(&self) -> watch::Receiver<SourceStatus>;

    /// Runs the source until shutdown is requested or a fatal error occurs.
    async fn run(&mut self) -> Result<()>;

    /// Requests a graceful shutdown. Safe to call from any thread.
    fn shutdown(&self);

    /// Human-readable name for this source (e.g. "socket", "mqtt").
    fn name(&self) -> &str;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_starts_disconnected() {
        assert_eq!(SourceStatus::default(), SourceStatus::Disconnected);
    }

    #[test]
    fn test_split_lines_single() {
        let out = split_lines(b"MSG,3,1,1,ABC123,1\n");
        assert_eq!(out, vec![b"MSG,3,1,1,ABC123,1".to_vec()]);
    }

    #[test]
    fn test_split_lines_handles_missing_trailing_newline() {
        let out = split_lines(b"MSG,3,1,1,ABC123,1");
        assert_eq!(out, vec![b"MSG,3,1,1,ABC123,1".to_vec()]);
    }

    #[test]
    fn test_split_lines_batched_payload() {
        // A producer may batch several lines into one MQTT payload.
        let out = split_lines(b"LINE_A\nLINE_B\nLINE_C\n");
        assert_eq!(out.len(), 3);
        assert_eq!(out[2], b"LINE_C".to_vec());
    }

    #[test]
    fn test_split_lines_strips_crlf() {
        let out = split_lines(b"MSG,3\r\nMSG,4\r\n");
        assert_eq!(out, vec![b"MSG,3".to_vec(), b"MSG,4".to_vec()]);
    }

    #[test]
    fn test_split_lines_skips_blank_lines() {
        let out = split_lines(b"MSG,3\n\n\nMSG,4\n");
        assert_eq!(out, vec![b"MSG,3".to_vec(), b"MSG,4".to_vec()]);
    }

    #[test]
    fn test_split_lines_empty_payload() {
        assert!(split_lines(b"").is_empty());
    }
}
