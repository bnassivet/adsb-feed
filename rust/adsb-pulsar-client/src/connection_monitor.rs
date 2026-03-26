//! Connection health monitor with heartbeat-aware idle detection.
//!
//! Tracks three activity levels to distinguish between:
//! - TCP-level activity (any bytes received)
//! - Heartbeat messages (dump1090 keepalive with hex_ident 000000)
//! - Data messages (actual aircraft position reports)
//!
//! When no heartbeat or data message arrives within the configured timeout,
//! the connection is declared stale. This catches half-open TCP connections
//! faster than the raw socket read timeout alone.

use crate::config::Config;
use std::time::{Duration, Instant};

/// Classification of a line received from the TCP stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    /// A heartbeat line (matches the configured heartbeat pattern).
    Heartbeat,
    /// A data line (does not match the heartbeat pattern).
    Data,
}

/// Reason why the connection is considered stale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaleReason {
    /// No heartbeat or data message received within the timeout.
    HeartbeatTimeout {
        /// Time elapsed since the last heartbeat or data message.
        elapsed: Duration,
    },
}

impl std::fmt::Display for StaleReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StaleReason::HeartbeatTimeout { elapsed } => {
                write!(f, "no heartbeat/data for {:.0}s", elapsed.as_secs_f64())
            }
        }
    }
}

/// Monitors connection health using heartbeat-aware idle detection.
///
/// Performs lightweight byte-level pattern matching to identify heartbeat
/// lines without full SBS parsing. The default pattern `,000000,` matches
/// the hex_ident field in dump1090 heartbeat messages sent every ~60 seconds.
pub struct ConnectionMonitor {
    /// Updated on every successful TCP read with >0 bytes.
    last_tcp_activity: Instant,
    /// Updated when a line matching the heartbeat pattern is seen.
    last_heartbeat: Instant,
    /// Updated when a line does NOT match the heartbeat pattern.
    last_data_message: Instant,
    /// Byte pattern to match heartbeat lines. None if disabled.
    heartbeat_pattern: Option<Vec<u8>>,
    /// Timeout after which the connection is considered stale. None if disabled.
    heartbeat_timeout: Option<Duration>,
}

impl ConnectionMonitor {
    /// Creates a new monitor from the given config.
    ///
    /// All timestamps are initialized to `Instant::now()` so the timeout
    /// starts from creation, not from some epoch.
    pub fn new(config: &Config) -> Self {
        let now = Instant::now();
        let heartbeat_pattern = if config.heartbeat_pattern.is_empty() {
            None
        } else {
            Some(config.heartbeat_pattern.as_bytes().to_vec())
        };
        Self {
            last_tcp_activity: now,
            last_heartbeat: now,
            last_data_message: now,
            heartbeat_pattern,
            heartbeat_timeout: config.heartbeat_timeout(),
        }
    }

    /// Records that bytes were received on the TCP stream.
    pub fn record_tcp_activity(&mut self) {
        self.last_tcp_activity = Instant::now();
    }

    /// Classifies a line and updates the corresponding timestamp.
    ///
    /// If the heartbeat pattern is configured and found in the line,
    /// returns [`LineKind::Heartbeat`]. Otherwise returns [`LineKind::Data`].
    pub fn classify_line(&mut self, line: &[u8]) -> LineKind {
        if self.is_heartbeat(line) {
            self.last_heartbeat = Instant::now();
            LineKind::Heartbeat
        } else {
            self.last_data_message = Instant::now();
            LineKind::Data
        }
    }

    /// Checks if the connection is stale.
    ///
    /// Returns `Some(StaleReason)` if no heartbeat AND no data message
    /// has been received within the configured heartbeat timeout.
    /// Returns `None` if the connection is healthy or the feature is disabled.
    pub fn is_stale(&self) -> Option<StaleReason> {
        let timeout = self.heartbeat_timeout?;
        let last_meaningful = std::cmp::max(self.last_heartbeat, self.last_data_message);
        let elapsed = last_meaningful.elapsed();
        if elapsed >= timeout {
            Some(StaleReason::HeartbeatTimeout { elapsed })
        } else {
            None
        }
    }

    /// Resets all timestamps to now. Call on reconnection.
    pub fn reset(&mut self) {
        let now = Instant::now();
        self.last_tcp_activity = now;
        self.last_heartbeat = now;
        self.last_data_message = now;
    }

    /// Returns the duration since the last heartbeat or data message.
    pub fn since_last_meaningful_message(&self) -> Duration {
        std::cmp::max(self.last_heartbeat, self.last_data_message).elapsed()
    }

    /// Returns the duration since the last TCP activity.
    pub fn since_last_tcp_activity(&self) -> Duration {
        self.last_tcp_activity.elapsed()
    }

    fn is_heartbeat(&self, line: &[u8]) -> bool {
        match &self.heartbeat_pattern {
            Some(pattern) => line
                .windows(pattern.len())
                .any(|window| window == pattern.as_slice()),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            heartbeat_timeout_secs: 90,
            heartbeat_pattern: ",000000,".to_string(),
            ..Config::default()
        }
    }

    fn test_config_disabled() -> Config {
        Config {
            heartbeat_timeout_secs: 0,
            heartbeat_pattern: ",000000,".to_string(),
            ..Config::default()
        }
    }

