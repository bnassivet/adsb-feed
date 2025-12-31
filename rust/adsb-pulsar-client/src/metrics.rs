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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
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
        self.inner.bytes_received.fetch_add(bytes, Ordering::Relaxed);
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
            errors: self.errors(),
            bytes_received: self.bytes_received(),
            bytes_sent: self.bytes_sent(),
            retry_queue_size: self.retry_queue_size(),
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
#[derive(Debug, Clone)]
pub struct MetricsSnapshot {
    pub messages_sent: u64,
    pub errors: u64,
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub retry_queue_size: u64,
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
            "Messages: {}, Errors: {}, Queue: {}, Throughput: {:.1} msg/s, Sent: {:.2} MB, Received: {:.2} MB",
            self.messages_sent,
            self.errors,
            self.retry_queue_size,
            self.throughput_msg_per_sec,
            self.bytes_sent as f64 / 1024.0 / 1024.0,
            self.bytes_received as f64 / 1024.0 / 1024.0
        )
    }
}
