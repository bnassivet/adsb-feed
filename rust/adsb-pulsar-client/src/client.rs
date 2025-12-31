//! Core ADS-B Pulsar client implementation.
//!
//! This module contains the main [`ADSBFeedClient`] struct which handles:
//! - TCP socket connections to dump1090
//! - Apache Pulsar producer for message forwarding
//! - Automatic reconnection with exponential backoff
//! - Message retry queue for reliability
//! - Line buffering to prevent message fragmentation
//! - Metrics tracking and periodic statistics logging
//!
//! # Architecture
//!
//! The client operates in two modes:
//! - **Client mode**: Connects to a remote dump1090 instance
//! - **Server mode**: Listens for incoming connections from dump1090
//!
//! Messages flow through these stages:
//! 1. TCP socket receives raw bytes
//! 2. Line buffer accumulates until complete newline-terminated messages
//! 3. Messages sent to Pulsar (or added to retry queue on failure)
//! 4. Metrics updated and periodic stats logged

use crate::config::{Config, ConnectionMode};
use crate::error::{ClientError, Result};
use crate::metrics::Metrics;
use bytes::{Buf, BytesMut};
use pulsar::{
    producer, Authentication, Producer, Pulsar, TokioExecutor,
};
use std::collections::VecDeque;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::{interval, sleep, Instant};
use tracing::{debug, error, info, warn};

/// Maximum timestamp update interval (messages).
///
/// Timestamp is cached and updated every N messages to reduce
/// system call overhead from getting current time.
const TIMESTAMP_UPDATE_INTERVAL: u64 = 10;

/// Maximum number of queued messages to try draining per housekeeping tick.
const MAX_RETRY_DRAIN_PER_TICK: usize = 500;

/// Main ADS-B Feed Client.
///
/// Manages the complete lifecycle of receiving ADS-B messages from dump1090
/// and forwarding them to Apache Pulsar. Handles connection management,
/// message buffering, error recovery, and metrics tracking.
///
/// # Examples
///
/// ```no_run
/// use adsb_pulsar_client::{ADSBFeedClient, Config};
///
/// #[tokio::main]
/// async fn main() -> Result<(), Box<dyn std::error::Error>> {
///     let config = Config::parse();
///     let mut client = ADSBFeedClient::new(config)?;
///     client.run().await?;
///     Ok(())
/// }
/// ```
pub struct ADSBFeedClient {
    /// Client configuration
    config: Config,
    /// Thread-safe metrics tracker
    metrics: Metrics,
    /// Pulsar client connection (None if in test mode or disconnected)
    pulsar_client: Option<Pulsar<TokioExecutor>>,
    /// Pulsar producer for sending messages (None if in test mode or disconnected)
    pulsar_producer: Option<Producer<TokioExecutor>>,
    /// Queue for messages that failed to send (bounded by max_retry_queue_size)
    retry_queue: VecDeque<Vec<u8>>,
    /// Buffer for accumulating incomplete lines from socket reads
    line_buffer: BytesMut,
    /// Cached timestamp in milliseconds (updated periodically for performance)
    last_timestamp_ms: i64,
    /// Counter for determining when to update cached timestamp
    timestamp_update_counter: u64,

    /// Channel used by a background task to deliver a (client, producer) once Pulsar reconnects.
    pulsar_reconnect_rx: mpsc::UnboundedReceiver<(Pulsar<TokioExecutor>, Producer<TokioExecutor>)>,
    pulsar_reconnect_tx: mpsc::UnboundedSender<(Pulsar<TokioExecutor>, Producer<TokioExecutor>)>,
    pulsar_reconnect_task_running: bool,
}

