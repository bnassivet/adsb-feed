//! Core ADS-B feed client implementation.
//!
//! This module contains the main [`ADSBFeedClient`] struct which handles:
//! - TCP socket connections to dump1090
//! - Fan-out message forwarding to pluggable backends
//! - Per-forwarder retry queues for reliability
//! - Line buffering to prevent message fragmentation
//! - Metrics tracking and periodic statistics logging

use crate::config::{Config, ConnectionMode};
use crate::connection_monitor::ConnectionMonitor;
use crate::error::{ClientError, Result};
use crate::forwarder::MessageForwarder;
use crate::metrics::Metrics;
use bytes::{Buf, BytesMut};
use std::collections::VecDeque;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, watch};
use tokio::time::{interval, sleep};
use tracing::{debug, error, info, warn};

/// Maximum timestamp update interval (messages).
const TIMESTAMP_UPDATE_INTERVAL: u64 = 10;

/// Maximum number of queued messages to try draining per housekeeping tick.
const MAX_RETRY_DRAIN_PER_TICK: usize = 500;

/// Main ADS-B Feed Client.
///
/// Manages the complete lifecycle of receiving ADS-B messages from dump1090
/// and forwarding them to one or more pluggable backends via [`MessageForwarder`].
pub struct ADSBFeedClient {
    /// Client configuration
    config: Config,
    /// Thread-safe metrics tracker
    metrics: Metrics,
    /// Pluggable message forwarders (e.g., Pulsar, file, noop)
    forwarders: Vec<Box<dyn MessageForwarder>>,
    /// Per-forwarder retry queues (indexed same as `forwarders`)
    retry_queues: Vec<VecDeque<Vec<u8>>>,
    /// Buffer for accumulating incomplete lines from socket reads
    line_buffer: BytesMut,
    /// Cached timestamp in milliseconds (updated periodically for performance)
    last_timestamp_ms: i64,
    /// Counter for determining when to update cached timestamp
    timestamp_update_counter: u64,

    /// Optional broadcast channel for tapping into raw messages
    message_tx: Option<broadcast::Sender<Vec<u8>>>,

    /// Programmatic shutdown signal
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,

    /// Connection health monitor with heartbeat-aware idle detection
    connection_monitor: ConnectionMonitor,
}

impl ADSBFeedClient {
    /// Creates a new ADS-B feed client with the given configuration and forwarders.
    ///
    /// The `forwarders` vector determines which backends receive messages.
    /// Each forwarder gets its own retry queue for independent failure handling.
    pub fn new(config: Config, forwarders: Vec<Box<dyn MessageForwarder>>) -> Result<Self> {
        config.validate()?;

        let retry_queues = (0..forwarders.len())
            .map(|_| VecDeque::with_capacity(1000))
            .collect();

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let connection_monitor = ConnectionMonitor::new(&config);

        Ok(Self {
            config,
            metrics: Metrics::new(),
            forwarders,
            retry_queues,
            line_buffer: BytesMut::with_capacity(8192),
            last_timestamp_ms: chrono::Utc::now().timestamp_millis(),
            timestamp_update_counter: 0,
            message_tx: None,
            shutdown_tx,
            shutdown_rx,
            connection_monitor,
        })
    }

    /// Attaches a message tap that receives copies of all processed messages.
    ///
    /// Returns a `broadcast::Receiver` that receives each raw message as `Vec<u8>`.
    /// Multiple taps can be created by calling this multiple times (they share
    /// the same broadcast channel). If no tap is needed, don't call this.
    ///
    /// # Arguments
    ///
    /// * `capacity` - Buffer capacity for the broadcast channel
    pub fn with_message_tap(&mut self, capacity: usize) -> broadcast::Receiver<Vec<u8>> {
        if let Some(ref tx) = self.message_tx {
            tx.subscribe()
        } else {
            let (tx, rx) = broadcast::channel(capacity);
            self.message_tx = Some(tx);
            rx
        }
    }

    /// Triggers a graceful shutdown of the client.
    ///
    /// The client will finish processing the current message and exit
    /// its main loop. Safe to call from any thread.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    /// Returns a clone of the metrics handle.
    ///
    /// The returned `Metrics` is backed by the same atomic counters,
    /// so reads always reflect the latest values.
    pub fn metrics(&self) -> Metrics {
        self.metrics.clone()
    }

