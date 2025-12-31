//! Configuration for the ADS-B Pulsar client.
//!
//! This module defines the configuration structure and command-line arguments
//! for the client. All configuration can be provided via:
//! - Command-line arguments
//! - Environment variables
//! - Default values
//!
//! # Examples
//!
//! ```no_run
//! use adsb_pulsar_client::Config;
//! use clap::Parser;
//!
//! let config = Config::parse();
//! config.validate()?;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

use crate::error::{ClientError, Result};
use clap::Parser;
use std::time::Duration;

/// Connection mode for the socket.
///
/// Determines whether the client connects to dump1090 (client mode)
/// or listens for dump1090 to connect (server mode).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionMode {
    /// Connect to a remote dump1090 instance (typical deployment)
    Client,
    /// Listen for incoming connections from dump1090 (server mode)
    Server,
}

/// Command-line arguments and runtime configuration.
///
/// All fields can be set via command-line arguments or environment variables.
/// See individual field documentation for env var names.
///
/// # Examples
///
/// ```bash
/// # Via command-line
/// adsb-pulsar-client --source-id my-pi --socket-host 192.168.1.100
///
/// # Via environment variables
/// export ADSB_SOURCE_ID=my-pi
/// export ADSB_SOCKET_HOST=192.168.1.100
/// adsb-pulsar-client
/// ```
#[derive(Parser, Debug, Clone)]
#[command(
    name = "adsb-pulsar-client",
    about = "ADS-B Feed Client - Forward dump1090 SBS-1 messages to Apache Pulsar",
    version
)]
pub struct Config {
    /// Unique identifier for this data source
    #[arg(
        long,
        default_value = "kraspberryPi",
        env = "ADSB_SOURCE_ID",
        help = "Unique identifier for this data source"
    )]
    pub source_id: String,

    /// dump1090 host address
    #[arg(
        long = "socket-host",
        default_value = "10.0.0.200",
        env = "ADSB_SOCKET_HOST",
        help = "dump1090 host address"
    )]
    pub socket_host: String,

    /// dump1090 SBS-1 port
    #[arg(
        long = "socket-port",
        default_value = "30003",
        env = "ADSB_SOCKET_PORT",
        help = "dump1090 SBS-1 port"
    )]
    pub socket_port: u16,

    /// Pulsar broker URL
    #[arg(
        long = "pulsar-broker",
        default_value = "pulsar://localhost:6650",
        env = "PULSAR_BROKER",
        help = "Pulsar broker URL (pulsar:// or pulsar+ssl://)"
    )]
    pub pulsar_broker: String,

    /// Pulsar topic name
    #[arg(
        long = "pulsar-topic",
        default_value = "persistent://kradsb/adsb/sbs-topic",
        env = "PULSAR_TOPIC",
        help = "Pulsar topic name"
    )]
    pub pulsar_topic: String,

    /// Socket receive buffer size in bytes
    #[arg(
        long,
        default_value = "65536",
        help = "Socket receive buffer size in bytes"
    )]
    pub recv_buffer_size: usize,

    /// Socket timeout in seconds
    #[arg(
        long,
        default_value = "90",
        help = "Socket timeout in seconds"
    )]
    pub socket_timeout_secs: u64,

    /// Socket read inactivity timeout in seconds (0 = disabled)
    #[arg(
        long,
        default_value = "75",
        env = "ADSB_SOCKET_READ_TIMEOUT",
        help = "Socket read inactivity timeout in seconds (0 disables). Helps detect half-open TCP connections."
    )]
    pub socket_read_timeout_secs: u64,

    /// Initial retry delay in seconds
    #[arg(
        long,
        default_value = "1",
        help = "Initial retry delay in seconds"
    )]
    pub initial_retry_delay_secs: u64,

    /// Maximum retry delay in seconds
    #[arg(
        long,
        default_value = "60",
        help = "Maximum retry delay in seconds"
    )]
    pub max_retry_delay_secs: u64,

    /// Log statistics every N messages
    #[arg(
        long,
        default_value = "100",
        help = "Log statistics every N messages"
    )]
    pub log_sample_rate: u64,

    /// Maximum size of retry queue
    #[arg(
        long,
        default_value = "100000",
        help = "Maximum number of messages in retry queue"
    )]
    pub max_retry_queue_size: usize,

    /// Maximum line buffer size in bytes
    #[arg(
        long,
        default_value = "10000000",
        help = "Maximum line buffer size in bytes (prevents memory exhaustion)"
    )]
    pub max_line_buffer_size: usize,

    /// Pulsar batching delay in milliseconds
    #[arg(
        long,
        default_value = "100",
        help = "Pulsar batching delay in milliseconds"
    )]
    pub pulsar_batch_delay_ms: u64,

    /// Pulsar maximum batch messages
    #[arg(
        long,
        default_value = "100",
        help = "Maximum messages per Pulsar batch"
    )]
    pub pulsar_batch_max_messages: u32,

    /// Run in test mode (no Pulsar, just log messages)
    #[arg(
        long,
        help = "Run in test mode without Pulsar (display messages only)"
    )]
    pub test_mode: bool,

    /// Logging level
    #[arg(
        long,
        default_value = "info",
        help = "Logging level (trace, debug, info, warn, error)"
    )]
    pub log_level: String,

    /// Connection mode (client or server)
    #[arg(
        long,
        default_value = "client",
        help = "Connection mode: client (connect to dump1090) or server (listen for connections)"
    )]
    pub connection_mode: String,
}

