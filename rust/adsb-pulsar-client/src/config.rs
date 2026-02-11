//! Configuration for the ADS-B Pulsar client.
//!
//! This module defines the configuration structure and command-line arguments
//! for the client. All configuration can be provided via:
//! - Command-line arguments (when `cli` feature is enabled)
//! - Environment variables
//! - Default values
//! - Programmatic construction (e.g., from a desktop app)

use crate::error::{ClientError, Result};
#[cfg(feature = "cli")]
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Connection mode for the socket.
///
/// Determines whether the client connects to dump1090 (client mode)
/// or listens for dump1090 to connect (server mode).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionMode {
    /// Connect to a remote dump1090 instance (typical deployment)
    Client,
    /// Listen for incoming connections from dump1090 (server mode)
    Server,
}

/// Command-line arguments and runtime configuration.
///
/// All fields can be set via command-line arguments or environment variables
/// (when `cli` feature is enabled), or constructed programmatically.
///
/// # Examples
///
/// ```bash
/// # Via command-line (requires cli feature)
/// adsb-pulsar-client --source-id my-pi --socket-host 192.168.1.100
///
/// # Via environment variables
/// export ADSB_SOURCE_ID=my-pi
/// export ADSB_SOCKET_HOST=192.168.1.100
/// adsb-pulsar-client
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "cli", derive(Parser))]
#[cfg_attr(feature = "cli", command(
    name = "adsb-pulsar-client",
    about = "ADS-B Feed Client - Forward dump1090 SBS-1 messages to Apache Pulsar",
    version
))]
pub struct Config {
    /// Unique identifier for this data source
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "kraspberryPi",
        env = "ADSB_SOURCE_ID",
        help = "Unique identifier for this data source"
    ))]
    #[serde(default = "default_source_id")]
    pub source_id: String,

    /// dump1090 host address
    #[cfg_attr(feature = "cli", arg(
        long = "socket-host",
        default_value = "10.0.0.200",
        env = "ADSB_SOCKET_HOST",
        help = "dump1090 host address"
    ))]
    #[serde(default = "default_socket_host")]
    pub socket_host: String,

    /// dump1090 SBS-1 port
    #[cfg_attr(feature = "cli", arg(
        long = "socket-port",
        default_value = "30003",
        env = "ADSB_SOCKET_PORT",
        help = "dump1090 SBS-1 port"
    ))]
    #[serde(default = "default_socket_port")]
    pub socket_port: u16,

    /// Pulsar broker URL
    #[cfg_attr(feature = "cli", arg(
        long = "pulsar-broker",
        default_value = "pulsar://localhost:6650",
        env = "PULSAR_BROKER",
        help = "Pulsar broker URL (pulsar:// or pulsar+ssl://)"
    ))]
    #[serde(default = "default_pulsar_broker")]
    pub pulsar_broker: String,

    /// Pulsar topic name
    #[cfg_attr(feature = "cli", arg(
        long = "pulsar-topic",
        default_value = "persistent://kradsb/adsb/sbs-topic",
        env = "PULSAR_TOPIC",
        help = "Pulsar topic name"
    ))]
    #[serde(default = "default_pulsar_topic")]
    pub pulsar_topic: String,

    /// Socket receive buffer size in bytes
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "65536",
        help = "Socket receive buffer size in bytes"
    ))]
    #[serde(default = "default_recv_buffer_size")]
    pub recv_buffer_size: usize,

    /// Socket timeout in seconds
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "90",
        help = "Socket timeout in seconds"
    ))]
    #[serde(default = "default_socket_timeout_secs")]
    pub socket_timeout_secs: u64,

    /// Socket read inactivity timeout in seconds (0 = disabled)
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "75",
        env = "ADSB_SOCKET_READ_TIMEOUT",
        help = "Socket read inactivity timeout in seconds (0 disables). Helps detect half-open TCP connections."
    ))]
    #[serde(default = "default_socket_read_timeout_secs")]
    pub socket_read_timeout_secs: u64,

    /// Initial retry delay in seconds
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "1",
        help = "Initial retry delay in seconds"
    ))]
    #[serde(default = "default_initial_retry_delay_secs")]
    pub initial_retry_delay_secs: u64,

    /// Maximum retry delay in seconds
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "60",
        help = "Maximum retry delay in seconds"
    ))]
    #[serde(default = "default_max_retry_delay_secs")]
    pub max_retry_delay_secs: u64,

    /// Log statistics every N messages
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "100",
        help = "Log statistics every N messages"
    ))]
    #[serde(default = "default_log_sample_rate")]
    pub log_sample_rate: u64,

    /// Maximum size of retry queue
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "100000",
        help = "Maximum number of messages in retry queue"
    ))]
    #[serde(default = "default_max_retry_queue_size")]
    pub max_retry_queue_size: usize,

    /// Maximum line buffer size in bytes
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "10000000",
        help = "Maximum line buffer size in bytes (prevents memory exhaustion)"
    ))]
    #[serde(default = "default_max_line_buffer_size")]
    pub max_line_buffer_size: usize,

    /// Pulsar batching delay in milliseconds
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "100",
        help = "Pulsar batching delay in milliseconds"
    ))]
    #[serde(default = "default_pulsar_batch_delay_ms")]
    pub pulsar_batch_delay_ms: u64,

    /// Pulsar maximum batch messages
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "100",
        help = "Maximum messages per Pulsar batch"
    ))]
    #[serde(default = "default_pulsar_batch_max_messages")]
    pub pulsar_batch_max_messages: u32,

    /// Run in test mode (no Pulsar, just log messages)
    #[cfg_attr(feature = "cli", arg(
        long,
        help = "Run in test mode without Pulsar (display messages only)"
    ))]
    #[serde(default)]
    pub test_mode: bool,

    /// Logging level
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "info",
        help = "Logging level (trace, debug, info, warn, error)"
    ))]
    #[serde(default = "default_log_level")]
    pub log_level: String,

    /// Connection mode (client or server)
    #[cfg_attr(feature = "cli", arg(
        long,
        default_value = "client",
        help = "Connection mode: client (connect to dump1090) or server (listen for connections)"
    ))]
    #[serde(default = "default_connection_mode")]
    pub connection_mode: String,
}