    /// Returns a reference to the current configuration.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Runs the client main loop.
    ///
    /// This is the primary entry point that:
    /// 1. Connects all forwarders (unless in test mode)
    /// 2. Starts the appropriate connection mode (client or server)
    /// 3. Begins receiving and forwarding messages
    ///
    /// Runs until an unrecoverable error occurs, shutdown is requested,
    /// or the process receives a termination signal.
    pub async fn run(&mut self) -> Result<()> {
        let names: Vec<&str> = self.forwarders.iter().map(|f| f.name()).collect();
        info!("Starting ADS-B Feed Client (forwarders: {:?})", names);
        info!(
            "Configuration: source_id={}, socket={}:{}, test_mode={}",
            self.config.source_id,
            self.config.socket_host,
            self.config.socket_port,
            self.config.test_mode
        );

        if self.config.test_mode {
            info!("Running in TEST MODE - forwarder connections disabled");
        } else {
            for forwarder in &mut self.forwarders {
                forwarder.connect().await?;
            }
        }

        match self.config.get_connection_mode() {
            ConnectionMode::Client => self.run_client_mode().await,
            ConnectionMode::Server => self.run_server_mode().await,
        }
    }

    /// Runs in client mode (actively connects to dump1090).
    ///
    /// Uses exponential backoff between reconnection attempts (initial delay
    /// doubling up to max delay). Backoff resets on successful connection.
    async fn run_client_mode(&mut self) -> Result<()> {
        let mut retry_delay = self.config.initial_retry_delay();
        let max_delay = self.config.max_retry_delay();

        loop {
            // Check for shutdown before attempting connection
            if *self.shutdown_rx.borrow() {
                info!("Shutdown requested, exiting client mode");
                return Ok(());
            }

            self.metrics.inc_reconnection_attempts();
            self.connection_monitor.reset();

            match Self::connect_socket(&self.config).await {
                Ok(mut stream) => {
                    info!(
                        "Connected to dump1090 at {}:{}",
                        self.config.socket_host, self.config.socket_port
                    );
                    // Reset backoff on successful connection
                    retry_delay = self.config.initial_retry_delay();

                    match self.receive_and_forward(&mut stream).await {
                        Err(ClientError::Shutdown) => {
                            info!("Shutdown requested, exiting client mode");
                            return Ok(());
                        }
                        Err(e) => {
                            error!("Error in receive loop: {}", e);
                            self.line_buffer.clear();

                            if !e.is_recoverable() {
                                return Err(e);
                            }
                        }
                        Ok(()) => {}
                    }
                }
                Err(e) => {
                    error!("Failed to connect to dump1090: {}", e);
                    if !e.is_recoverable() {
                        return Err(e);
                    }
                }
            }

            // Exponential backoff between reconnections
            info!("Reconnecting in {:?}...", retry_delay);
            tokio::select! {
                _ = sleep(retry_delay) => {}
                _ = self.shutdown_rx.changed() => {
                    info!("Shutdown requested during retry delay");
                    return Ok(());
                }
            }
            retry_delay = std::cmp::min(retry_delay * 2, max_delay);
        }
    }