    fn test_config_empty_pattern() -> Config {
        Config {
            heartbeat_timeout_secs: 90,
            heartbeat_pattern: String::new(),
            ..Config::default()
        }
    }

    #[test]
    fn test_new_monitor_not_stale() {
        let config = test_config();
        let monitor = ConnectionMonitor::new(&config);
        assert!(monitor.is_stale().is_none());
    }

    #[test]
    fn test_heartbeat_pattern_match() {
        let config = test_config();
        let mut monitor = ConnectionMonitor::new(&config);
        let line = b"MSG,3,1,1,000000,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,0,,,0.0,0.0,,,,,,0";
        assert_eq!(monitor.classify_line(line), LineKind::Heartbeat);
    }

    #[test]
    fn test_data_line_classified() {
        let config = test_config();
        let mut monitor = ConnectionMonitor::new(&config);
        let line = b"MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,48.8566,2.3522,,,,,,0";
        assert_eq!(monitor.classify_line(line), LineKind::Data);
    }

    #[test]
    fn test_stale_after_timeout() {
        let config = Config {
            heartbeat_timeout_secs: 1, // 1 second for testing
            heartbeat_pattern: ",000000,".to_string(),
            ..Config::default()
        };
        let mut monitor = ConnectionMonitor::new(&config);
        // Backdate timestamps to simulate timeout
        let past = Instant::now() - Duration::from_secs(2);
        monitor.last_heartbeat = past;
        monitor.last_data_message = past;

        let stale = monitor.is_stale();
        assert!(stale.is_some());
        match stale.unwrap() {
            StaleReason::HeartbeatTimeout { elapsed } => {
                assert!(elapsed >= Duration::from_secs(1));
            }
        }
    }

    #[test]
    fn test_heartbeat_resets_stale() {
        let config = Config {
            heartbeat_timeout_secs: 1,
            heartbeat_pattern: ",000000,".to_string(),
            ..Config::default()
        };
        let mut monitor = ConnectionMonitor::new(&config);
        // Backdate timestamps
        let past = Instant::now() - Duration::from_secs(2);
        monitor.last_heartbeat = past;
        monitor.last_data_message = past;
        assert!(monitor.is_stale().is_some());

        // Receiving a heartbeat should clear staleness
        let heartbeat = b"MSG,3,1,1,000000,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,0,,,0.0,0.0,,,,,,0";
        monitor.classify_line(heartbeat);
        assert!(monitor.is_stale().is_none());
    }

    #[test]
    fn test_data_message_resets_stale() {
        let config = Config {
            heartbeat_timeout_secs: 1,
            heartbeat_pattern: ",000000,".to_string(),
            ..Config::default()
        };
        let mut monitor = ConnectionMonitor::new(&config);
        let past = Instant::now() - Duration::from_secs(2);
        monitor.last_heartbeat = past;
        monitor.last_data_message = past;
        assert!(monitor.is_stale().is_some());

        // Receiving a data message should also clear staleness
        let data = b"MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,48.8566,2.3522,,,,,,0";
        monitor.classify_line(data);
        assert!(monitor.is_stale().is_none());
    }

    #[test]
    fn test_disabled_heartbeat_timeout_never_stale() {
        let config = test_config_disabled();
        let mut monitor = ConnectionMonitor::new(&config);
        // Backdate everything
        let past = Instant::now() - Duration::from_secs(3600);
        monitor.last_heartbeat = past;
        monitor.last_data_message = past;
        monitor.last_tcp_activity = past;
        assert!(monitor.is_stale().is_none());
    }

    #[test]
    fn test_empty_pattern_all_lines_are_data() {
        let config = test_config_empty_pattern();
        let mut monitor = ConnectionMonitor::new(&config);
        // Even a heartbeat line is classified as Data when pattern is empty
        let line = b"MSG,3,1,1,000000,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,0,,,0.0,0.0,,,,,,0";
        assert_eq!(monitor.classify_line(line), LineKind::Data);
    }

    #[test]
    fn test_reset_clears_staleness() {
        let config = Config {
            heartbeat_timeout_secs: 1,
            heartbeat_pattern: ",000000,".to_string(),
            ..Config::default()
        };
        let mut monitor = ConnectionMonitor::new(&config);
        let past = Instant::now() - Duration::from_secs(2);
        monitor.last_heartbeat = past;
        monitor.last_data_message = past;
        assert!(monitor.is_stale().is_some());

        monitor.reset();
        assert!(monitor.is_stale().is_none());
    }

    #[test]
    fn test_record_tcp_activity() {
        let config = test_config();
        let mut monitor = ConnectionMonitor::new(&config);
        let past = Instant::now() - Duration::from_secs(10);
        monitor.last_tcp_activity = past;
        assert!(monitor.since_last_tcp_activity() >= Duration::from_secs(9));

        monitor.record_tcp_activity();
        assert!(monitor.since_last_tcp_activity() < Duration::from_secs(1));
    }

    #[test]
    fn test_stale_reason_display() {
        let reason = StaleReason::HeartbeatTimeout {
            elapsed: Duration::from_secs(95),
        };
        let display = reason.to_string();
        assert!(display.contains("95"));
        assert!(display.contains("heartbeat"));
    }
}