impl ADSBFeedClient {
    /// Creates a new ADS-B feed client with the given configuration.
    ///
    /// # Arguments
    ///
    /// * `config` - Client configuration including socket and Pulsar settings
    ///
    /// # Returns
    ///
    /// * `Ok(ADSBFeedClient)` - Successfully created client
    /// * `Err(ClientError::Config)` - Configuration validation failed
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use adsb_pulsar_client::{ADSBFeedClient, Config};
    ///
    /// let config = Config::parse();
    /// let client = ADSBFeedClient::new(config)?;
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// ```
    pub fn new(config: Config) -> Result<Self> {
        config.validate()?;

        let (pulsar_reconnect_tx, pulsar_reconnect_rx) = mpsc::unbounded_channel();

        Ok(Self {
            config,
            metrics: Metrics::new(),
            pulsar_client: None,
            pulsar_producer: None,
            retry_queue: VecDeque::with_capacity(1000),
            line_buffer: BytesMut::with_capacity(8192),
            last_timestamp_ms: chrono::Utc::now().timestamp_millis(),
            timestamp_update_counter: 0,
            pulsar_reconnect_rx,
            pulsar_reconnect_tx,
            pulsar_reconnect_task_running: false,
        })
    }

    /// Runs the client main loop.
    ///
    /// This is the primary entry point that:
    /// 1. Connects to Pulsar (unless in test mode)
    /// 2. Starts the appropriate connection mode (client or server)
    /// 3. Begins receiving and forwarding messages
    ///
    /// This function runs until an unrecoverable error occurs or shutdown is requested.
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Graceful shutdown
    /// * `Err(ClientError)` - Unrecoverable error occurred
    ///
    /// # Examples
    ///
    /// ```no_run
    /// # use adsb_pulsar_client::{ADSBFeedClient, Config};
    /// # #[tokio::main]
    /// # async fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// let mut client = ADSBFeedClient::new(Config::parse())?;
    /// client.run().await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn run(&mut self) -> Result<()> {
        info!("Starting ADS-B Pulsar Client");
        info!("Configuration: source_id={}, socket={}:{}, pulsar={}, topic={}, test_mode={}",
            self.config.source_id,
            self.config.socket_host,
            self.config.socket_port,
            self.config.pulsar_broker,
            self.config.pulsar_topic,
            self.config.test_mode
        );

        // Pulsar connection is best-effort and must not block dump1090 processing.
        // When not in test mode, we reconnect in the background and queue messages while down.
        if self.config.test_mode {
            info!("Running in TEST MODE - Pulsar connection disabled");
        } else {
            self.start_pulsar_reconnect_task();
        }