    /// Runs in server mode (listens for incoming dump1090 connections).
    async fn run_server_mode(&mut self) -> Result<()> {
        let addr = format!("{}:{}", self.config.socket_host, self.config.socket_port);
        let listener = TcpListener::bind(&addr).await?;
        info!("Listening for connections on {}", addr);

        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((mut stream, peer_addr)) => {
                            info!("Client connected from {}", peer_addr);

                            match self.receive_and_forward(&mut stream).await {
                                Err(ClientError::Shutdown) => {
                                    info!("Shutdown requested, exiting server mode");
                                    return Ok(());
                                }
                                Err(e) => {
                                    warn!("Connection from {} closed: {}", peer_addr, e);
                                }
                                Ok(()) => {}
                            }

                            self.line_buffer.clear();
                        }
                        Err(e) => {
                            error!("Error accepting connection: {}", e);
                            sleep(Duration::from_secs(1)).await;
                        }
                    }
                }
                _ = self.shutdown_rx.changed() => {
                    info!("Shutdown requested, exiting server mode");
                    return Ok(());
                }
            }
        }
    }

    /// Connects to dump1090 socket with exponential backoff retry.
    async fn connect_socket(config: &Config) -> Result<TcpStream> {
        let mut retry_delay = config.initial_retry_delay();
        let max_delay = config.max_retry_delay();
        let mut attempt = 0u32;

        loop {
            attempt += 1;
            info!(
                "Attempting to connect to dump1090 at {}:{} (attempt {})",
                config.socket_host, config.socket_port, attempt
            );

            match tokio::time::timeout(
                config.socket_timeout(),
                TcpStream::connect((config.socket_host.as_str(), config.socket_port)),
            )
            .await
            {
                Ok(Ok(stream)) => {
                    info!(
                        "Successfully connected to {}:{}",
                        config.socket_host, config.socket_port
                    );
                    return Ok(stream);
                }
                Ok(Err(e)) => {
                    warn!("Failed to connect: {}. Retrying in {:?}...", e, retry_delay);
                }
                Err(_) => {
                    warn!("Connection timeout. Retrying in {:?}...", retry_delay);
                }
            }

            sleep(retry_delay).await;
            retry_delay = std::cmp::min(retry_delay * 2, max_delay);
        }
    }

    /// Receives data from socket and forwards to all registered forwarders.
    async fn receive_and_forward(&mut self, stream: &mut TcpStream) -> Result<()> {
        let mut buffer = vec![0u8; self.config.recv_buffer_size];
        let mut stats_interval = interval(Duration::from_secs(10));
        let mut housekeeping_interval = interval(Duration::from_secs(1));
        let socket_read_timeout = self.config.socket_read_timeout();

        loop {
            tokio::select! {
                // Check for shutdown signal
                _ = self.shutdown_rx.changed() => {
                    if *self.shutdown_rx.borrow() {
                        info!("Shutdown signal received in receive loop");
                        return Err(ClientError::Shutdown);
                    }
                }

                // Receive data from socket
                result = async {
                    match socket_read_timeout {
                        Some(timeout) => match tokio::time::timeout(timeout, stream.read(&mut buffer)).await {
                            Ok(Ok(n)) => Ok(n),
                            Ok(Err(e)) => Err(ClientError::Socket(e)),
                            Err(_) => Err(ClientError::Socket(std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "socket read timeout",
                            ))),
                        },
                        None => Ok(stream.read(&mut buffer).await?),
                    }
                } => {
                    match result {
                        Ok(0) => {
                            info!("Connection closed by remote host");
                            return Err(ClientError::Socket(std::io::Error::new(
                                std::io::ErrorKind::ConnectionAborted,
                                "connection closed"
                            )));
                        }
                        Ok(n) => {
                            self.metrics.add_bytes_received(n as u64);
                            self.connection_monitor.record_tcp_activity();

                            let messages = self.process_buffer(&buffer[..n])?;

                            for message in &messages {
                                self.metrics.inc_messages_received();
                                self.connection_monitor.classify_line(message);
                            }
                            for message in messages {
                                self.forward_message(message).await?;
                            }
                        }
                        Err(e) => {
                            if matches!(e, ClientError::Socket(ref io_err) if io_err.kind() == std::io::ErrorKind::TimedOut) {
                                warn!(
                                    "No bytes received for {:?}; forcing reconnect",
                                    self.config.socket_read_timeout().unwrap_or_else(|| Duration::from_secs(0))
                                );
                            } else {
                                error!("Socket read error: {}", e);
                            }

                            return Err(e);
                        }
                    }
                }

                // Periodic stats logging
                _ = stats_interval.tick() => {
                    let snapshot = self.metrics.snapshot();
                    info!(
                        "Statistics: {} (last heartbeat/data {:.0}s ago)",
                        snapshot,
                        self.connection_monitor.since_last_meaningful_message().as_secs_f64()
                    );
                }

                // Forwarder housekeeping: drain retry queues, flush, check staleness
                _ = housekeeping_interval.tick() => {
                    if !self.config.test_mode {
                        for i in 0..self.forwarders.len() {
                            if self.forwarders[i].is_connected() {
                                self.drain_retry_queue(i, MAX_RETRY_DRAIN_PER_TICK).await;
                                self.forwarders[i].flush().await.ok();
                            }
                        }
                    }

                    // Check for stale connection via heartbeat monitor
                    if let Some(reason) = self.connection_monitor.is_stale() {
                        warn!("Connection stale: {}, forcing reconnect", reason);
                        return Err(ClientError::Socket(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            format!("heartbeat timeout: {}", reason),
                        )));
                    }
                }
            }
        }
    }

    /// Processes incoming data with line buffering.
    pub(crate) fn process_buffer(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>> {
        self.line_buffer.extend_from_slice(data);

        if self.line_buffer.len() > self.config.max_line_buffer_size {
            warn!(
                "Line buffer overflow ({} bytes), clearing buffer",
                self.line_buffer.len()
            );
            self.line_buffer.clear();
            self.metrics.inc_errors();
            return Err(ClientError::BufferOverflow {
                current: self.line_buffer.len(),
                limit: self.config.max_line_buffer_size,
            });
        }

        let mut messages = Vec::new();

        while let Some(newline_pos) = self.line_buffer.iter().position(|&b| b == b'\n') {
            let line = self.line_buffer.split_to(newline_pos);
            self.line_buffer.advance(1);

            if !line.is_empty() && line.iter().any(|&b| !b.is_ascii_whitespace()) {
                messages.push(line.to_vec());
            }
        }

        Ok(messages)
    }

    /// Forwards a message to all registered forwarders (fan-out).
    ///
    /// Each forwarder is attempted independently — if one fails, others
    /// continue. Failed messages are enqueued in per-forwarder retry queues.
    async fn forward_message(&mut self, message: Vec<u8>) -> Result<()> {
        // Emit to message tap if attached
        if let Some(ref tx) = self.message_tx {
            let _ = tx.send(message.clone());
        }

        // Test mode: just log the message
        if self.config.test_mode {
            self.metrics.inc_messages_sent();

            match String::from_utf8(message.clone()) {
                Ok(s) => info!(
                    "[TEST MODE] Message {}: {}",
                    self.metrics.messages_sent(),
                    s.trim()
                ),
                Err(_) => warn!(
                    "[TEST MODE] Could not decode message {}",
                    self.metrics.messages_sent()
                ),
            }

            if self.metrics.messages_sent() % self.config.log_sample_rate == 0 {
                let snapshot = self.metrics.snapshot();
                info!("[TEST MODE] Statistics: {}", snapshot);
            }

            return Ok(());
        }

        // Update timestamp periodically
        if self.timestamp_update_counter % TIMESTAMP_UPDATE_INTERVAL == 0 {
            self.last_timestamp_ms = chrono::Utc::now().timestamp_millis();
        }
        self.timestamp_update_counter += 1;

        // Fan-out to all forwarders independently
        for i in 0..self.forwarders.len() {
            if !self.forwarders[i].is_connected() {
                self.enqueue_retry(i, message.clone());
                continue;
            }
            match self.forwarders[i].send(&message).await {
                Ok(()) => {}
                Err(e) => {
                    error!("Forwarder '{}' failed: {}", self.forwarders[i].name(), e);
                    self.metrics.inc_errors();
                    self.enqueue_retry(i, message.clone());
                    self.forwarders[i].disconnect().await.ok();
                }
            }
        }

        // Global metrics
        self.metrics.inc_messages_sent();
        self.metrics.add_bytes_sent(message.len() as u64);

        Ok(())
    }

    /// Enqueues a message in the retry queue for a specific forwarder.
    fn enqueue_retry(&mut self, forwarder_idx: usize, message: Vec<u8>) {
        let queue = &mut self.retry_queues[forwarder_idx];
        if queue.len() < self.config.max_retry_queue_size {
            queue.push_back(message);
        } else {
            warn!(
                "Retry queue for '{}' full ({} messages), dropping oldest",
                self.forwarders[forwarder_idx].name(),
                self.config.max_retry_queue_size
            );
            queue.pop_front();
            queue.push_back(message);
        }
        let total: usize = self.retry_queues.iter().map(|q| q.len()).sum();
        self.metrics.set_retry_queue_size(total as u64);
    }

    /// Drains the retry queue for a specific forwarder (limited batch).
    async fn drain_retry_queue(&mut self, forwarder_idx: usize, max_messages: usize) {
        if self.retry_queues[forwarder_idx].is_empty()
            || !self.forwarders[forwarder_idx].is_connected()
        {
            return;
        }

        let mut sent_count = 0;
        let mut failed_messages = Vec::new();

        while sent_count < max_messages {
            let Some(message) = self.retry_queues[forwarder_idx].pop_front() else {
                break;
            };
            match self.forwarders[forwarder_idx].send(&message).await {
                Ok(()) => {
                    sent_count += 1;
                    self.metrics.add_bytes_sent(message.len() as u64);
                }
                Err(e) => {
                    debug!(
                        "Failed to send queued message via '{}': {}",
                        self.forwarders[forwarder_idx].name(),
                        e
                    );
                    failed_messages.push(message);
                    break;
                }
            }
        }

        for msg in failed_messages.into_iter().rev() {
            self.retry_queues[forwarder_idx].push_front(msg);
        }

        let total: usize = self.retry_queues.iter().map(|q| q.len()).sum();
        self.metrics.set_retry_queue_size(total as u64);

        if sent_count > 0 {
            info!(
                "Successfully sent {} queued messages via '{}'",
                sent_count,
                self.forwarders[forwarder_idx].name()
            );
        }
    }

    /// Gets a final statistics snapshot as a formatted string.
    pub fn final_stats(&self) -> String {
        let snapshot = self.metrics.snapshot();
        format!("Final statistics: {}", snapshot)
    }
}