// Default value functions for serde
fn default_source_id() -> String { "kraspberryPi".to_string() }
fn default_socket_host() -> String { "10.0.0.200".to_string() }
fn default_socket_port() -> u16 { 30003 }
fn default_pulsar_broker() -> String { "pulsar://localhost:6650".to_string() }
fn default_pulsar_topic() -> String { "persistent://kradsb/adsb/sbs-topic".to_string() }
fn default_recv_buffer_size() -> usize { 65536 }
fn default_socket_timeout_secs() -> u64 { 90 }
fn default_socket_read_timeout_secs() -> u64 { 75 }
fn default_initial_retry_delay_secs() -> u64 { 1 }
fn default_max_retry_delay_secs() -> u64 { 60 }
fn default_log_sample_rate() -> u64 { 100 }
fn default_max_retry_queue_size() -> usize { 100000 }
fn default_max_line_buffer_size() -> usize { 10000000 }
fn default_pulsar_batch_delay_ms() -> u64 { 100 }
fn default_pulsar_batch_max_messages() -> u32 { 100 }
fn default_log_level() -> String { "info".to_string() }
fn default_connection_mode() -> String { "client".to_string() }

impl Default for Config {
    fn default() -> Self {
        Self {
            source_id: default_source_id(),
            socket_host: default_socket_host(),
            socket_port: default_socket_port(),
            pulsar_broker: default_pulsar_broker(),
            pulsar_topic: default_pulsar_topic(),
            recv_buffer_size: default_recv_buffer_size(),
            socket_timeout_secs: default_socket_timeout_secs(),
            socket_read_timeout_secs: default_socket_read_timeout_secs(),
            initial_retry_delay_secs: default_initial_retry_delay_secs(),
            max_retry_delay_secs: default_max_retry_delay_secs(),
            log_sample_rate: default_log_sample_rate(),
            max_retry_queue_size: default_max_retry_queue_size(),
            max_line_buffer_size: default_max_line_buffer_size(),
            pulsar_batch_delay_ms: default_pulsar_batch_delay_ms(),
            pulsar_batch_max_messages: default_pulsar_batch_max_messages(),
            test_mode: false,
            log_level: default_log_level(),
            connection_mode: default_connection_mode(),
        }
    }
}

impl Config {
    /// Validates all configuration parameters.
    ///
    /// Checks for:
    /// - Non-empty source_id
    /// - Valid Pulsar broker URL format
    /// - Valid connection mode string
    /// - Non-zero buffer sizes
    pub fn validate(&self) -> Result<()> {
        // Validate source_id
        if self.source_id.trim().is_empty() {
            return Err(ClientError::Config("source_id cannot be empty".into()));
        }

        // Validate Pulsar broker URL
        if !self.pulsar_broker.starts_with("pulsar://")
            && !self.pulsar_broker.starts_with("pulsar+ssl://")
        {
            return Err(ClientError::Config(
                "Pulsar broker URL must start with pulsar:// or pulsar+ssl://".into(),
            ));
        }

        // Validate connection mode
        if self.connection_mode != "client" && self.connection_mode != "server" {
            return Err(ClientError::Config(
                "connection_mode must be 'client' or 'server'".into(),
            ));
        }

        // Validate buffer sizes
        if self.recv_buffer_size == 0 {
            return Err(ClientError::Config(
                "recv_buffer_size must be greater than 0".into(),
            ));
        }

        if self.max_line_buffer_size == 0 {
            return Err(ClientError::Config(
                "max_line_buffer_size must be greater than 0".into(),
            ));
        }

        Ok(())
    }

    /// Converts connection mode string to enum.
    pub fn get_connection_mode(&self) -> ConnectionMode {
        match self.connection_mode.as_str() {
            "server" => ConnectionMode::Server,
            _ => ConnectionMode::Client,
        }
    }

    /// Gets socket timeout as a [`Duration`].
    pub fn socket_timeout(&self) -> Duration {
        Duration::from_secs(self.socket_timeout_secs)
    }

    /// Gets socket read timeout as an optional [`Duration`].
    pub fn socket_read_timeout(&self) -> Option<Duration> {
        if self.socket_read_timeout_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(self.socket_read_timeout_secs))
        }
    }

    /// Gets initial retry delay as a [`Duration`].
    pub fn initial_retry_delay(&self) -> Duration {
        Duration::from_secs(self.initial_retry_delay_secs)
    }

    /// Gets maximum retry delay as a [`Duration`].
    pub fn max_retry_delay(&self) -> Duration {
        Duration::from_secs(self.max_retry_delay_secs)
    }

    /// Gets Pulsar batch delay as a [`Duration`].
    pub fn pulsar_batch_delay(&self) -> Duration {
        Duration::from_millis(self.pulsar_batch_delay_ms)
    }
}