        // Start message forwarding based on connection mode
        match self.config.get_connection_mode() {
            ConnectionMode::Client => self.run_client_mode().await,
            ConnectionMode::Server => self.run_server_mode().await,
        }
    }

    /// Runs in client mode (actively connects to dump1090).
    ///
    /// In this mode, the client initiates TCP connections to dump1090.
    /// Automatically reconnects with exponential backoff on connection failure.
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Graceful shutdown requested
    /// * `Err(ClientError)` - Unrecoverable error
    async fn run_client_mode(&mut self) -> Result<()> {
        loop {
            match self.connect_socket().await {
                Ok(mut stream) => {
                    info!("Connected to dump1090 at {}:{}", self.config.socket_host, self.config.socket_port);

                    // Start receiving and forwarding messages
                    if let Err(e) = self.receive_and_forward(&mut stream).await {
                        error!("Error in receive loop: {}", e);

                        // Clear line buffer on reconnect
                        self.line_buffer.clear();

                        if !e.is_recoverable() {
                            return Err(e);
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to connect to dump1090: {}", e);
                    if !e.is_recoverable() {
                        return Err(e);
                    }
                }
            }

            // Wait before retry
            sleep(self.config.initial_retry_delay()).await;
        }
    }

    /// Runs in server mode (listens for incoming dump1090 connections).
    ///
    /// In this mode, the client binds to a TCP port and waits for dump1090
    /// to connect to it. Useful for scenarios where dump1090 pushes data.
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Graceful shutdown requested
    /// * `Err(ClientError)` - Unrecoverable error (e.g., cannot bind to port)
    async fn run_server_mode(&mut self) -> Result<()> {
        let addr = format!("{}:{}", self.config.socket_host, self.config.socket_port);
        let listener = TcpListener::bind(&addr).await?;
        info!("Listening for connections on {}", addr);

        loop {
            match listener.accept().await {
                Ok((mut stream, peer_addr)) => {
                    info!("Client connected from {}", peer_addr);

                    // Handle this connection
                    if let Err(e) = self.receive_and_forward(&mut stream).await {
                        warn!("Connection from {} closed: {}", peer_addr, e);
                    }

                    // Clear line buffer for next connection
                    self.line_buffer.clear();
                }
                Err(e) => {
                    error!("Error accepting connection: {}", e);
                    sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    /// Connects to dump1090 socket with exponential backoff retry.
    ///
    /// Attempts to establish TCP connection with configurable retry logic.
    /// Initial delay starts at `initial_retry_delay` and doubles on each
    /// failure up to `max_retry_delay`.
    ///
    /// # Returns
    ///
    /// * `Ok(TcpStream)` - Successfully connected socket
    /// * Never returns `Err` - loops indefinitely with retries
    async fn connect_socket(&self) -> Result<TcpStream> {
        let mut retry_delay = self.config.initial_retry_delay();
        let max_delay = self.config.max_retry_delay();
        let mut attempt = 0u32;

        loop {
            attempt += 1;
            info!("Attempting to connect to dump1090 at {}:{} (attempt {})",
                self.config.socket_host, self.config.socket_port, attempt);

            match tokio::time::timeout(
                self.config.socket_timeout(),
                TcpStream::connect((self.config.socket_host.as_str(), self.config.socket_port))
            ).await {
                Ok(Ok(stream)) => {
                    info!("Successfully connected to {}:{}", self.config.socket_host, self.config.socket_port);
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

    /// Connects to Pulsar broker and creates producer with retry logic.
    ///
    /// Establishes connection to Apache Pulsar and creates a producer
    /// for the configured topic. Uses exponential backoff retry on failure.
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Successfully connected and producer created
    /// * Never returns `Err` - loops indefinitely with retries
    async fn connect_pulsar(&mut self) -> Result<()> {
        let mut retry_delay = self.config.initial_retry_delay();
        let max_delay = self.config.max_retry_delay();
        let mut attempt = 0u32;

        loop {
            attempt += 1;
            info!("Connecting to Pulsar broker at {} (attempt {})",
                self.config.pulsar_broker, attempt);

            match self.try_connect_pulsar().await {
                Ok((client, producer)) => {
                    info!("Successfully connected to Pulsar. Topic: {}, Producer: {}",
                        self.config.pulsar_topic, self.config.source_id);
                    self.pulsar_client = Some(client);
                    self.pulsar_producer = Some(producer);
                    return Ok(());
                }
                Err(e) => {
                    warn!("Failed to connect to Pulsar: {}. Retrying in {:?}...", e, retry_delay);
                    sleep(retry_delay).await;
                    retry_delay = std::cmp::min(retry_delay * 2, max_delay);
                }
            }
        }
    }

    fn start_pulsar_reconnect_task(&mut self) {
        if self.config.test_mode || self.pulsar_producer.is_some() || self.pulsar_reconnect_task_running {
            return;
        }

        let config = self.config.clone();
        let tx = self.pulsar_reconnect_tx.clone();

        self.pulsar_reconnect_task_running = true;

        tokio::spawn(async move {
            let mut retry_delay = config.initial_retry_delay();
            let max_delay = config.max_retry_delay();
            let mut attempt = 0u32;

            loop {
                attempt += 1;
                info!(
                    "Connecting to Pulsar broker at {} (attempt {})",
                    config.pulsar_broker, attempt
                );

                let connect_result = Pulsar::builder(&config.pulsar_broker, TokioExecutor)
                    //.with_auth(Authentication::None)
                    .build()
                    .await;

                match connect_result {
                    Ok(pulsar) => {
                        let producer_result = pulsar
                            .producer()
                            .with_topic(&config.pulsar_topic)
                            .with_name(&config.source_id)
                            .with_options(producer::ProducerOptions {
                                batch_size: Some(config.pulsar_batch_max_messages),
                                ..Default::default()
                            })
                            .build()
                            .await;

                        match producer_result {
                            Ok(producer) => {
                                info!(
                                    "Successfully connected to Pulsar. Topic: {}, Producer: {}",
                                    config.pulsar_topic, config.source_id
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
                retry_delay = std::cmp::min(retry_delay * 2, max_delay);
            }
        });
    }

    /// Attempts a single Pulsar connection (no retry).
    ///
    /// Helper method for [`connect_pulsar`](Self::connect_pulsar) that
    /// makes a single connection attempt without retry logic.
    ///
    /// # Returns
    ///
    /// * `Ok((Pulsar, Producer))` - Successfully connected
    /// * `Err(ClientError::Pulsar)` - Connection failed
    async fn try_connect_pulsar(&self) -> Result<(Pulsar<TokioExecutor>, Producer<TokioExecutor>)> {
        let pulsar = Pulsar::builder(&self.config.pulsar_broker, TokioExecutor)
            //.with_auth(Authentication::None)
            .build()
            .await?;

        let producer = pulsar
            .producer()
            .with_topic(&self.config.pulsar_topic)
            .with_name(&self.config.source_id)
            .with_options(producer::ProducerOptions {
                batch_size: Some(self.config.pulsar_batch_max_messages),
                ..Default::default()
            })
            .build()
            .await?;

        Ok((pulsar, producer))
    }

    /// Receives data from socket and forwards to Pulsar.
    ///
    /// Main message processing loop that:
    /// 1. Reads data from TCP stream
    /// 2. Buffers and splits into complete lines
    /// 3. Forwards each complete message to Pulsar
    /// 4. Logs periodic statistics
    ///
    /// # Arguments
    ///
    /// * `stream` - Active TCP connection to dump1090
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Should never return Ok in normal operation
    /// * `Err(ClientError)` - Connection closed or unrecoverable error
    async fn receive_and_forward(&mut self, stream: &mut TcpStream) -> Result<()> {
        let mut buffer = vec![0u8; self.config.recv_buffer_size];
        let mut stats_interval = interval(Duration::from_secs(10));
        let mut pulsar_housekeeping_interval = interval(Duration::from_secs(1));
        let socket_read_timeout = self.config.socket_read_timeout();

        loop {
            tokio::select! {
                // Receive reconnection results without blocking dump1090 processing
                maybe_connected = self.pulsar_reconnect_rx.recv() => {
                    if let Some((client, producer)) = maybe_connected {
                        self.pulsar_client = Some(client);
                        self.pulsar_producer = Some(producer);
                        self.pulsar_reconnect_task_running = false;
                        // Try to drain a small batch immediately after reconnect.
                        self.drain_retry_queue_limited(MAX_RETRY_DRAIN_PER_TICK).await;
                    } else {
                        // Sender dropped; allow a new reconnect task to start on demand.
                        self.pulsar_reconnect_task_running = false;
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

                            // Process received data
                            let messages = self.process_buffer(&buffer[..n])?;

                            // Forward each complete message
                            for message in messages {
                                self.send_to_pulsar(message).await?;
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
                    info!("Statistics: {}", snapshot);
                }

                // Pulsar housekeeping (non-blocking for dump1090): reconnect + drain queue in small chunks
                _ = pulsar_housekeeping_interval.tick() => {
                    if !self.config.test_mode {
                        if self.pulsar_producer.is_some() {
                            self.drain_retry_queue_limited(MAX_RETRY_DRAIN_PER_TICK).await;
                        } else {
                            self.start_pulsar_reconnect_task();
                        }
                    }
                }
            }
        }
    }

    /// Processes incoming data with line buffering.
    ///
    /// Accumulates incoming bytes in an internal buffer and extracts
    /// complete newline-terminated messages. Implements buffer overflow
    /// protection to prevent memory exhaustion.
    ///
    /// # Arguments
    ///
    /// * `data` - Raw bytes received from TCP socket
    ///
    /// # Returns
    ///
    /// * `Ok(Vec<Vec<u8>>)` - List of complete messages (empty lines filtered)
    /// * `Err(ClientError::BufferOverflow)` - Buffer exceeded max size
    ///
    /// # Note
    ///
    /// Incomplete lines remain in buffer for next call.
    fn process_buffer(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>> {
        // Append new data to buffer
        self.line_buffer.extend_from_slice(data);

        // Check for buffer overflow
        if self.line_buffer.len() > self.config.max_line_buffer_size {
            warn!("Line buffer overflow ({} bytes), clearing buffer", self.line_buffer.len());
            self.line_buffer.clear();
            self.metrics.inc_errors();
            return Err(ClientError::BufferOverflow {
                current: self.line_buffer.len(),
                limit: self.config.max_line_buffer_size,
            });
        }

        let mut messages = Vec::new();

        // Split on newlines
        while let Some(newline_pos) = self.line_buffer.iter().position(|&b| b == b'\n') {
            // Extract line (without newline)
            let line = self.line_buffer.split_to(newline_pos);
            self.line_buffer.advance(1); // Skip the newline

            // Skip empty lines
            if !line.is_empty() && line.iter().any(|&b| !b.is_ascii_whitespace()) {
                messages.push(line.to_vec());
            }
        }

        Ok(messages)
    }

    /// Sends message to Pulsar with retry queue fallback.
    ///
    /// Attempts to send message to Pulsar. On failure, adds message to
    /// retry queue and attempts to reconnect. In test mode, just logs
    /// the message without sending to Pulsar.
    ///
    /// # Arguments
    ///
    /// * `message` - Complete SBS-1 message bytes
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Message sent or queued successfully
    /// * `Err(ClientError)` - Fatal error (should not happen in normal operation)
    async fn send_to_pulsar(&mut self, message: Vec<u8>) -> Result<()> {
        // Test mode: just log the message
        if self.config.test_mode {
            self.metrics.inc_messages_sent();

            // Log message content
            match String::from_utf8(message.clone()) {
                Ok(s) => info!("[TEST MODE] Message {}: {}", self.metrics.messages_sent(), s.trim()),
                Err(_) => warn!("[TEST MODE] Could not decode message {}", self.metrics.messages_sent()),
            }

            // Log statistics at sample rate
            if self.metrics.messages_sent() % self.config.log_sample_rate == 0 {
                let snapshot = self.metrics.snapshot();
                info!("[TEST MODE] Statistics: {}", snapshot);
            }

            return Ok(());
        }

        // Normal mode: send to Pulsar

        // If Pulsar is currently down/disconnected, do not block processing.
        // Display the message and enqueue for later retry.
        if self.pulsar_producer.is_none() {
            self.metrics.inc_errors();
            match String::from_utf8(message.clone()) {
                Ok(s) => info!("[PULSAR DISCONNECTED] {}", s.trim()),
                Err(_) => warn!("[PULSAR DISCONNECTED] Could not decode message"),
            }

            if self.retry_queue.len() < self.config.max_retry_queue_size {
                self.retry_queue.push_back(message);
            } else {
                warn!(
                    "Retry queue full ({} messages), dropping oldest message",
                    self.config.max_retry_queue_size
                );
                self.retry_queue.pop_front();
                self.retry_queue.push_back(message);
            }
            self.metrics.set_retry_queue_size(self.retry_queue.len() as u64);
            self.start_pulsar_reconnect_task();
            return Ok(());
        }

        // Update timestamp periodically
        if self.timestamp_update_counter % TIMESTAMP_UPDATE_INTERVAL == 0 {
            self.last_timestamp_ms = chrono::Utc::now().timestamp_millis();
        }
        self.timestamp_update_counter += 1;

        // Try to send message
        match self.try_send_message(&message).await {
            Ok(()) => {
                self.metrics.inc_messages_sent();
                self.metrics.add_bytes_sent(message.len() as u64);

                // Sample logging
                if self.metrics.messages_sent() % self.config.log_sample_rate == 0 {
                    let snapshot = self.metrics.snapshot();
                    debug!("{}", snapshot);
                }

                Ok(())
            }
            Err(e) => {
                self.metrics.inc_errors();
                error!("Failed to send message to Pulsar: {}", e);

                // Add to retry queue
                if self.retry_queue.len() < self.config.max_retry_queue_size {
                    self.retry_queue.push_back(message);
                    self.metrics.set_retry_queue_size(self.retry_queue.len() as u64);
                } else {
                    warn!("Retry queue full ({} messages), dropping oldest message",
                        self.config.max_retry_queue_size);
                    self.retry_queue.pop_front();
                    self.retry_queue.push_back(message);
                }

                // Mark Pulsar disconnected and reattempt reconnect in background.
                self.pulsar_producer = None;
                self.pulsar_client = None;
                self.start_pulsar_reconnect_task();

                // Do not block dump1090 processing.
                Ok(())
            }
        }
    }

    /// Attempts to send a single message to Pulsar (no retry).
    ///
    /// Helper method that makes a single send attempt without retry logic.
    ///
    /// # Arguments
    ///
    /// * `message` - Message bytes to send
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Message sent successfully
    /// * `Err(ClientError::Pulsar)` - Send failed
    /// * `Err(ClientError::Other)` - Producer not initialized
    async fn try_send_message(&mut self, message: &[u8]) -> Result<()> {
        if let Some(producer) = &mut self.pulsar_producer {
            producer
                .send_non_blocking(message)
                // .with_properties([
                //     ("src_id", self.config.source_id.as_str()),
                //     ("event_timestamp", &self.last_timestamp_ms.to_string()),
                // ])
                .await
                .map_err(|e: pulsar::error::Error| ClientError::Pulsar(e.into()))?;
            Ok(())
        } else {
            Err(ClientError::Other("Pulsar producer not initialized".into()))
        }
    }

    /// Drains the retry queue by attempting to resend failed messages.
    ///
    /// Called periodically when new messages arrive. Attempts to send
    /// all queued messages in order. Stops on first failure and re-queues
    /// remaining messages.
    ///
    /// # Note
    ///
    /// Updates metrics with retry queue size after drain attempt.
    async fn drain_retry_queue_limited(&mut self, max_messages: usize) {
        if self.retry_queue.is_empty() || self.pulsar_producer.is_none() {
            return;
        }

        let mut sent_count = 0;
        let mut failed_messages = Vec::new();

        while sent_count < max_messages {
            let Some(message) = self.retry_queue.pop_front() else {
                break;
            };
            match self.try_send_message(&message).await {
                Ok(()) => {
                    sent_count += 1;
                    self.metrics.add_bytes_sent(message.len() as u64);
                }
                Err(e) => {
                    debug!("Failed to send queued message: {}", e);
                    failed_messages.push(message);
                    break; // Stop trying on first failure
                }
            }
        }

        // Put failed messages back
        for msg in failed_messages.into_iter().rev() {
            self.retry_queue.push_front(msg);
        }

        self.metrics.set_retry_queue_size(self.retry_queue.len() as u64);

        if sent_count > 0 {
            info!("Successfully sent {} queued messages", sent_count);
        }
    }

    /// Gets a final statistics snapshot as a formatted string.
    ///
    /// Returns a human-readable summary of metrics including:
    /// - Total messages sent
    /// - Error count
    /// - Throughput (messages/second)
    /// - Total bytes sent and received
    ///
    /// # Returns
    ///
    /// Formatted statistics string for logging
    pub fn final_stats(&self) -> String {
        let snapshot = self.metrics.snapshot();
        format!("Final statistics: {}", snapshot)
    }
}

/// Cleanup implementation that logs final statistics on drop.
///
/// Ensures that final metrics are logged when the client is destroyed,
/// whether due to normal shutdown or panic.
impl Drop for ADSBFeedClient {
    fn drop(&mut self) {
        info!("Cleaning up ADS-B Pulsar Client");
        info!("{}", self.final_stats());
    }
}