impl Drop for ADSBFeedClient {
    fn drop(&mut self) {
        info!("Cleaning up ADS-B Feed Client");
        info!("{}", self.final_stats());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forwarder::NoopForwarder;

    fn test_config() -> Config {
        let mut config = Config::default();
        config.test_mode = true;
        config
    }

    fn test_client() -> ADSBFeedClient {
        ADSBFeedClient::new(test_config(), vec![Box::new(NoopForwarder)]).unwrap()
    }

    // --- process_buffer tests ---

    #[test]
    fn test_process_buffer_single_line() {
        let mut client = test_client();
        let messages = client
            .process_buffer(b"MSG,3,1,1,A1B2C3,1,,,,,,35000,,,,,,,,,,,\n")
            .unwrap();
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn test_process_buffer_multiple_lines() {
        let mut client = test_client();
        let data = b"line1\nline2\nline3\n";
        let messages = client.process_buffer(data).unwrap();
        assert_eq!(messages.len(), 3);
    }

    #[test]
    fn test_process_buffer_incomplete_buffered() {
        let mut client = test_client();
        // No newline — should buffer but return nothing
        let messages = client.process_buffer(b"partial data").unwrap();
        assert!(messages.is_empty());

        // Complete the line
        let messages = client.process_buffer(b" continued\n").unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0], b"partial data continued");
    }