impl Config {
    /// Validates all configuration parameters.
    ///
    /// Checks for:
    /// - Non-empty source_id
    /// - Valid Pulsar broker URL format
    /// - Valid connection mode string
    /// - Non-zero buffer sizes
    ///
    /// # Returns
    ///
    /// * `Ok(())` - All parameters valid
    /// * `Err(ClientError::Config)` - One or more invalid parameters
    ///
    /// # Examples
    ///
    /// ```no_run
    /// # use adsb_pulsar_client::Config;
    /// # use clap::Parser;
    /// let config = Config::parse();
    /// config.validate()?;
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// ```
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
    ///
    /// # Returns
    ///
    /// * [`ConnectionMode::Client`] - If mode is "client" (default)
    /// * [`ConnectionMode::Server`] - If mode is "server"
    pub fn get_connection_mode(&self) -> ConnectionMode {
        match self.connection_mode.as_str() {
            "server" => ConnectionMode::Server,
            _ => ConnectionMode::Client,
        }
    }

    /// Gets socket timeout as a [`Duration`].
    ///
    /// # Returns
    ///
    /// Socket timeout duration in seconds
    pub fn socket_timeout(&self) -> Duration {
        Duration::from_secs(self.socket_timeout_secs)
    }

    /// Gets socket read timeout as an optional [`Duration`].
    ///
    /// When set to 0, read timeouts are disabled (the client may block forever
    /// on a half-open connection). When non-zero, the client forces a reconnect
    /// if no bytes are received for the configured duration.
    pub fn socket_read_timeout(&self) -> Option<Duration> {
        if self.socket_read_timeout_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(self.socket_read_timeout_secs))
        }
    }

    /// Gets initial retry delay as a [`Duration`].
    ///
    /// # Returns
    ///
    /// Initial delay before first retry attempt
    pub fn initial_retry_delay(&self) -> Duration {
        Duration::from_secs(self.initial_retry_delay_secs)
    }

    /// Gets maximum retry delay as a [`Duration`].
    ///
    /// # Returns
    ///
    /// Maximum delay between retry attempts (backoff ceiling)
    pub fn max_retry_delay(&self) -> Duration {
        Duration::from_secs(self.max_retry_delay_secs)
    }

    /// Gets Pulsar batch delay as a [`Duration`].
    ///
    /// # Returns
    ///
    /// Maximum time to wait before sending a partial batch
    pub fn pulsar_batch_delay(&self) -> Duration {
        Duration::from_millis(self.pulsar_batch_delay_ms)
    }
}
