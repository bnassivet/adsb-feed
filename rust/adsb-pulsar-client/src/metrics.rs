//! Metrics tracking for the ADS-B Pulsar client.
//!
//! Provides thread-safe, lock-free metrics tracking using atomic operations.
//! All metrics can be accessed concurrently without blocking.
//!
//! # Examples
//!
//! ```rust
//! use adsb_pulsar_client::metrics::Metrics;
//!
//! let metrics = Metrics::new();
//!
//! // Update metrics (thread-safe)
//! metrics.inc_messages_sent();
//! metrics.add_bytes_sent(1024);
//!
//! // Get snapshot
//! let snapshot = metrics.snapshot();
//! println!("{}", snapshot);
//! ```

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// Thread-safe metrics tracker.
///
/// Uses atomic operations for lock-free concurrent access.
/// Can be cloned and shared across threads.
///
/// # Examples
///
/// ```rust
/// # use adsb_pulsar_client::metrics::Metrics;
/// let metrics = Metrics::new();
/// metrics.inc_messages_sent();
/// assert_eq!(metrics.messages_sent(), 1);
/// ```
#[derive(Debug, Clone)]
pub struct Metrics {
    inner: Arc<MetricsInner>,
}

/// Internal metrics storage.
///
/// Uses atomic integers for thread-safe updates without locks.
#[derive(Debug)]
struct MetricsInner {
    /// Number of messages successfully sent to Pulsar
    messages_sent: AtomicU64,
    /// Number of errors encountered
    errors: AtomicU64,
    /// Total bytes received from socket
    bytes_received: AtomicU64,
    /// Total bytes sent to Pulsar
    bytes_sent: AtomicU64,
    /// Number of messages currently in retry queue
    retry_queue_size: AtomicU64,
    /// Number of reconnection attempts
    reconnection_attempts: AtomicU64,
    /// Number of messages received from socket (all lines including heartbeats)
    messages_received: AtomicU64,
    /// Start time for throughput calculation
    start_time: Instant,
}

impl Metrics {
    /// Creates a new metrics tracker with all counters at zero.
    ///
    /// # Returns
    ///
    /// A new `Metrics` instance with start time set to now
    ///
    /// # Examples
    ///
    /// ```rust
    /// # use adsb_pulsar_client::metrics::Metrics;
    /// let metrics = Metrics::new();
    /// assert_eq!(metrics.messages_sent(), 0);
    /// ```
    pub fn new() -> Self {
        Self {
            inner: Arc::new(MetricsInner {
                messages_sent: AtomicU64::new(0),
                errors: AtomicU64::new(0),
                bytes_received: AtomicU64::new(0),
                bytes_sent: AtomicU64::new(0),
                retry_queue_size: AtomicU64::new(0),
                reconnection_attempts: AtomicU64::new(0),
                messages_received: AtomicU64::new(0),
                start_time: Instant::now(),
            }),
        }
    }

    /// Increments the messages sent counter by 1 (atomic).
    ///
    /// Thread-safe operation using relaxed memory ordering for performance.
    pub fn inc_messages_sent(&self) {
        self.inner.messages_sent.fetch_add(1, Ordering::Relaxed);
    }

    /// Increments the error counter by 1 (atomic).
    ///
    /// Thread-safe operation using relaxed memory ordering.
    pub fn inc_errors(&self) {
        self.inner.errors.fetch_add(1, Ordering::Relaxed);
    }

    /// Adds to the bytes received counter (atomic).
    ///
    /// # Arguments
    ///
    /// * `bytes` - Number of bytes to add
    pub fn add_bytes_received(&self, bytes: u64) {
        self.inner
            .bytes_received
            .fetch_add(bytes, Ordering::Relaxed);
    }

    /// Adds to the bytes sent counter (atomic).
    ///
    /// # Arguments
    ///
    /// * `bytes` - Number of bytes to add
    pub fn add_bytes_sent(&self, bytes: u64) {
        self.inner.bytes_sent.fetch_add(bytes, Ordering::Relaxed);
    }

    /// Sets the retry queue size (atomic).
    ///
    /// # Arguments
    ///
    /// * `size` - Current size of the retry queue
    pub fn set_retry_queue_size(&self, size: u64) {
        self.inner.retry_queue_size.store(size, Ordering::Relaxed);
    }