    #[test]
    fn test_process_buffer_empty_lines_skipped() {
        let mut client = test_client();
        let messages = client.process_buffer(b"\n\n\n").unwrap();
        assert!(messages.is_empty());
    }

    #[test]
    fn test_process_buffer_whitespace_only_skipped() {
        let mut client = test_client();
        let messages = client.process_buffer(b"   \n\t\n").unwrap();
        assert!(messages.is_empty());
    }

    #[test]
    fn test_process_buffer_crlf() {
        let mut client = test_client();
        let messages = client.process_buffer(b"line\r\n").unwrap();
        assert_eq!(messages.len(), 1);
        // The \r will be included in the line content (before the \n split)
        assert!(messages[0].ends_with(b"\r"));
    }

    #[test]
    fn test_process_buffer_overflow() {
        let mut config = test_config();
        config.max_line_buffer_size = 20;
        let mut client = ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).unwrap();

        let result =
            client.process_buffer(b"this is a very long line that exceeds the buffer limit");
        assert!(result.is_err());
        match result.unwrap_err() {
            ClientError::BufferOverflow { .. } => {}
            other => panic!("expected BufferOverflow, got {:?}", other),
        }
    }

    #[test]
    fn test_process_buffer_mixed() {
        let mut client = test_client();
        let messages = client.process_buffer(b"complete\nincomplete").unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0], b"complete");

        // Complete the incomplete line
        let messages = client.process_buffer(b" data\n").unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0], b"incomplete data");
    }

    // --- Client lifecycle tests ---

    #[test]
    fn test_client_new_valid_config() {
        assert!(ADSBFeedClient::new(Config::default(), vec![Box::new(NoopForwarder)]).is_ok());
    }

    #[test]
    fn test_client_new_invalid_config() {
        let mut config = Config::default();
        config.source_id = "".to_string();
        assert!(ADSBFeedClient::new(config, vec![Box::new(NoopForwarder)]).is_err());
    }

    #[test]
    fn test_shutdown_signal() {
        let client = test_client();
        assert!(!*client.shutdown_rx.borrow());
        client.shutdown();
        assert!(*client.shutdown_rx.borrow());
    }

    #[test]
    fn test_metrics_handle() {
        let client = test_client();
        let metrics = client.metrics();
        assert_eq!(metrics.messages_sent(), 0);
        metrics.inc_messages_sent();
        assert_eq!(client.metrics().messages_sent(), 1);
    }

    #[test]
    fn test_client_new_with_multiple_forwarders() {
        let forwarders: Vec<Box<dyn MessageForwarder>> =
            vec![Box::new(NoopForwarder), Box::new(NoopForwarder)];
        let client = ADSBFeedClient::new(test_config(), forwarders).unwrap();
        assert_eq!(client.forwarders.len(), 2);
        assert_eq!(client.retry_queues.len(), 2);
    }

    #[test]
    fn test_client_new_with_empty_forwarders() {
        let client = ADSBFeedClient::new(test_config(), vec![]).unwrap();
        assert_eq!(client.forwarders.len(), 0);
        assert_eq!(client.retry_queues.len(), 0);
    }
}
