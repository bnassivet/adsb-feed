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
use std::time::Duration;
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

/// Health of a feed, as a consumer's UI would present it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    /// Transport is coming up.
    Connecting,
    /// Transport is up and messages are arriving.
    Healthy,
    /// Transport is up but has gone quiet longer than expected.
    Degraded,
    /// Transport is down, or quiet long enough to treat as down.
    Lost,
}

/// How long a feed may go quiet before it is considered degraded, then lost.
///
/// This exists because the two sources have **no comparable timeout**. A
/// [`SocketSource`](socket_source::SocketSource) has a TCP read timeout, and
/// today's desktop watchdog derives its thresholds from it. A
/// [`MqttSource`](mqtt_source::MqttSource) has no such thing — reusing the
/// socket numbers there produces a connection indicator that is confidently
/// wrong. What an MQTT subscriber does have is dump1090's 60s heartbeat,
/// relayed through the feed client, so silence is measured against that
/// instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LivenessPolicy {
    /// Quiet longer than this: degraded.
    pub degraded_after: Duration,
    /// Quiet longer than this: lost.
    pub lost_after: Duration,
}

impl LivenessPolicy {
    /// Thresholds for a direct dump1090 socket, derived from its read timeout.
    ///
    /// Preserves the desktop app's long-standing `read_timeout + 10s / + 30s`.
    pub fn for_socket(read_timeout_secs: u64) -> Self {
        Self {
            degraded_after: Duration::from_secs(read_timeout_secs + 10),
            lost_after: Duration::from_secs(read_timeout_secs + 30),
        }
    }

    /// Thresholds for an MQTT subscription, derived from the heartbeat interval.
    ///
    /// A published feed is quiet only if the *upstream* receiver is quiet, and
    /// dump1090 emits a heartbeat every 60s. One and a half missed heartbeats
    /// is a real signal; three is a dead feed. Deliberately more forgiving than
    /// the socket policy, because this path has an extra hop that can retry
    /// without the consumer noticing.
    pub fn for_mqtt(heartbeat_secs: u64) -> Self {
        Self {
            degraded_after: Duration::from_secs(heartbeat_secs + heartbeat_secs / 2),
            lost_after: Duration::from_secs(heartbeat_secs * 3),
        }
    }

    /// Resolves transport state plus quiet time into a health verdict.
    ///
    /// Transport state wins: a broker that has dropped us is `Lost` even if a
    /// message arrived a moment ago, because the timers describe the *feed*
    /// while the transport describes the *connection*.
    pub fn resolve(&self, transport: SourceStatus, quiet_for: Duration) -> Liveness {
        match transport {
            SourceStatus::Disconnected => Liveness::Lost,
            SourceStatus::Connecting => Liveness::Connecting,
            SourceStatus::Connected => {
                if quiet_for >= self.lost_after {
                    Liveness::Lost
                } else if quiet_for >= self.degraded_after {
                    Liveness::Degraded
                } else {
                    Liveness::Healthy
                }
            }
        }
    }
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

#[cfg(test)]
mod liveness_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn socket_policy_derives_from_the_read_timeout() {
        // Today's behaviour, preserved: read_timeout + 10s / + 30s.
        let p = LivenessPolicy::for_socket(75);
        assert_eq!(p.degraded_after, Duration::from_secs(85));
        assert_eq!(p.lost_after, Duration::from_secs(105));
    }

    #[test]
    fn mqtt_policy_derives_from_the_heartbeat_not_a_read_timeout() {
        // A broker subscription has no TCP read timeout. What it does have is
        // dump1090's 60s heartbeat, relayed through the feed client, so
        // silence past ~1.5 heartbeats is the meaningful signal.
        let p = LivenessPolicy::for_mqtt(60);
        assert_eq!(p.degraded_after, Duration::from_secs(90));
        assert_eq!(p.lost_after, Duration::from_secs(180));
    }

    #[test]
    fn mqtt_and_socket_policies_differ() {
        // The regression this guards: reusing the socket thresholds for MQTT
        // makes the UI's connection indicator confidently wrong.
        assert_ne!(
            LivenessPolicy::for_socket(75).degraded_after,
            LivenessPolicy::for_mqtt(60).degraded_after
        );
    }

    #[test]
    fn a_disconnected_transport_is_lost_regardless_of_timers() {
        // Transport state is authoritative. A broker that dropped us is lost
        // even if a message arrived a moment ago.
        let p = LivenessPolicy::for_mqtt(60);
        assert_eq!(
            p.resolve(SourceStatus::Disconnected, Duration::from_secs(0)),
            Liveness::Lost
        );
    }

    #[test]
    fn a_connecting_transport_reports_connecting() {
        let p = LivenessPolicy::for_mqtt(60);
        assert_eq!(
            p.resolve(SourceStatus::Connecting, Duration::from_secs(0)),
            Liveness::Connecting
        );
    }

    #[test]
    fn a_connected_transport_with_recent_traffic_is_healthy() {
        let p = LivenessPolicy::for_socket(75);
        assert_eq!(
            p.resolve(SourceStatus::Connected, Duration::from_secs(5)),
            Liveness::Healthy
        );
    }

    #[test]
    fn silence_degrades_then_is_lost() {
        let p = LivenessPolicy::for_socket(75);
        assert_eq!(
            p.resolve(SourceStatus::Connected, Duration::from_secs(90)),
            Liveness::Degraded
        );
        assert_eq!(
            p.resolve(SourceStatus::Connected, Duration::from_secs(200)),
            Liveness::Lost
        );
    }

    #[test]
    fn thresholds_are_inclusive_at_the_boundary() {
        let p = LivenessPolicy::for_socket(75);
        assert_eq!(
            p.resolve(SourceStatus::Connected, Duration::from_secs(85)),
            Liveness::Degraded
        );
        assert_eq!(
            p.resolve(SourceStatus::Connected, Duration::from_secs(105)),
            Liveness::Lost
        );
    }
}