    /// Increments the reconnection attempts counter by 1 (atomic).
    pub fn inc_reconnection_attempts(&self) {
        self.inner
            .reconnection_attempts
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Increments the messages received counter by 1 (atomic).
    ///
    /// Counts all lines extracted from the TCP stream, including heartbeats.
    pub fn inc_messages_received(&self) {
        self.inner.messages_received.fetch_add(1, Ordering::Relaxed);
    }

    /// Get current messages sent count
    pub fn messages_sent(&self) -> u64 {
        self.inner.messages_sent.load(Ordering::Relaxed)
    }

    /// Get current error count
    pub fn errors(&self) -> u64 {
        self.inner.errors.load(Ordering::Relaxed)
    }

    /// Get total bytes received
    pub fn bytes_received(&self) -> u64 {
        self.inner.bytes_received.load(Ordering::Relaxed)
    }

    /// Get total bytes sent
    pub fn bytes_sent(&self) -> u64 {
        self.inner.bytes_sent.load(Ordering::Relaxed)
    }

    /// Get retry queue size
    pub fn retry_queue_size(&self) -> u64 {
        self.inner.retry_queue_size.load(Ordering::Relaxed)
    }

    /// Get reconnection attempts count
    pub fn reconnection_attempts(&self) -> u64 {
        self.inner.reconnection_attempts.load(Ordering::Relaxed)
    }

    /// Get messages received count (all TCP lines including heartbeats)
    pub fn messages_received(&self) -> u64 {
        self.inner.messages_received.load(Ordering::Relaxed)
    }

    /// Get elapsed time since start
    pub fn elapsed(&self) -> std::time::Duration {
        self.inner.start_time.elapsed()
    }

    /// Calculates messages per second throughput.
    ///
    /// # Returns
    ///
    /// Average throughput since start, or 0.0 if no time elapsed
    pub fn messages_per_second(&self) -> f64 {
        let elapsed = self.elapsed().as_secs_f64();
        if elapsed > 0.0 {
            self.messages_sent() as f64 / elapsed
        } else {
            0.0
        }
    }

    /// Gets a consistent snapshot of all metrics.
    ///
    /// # Returns
    ///
    /// A [`MetricsSnapshot`] with all current values
    ///
    /// # Examples
    ///
    /// ```rust
    /// # use adsb_pulsar_client::metrics::Metrics;
    /// let metrics = Metrics::new();
    /// metrics.inc_messages_sent();
    /// let snapshot = metrics.snapshot();
    /// println!("{}", snapshot);
    /// ```
    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            messages_sent: self.messages_sent(),
            messages_received: self.messages_received(),
            errors: self.errors(),
            bytes_received: self.bytes_received(),
            bytes_sent: self.bytes_sent(),
            retry_queue_size: self.retry_queue_size(),
            reconnection_attempts: self.reconnection_attempts(),
            elapsed_secs: self.elapsed().as_secs_f64(),
            throughput_msg_per_sec: self.messages_per_second(),
        }
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

/// Snapshot of metrics at a point in time.
///
/// Immutable snapshot of all metrics for consistent reporting.
/// Implements [`Display`](std::fmt::Display) for human-readable output.
///
/// # Examples
///
/// ```rust
/// # use adsb_pulsar_client::metrics::{Metrics, MetricsSnapshot};
/// let metrics = Metrics::new();
/// let snapshot = metrics.snapshot();
/// println!("Stats: {}", snapshot);
/// ```
#[derive(Debug, Clone, serde::Serialize)]
pub struct MetricsSnapshot {
    pub messages_sent: u64,
    pub messages_received: u64,
    pub errors: u64,
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub retry_queue_size: u64,
    pub reconnection_attempts: u64,
    pub elapsed_secs: f64,
    pub throughput_msg_per_sec: f64,
}

/// Display implementation for human-readable metrics output.
///
/// Formats metrics as a single-line summary suitable for logging.
impl std::fmt::Display for MetricsSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Recv: {}, Sent: {}, Errors: {}, Queue: {}, Reconnects: {}, Throughput: {:.1} msg/s, TX: {:.2} MB, RX: {:.2} MB",
            self.messages_received,
            self.messages_sent,
            self.errors,
            self.retry_queue_size,
            self.reconnection_attempts,
            self.throughput_msg_per_sec,
            self.bytes_sent as f64 / 1024.0 / 1024.0,
            self.bytes_received as f64 / 1024.0 / 1024.0
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_metrics_all_zero() {
        let m = Metrics::new();
        assert_eq!(m.messages_sent(), 0);
        assert_eq!(m.messages_received(), 0);
        assert_eq!(m.errors(), 0);
        assert_eq!(m.bytes_received(), 0);
        assert_eq!(m.bytes_sent(), 0);
        assert_eq!(m.retry_queue_size(), 0);
        assert_eq!(m.reconnection_attempts(), 0);
    }

    #[test]
    fn test_inc_messages_sent() {
        let m = Metrics::new();
        m.inc_messages_sent();
        m.inc_messages_sent();
        m.inc_messages_sent();
        assert_eq!(m.messages_sent(), 3);
    }

    #[test]
    fn test_inc_errors() {
        let m = Metrics::new();
        m.inc_errors();
        m.inc_errors();
        assert_eq!(m.errors(), 2);
    }

    #[test]
    fn test_add_bytes_received_cumulative() {
        let m = Metrics::new();
        m.add_bytes_received(100);
        m.add_bytes_received(200);
        assert_eq!(m.bytes_received(), 300);
    }

    #[test]
    fn test_add_bytes_sent_cumulative() {
        let m = Metrics::new();
        m.add_bytes_sent(50);
        m.add_bytes_sent(75);
        assert_eq!(m.bytes_sent(), 125);
    }

    #[test]
    fn test_set_retry_queue_size() {
        let m = Metrics::new();
        m.set_retry_queue_size(42);
        assert_eq!(m.retry_queue_size(), 42);
        m.set_retry_queue_size(0);
        assert_eq!(m.retry_queue_size(), 0);
    }

    #[test]
    fn test_snapshot_captures_values() {
        let m = Metrics::new();
        m.inc_messages_sent();
        m.inc_messages_sent();
        m.inc_errors();
        m.add_bytes_received(1024);
        m.add_bytes_sent(512);
        m.set_retry_queue_size(5);

        let snap = m.snapshot();
        assert_eq!(snap.messages_sent, 2);
        assert_eq!(snap.errors, 1);
        assert_eq!(snap.bytes_received, 1024);
        assert_eq!(snap.bytes_sent, 512);
        assert_eq!(snap.retry_queue_size, 5);
    }

    #[test]
    fn test_inc_reconnection_attempts() {
        let m = Metrics::new();
        m.inc_reconnection_attempts();
        m.inc_reconnection_attempts();
        assert_eq!(m.reconnection_attempts(), 2);
    }

    #[test]
    fn test_inc_messages_received() {
        let m = Metrics::new();
        m.inc_messages_received();
        m.inc_messages_received();
        m.inc_messages_received();
        assert_eq!(m.messages_received(), 3);
    }

    #[test]
    fn test_snapshot_includes_new_fields() {
        let m = Metrics::new();
        m.inc_reconnection_attempts();
        m.inc_messages_received();
        m.inc_messages_received();
        let snap = m.snapshot();
        assert_eq!(snap.reconnection_attempts, 1);
        assert_eq!(snap.messages_received, 2);
    }

    #[test]
    fn test_snapshot_display_format() {
        let m = Metrics::new();
        m.inc_messages_sent();
        m.inc_errors();
        m.inc_reconnection_attempts();
        let display = m.snapshot().to_string();
        assert!(display.contains("Sent:"), "should contain Sent:");
        assert!(display.contains("Errors:"), "should contain Errors:");
        assert!(
            display.contains("Reconnects:"),
            "should contain Reconnects:"
        );
    }

    #[test]
    fn test_metrics_clone_shares_state() {
        let m = Metrics::new();
        let m2 = m.clone();
        m.inc_messages_sent();
        assert_eq!(m2.messages_sent(), 1);
    }

    #[test]
    fn test_messages_per_second_nonnegative() {
        let m = Metrics::new();
        assert!(m.messages_per_second() >= 0.0);
        m.inc_messages_sent();
        assert!(m.messages_per_second() >= 0.0);
    }

    #[test]
    fn test_snapshot_serialize_json() {
        let m = Metrics::new();
        m.inc_messages_sent();
        m.add_bytes_received(100);
        let snap = m.snapshot();
        let value = serde_json::to_value(&snap).unwrap();

        assert!(value.get("messages_sent").is_some());
        assert!(value.get("messages_received").is_some());
        assert!(value.get("errors").is_some());
        assert!(value.get("bytes_received").is_some());
        assert!(value.get("bytes_sent").is_some());
        assert!(value.get("retry_queue_size").is_some());
        assert!(value.get("reconnection_attempts").is_some());
        assert!(value.get("elapsed_secs").is_some());
        assert!(value.get("throughput_msg_per_sec").is_some());
    }

    #[test]
    fn test_elapsed_is_nonnegative() {
        let m = Metrics::new();
        assert!(m.elapsed().as_secs() >= 0);
    }
}
