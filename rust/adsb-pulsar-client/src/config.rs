//! Configuration for the ADS-B feed client.
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

/// Kind of message forwarder backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ForwarderKind {
    /// Apache Pulsar (default)
    #[default]
    Pulsar,
    /// File output (one SBS-1 line per message)
    File,
    /// No-op (discard messages; used in test mode and Tauri app)
    Noop,
}

impl std::fmt::Display for ForwarderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ForwarderKind::Pulsar => write!(f, "pulsar"),
            ForwarderKind::File => write!(f, "file"),
            ForwarderKind::Noop => write!(f, "noop"),
        }
    }
}

impl std::str::FromStr for ForwarderKind {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pulsar" => Ok(ForwarderKind::Pulsar),
            "file" => Ok(ForwarderKind::File),
            "noop" => Ok(ForwarderKind::Noop),
            other => Err(format!(
                "Unknown forwarder kind: '{}'. Expected: pulsar, file, noop",
                other
            )),
        }
    }
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
#[cfg_attr(
    feature = "cli",
    command(
        name = "adsb-pulsar-client",
        about = "ADS-B Feed Client - Forward dump1090 SBS-1 messages to pluggable backends",
        version
    )
)]
pub struct Config {
    /// Unique identifier for this data source
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "kraspberryPi",
            env = "ADSB_SOURCE_ID",
            help = "Unique identifier for this data source"
        )
    )]
    #[serde(default = "default_source_id")]
    pub source_id: String,

    /// dump1090 host address
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "socket-host",
            default_value = "10.0.0.200",
            env = "ADSB_SOCKET_HOST",
            help = "dump1090 host address"
        )
    )]
    #[serde(default = "default_socket_host")]
    pub socket_host: String,

    /// dump1090 SBS-1 port
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "socket-port",
            default_value = "30003",
            env = "ADSB_SOCKET_PORT",
            help = "dump1090 SBS-1 port"
        )
    )]
    #[serde(default = "default_socket_port")]
    pub socket_port: u16,

    /// Pulsar broker URL
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "pulsar-broker",
            default_value = "pulsar://localhost:6650",
            env = "PULSAR_BROKER",
            help = "Pulsar broker URL (pulsar:// or pulsar+ssl://)"
        )
    )]
    #[serde(default = "default_pulsar_broker")]
    pub pulsar_broker: String,

    /// Pulsar topic name
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "pulsar-topic",
            default_value = "persistent://kradsb/adsb/sbs-topic",
            env = "PULSAR_TOPIC",
            help = "Pulsar topic name"
        )
    )]
    #[serde(default = "default_pulsar_topic")]
    pub pulsar_topic: String,

    /// Socket receive buffer size in bytes
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "65536",
            help = "Socket receive buffer size in bytes"
        )
    )]
    #[serde(default = "default_recv_buffer_size")]
    pub recv_buffer_size: usize,

    /// Socket timeout in seconds
    #[cfg_attr(
        feature = "cli",
        arg(long, default_value = "90", help = "Socket timeout in seconds")
    )]
    #[serde(default = "default_socket_timeout_secs")]
    pub socket_timeout_secs: u64,

    /// Socket read inactivity timeout in seconds (0 = disabled)
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "75",
            env = "ADSB_SOCKET_READ_TIMEOUT",
            help = "Socket read inactivity timeout in seconds (0 disables). Helps detect half-open TCP connections."
        )
    )]
    #[serde(default = "default_socket_read_timeout_secs")]
    pub socket_read_timeout_secs: u64,

    /// Initial retry delay in seconds
    #[cfg_attr(
        feature = "cli",
        arg(long, default_value = "1", help = "Initial retry delay in seconds")
    )]
    #[serde(default = "default_initial_retry_delay_secs")]
    pub initial_retry_delay_secs: u64,

    /// Maximum retry delay in seconds
    #[cfg_attr(
        feature = "cli",
        arg(long, default_value = "60", help = "Maximum retry delay in seconds")
    )]
    #[serde(default = "default_max_retry_delay_secs")]
    pub max_retry_delay_secs: u64,

    /// Log statistics every N messages
    #[cfg_attr(
        feature = "cli",
        arg(long, default_value = "100", help = "Log statistics every N messages")
    )]
    #[serde(default = "default_log_sample_rate")]
    pub log_sample_rate: u64,

    /// Maximum size of retry queue
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "100000",
            help = "Maximum number of messages in retry queue"
        )
    )]
    #[serde(default = "default_max_retry_queue_size")]
    pub max_retry_queue_size: usize,

    /// Maximum line buffer size in bytes
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "10000000",
            help = "Maximum line buffer size in bytes (prevents memory exhaustion)"
        )
    )]
    #[serde(default = "default_max_line_buffer_size")]
    pub max_line_buffer_size: usize,

    /// Pulsar batching delay in milliseconds
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "100",
            help = "Pulsar batching delay in milliseconds"
        )
    )]
    #[serde(default = "default_pulsar_batch_delay_ms")]
    pub pulsar_batch_delay_ms: u64,

    /// Pulsar maximum batch messages
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "100",
            help = "Maximum messages per Pulsar batch"
        )
    )]
    #[serde(default = "default_pulsar_batch_max_messages")]
    pub pulsar_batch_max_messages: u32,

    /// Run in test mode (no forwarder connections, just log messages)
    #[cfg_attr(
        feature = "cli",
        arg(long, help = "Run in test mode (display messages only, no forwarding)")
    )]
    #[serde(default)]
    pub test_mode: bool,

    /// Logging level
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "info",
            help = "Logging level (trace, debug, info, warn, error)"
        )
    )]
    #[serde(default = "default_log_level")]
    pub log_level: String,

    /// Connection mode (client or server)
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "client",
            help = "Connection mode: client (connect to dump1090) or server (listen for connections)"
        )
    )]
    #[serde(default = "default_connection_mode")]
    pub connection_mode: String,

    /// IANA timezone name for interpreting dump1090 SBS-1 timestamps.
    ///
    /// `"Local"` (default) uses the machine's local timezone.
    /// `"UTC"` forces UTC. Any IANA name (e.g. `"Europe/Paris"`) is accepted.
    /// An unrecognised name logs a warning at runtime and falls back to Local.
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "dump1090-tz",
            default_value = "Local",
            hide = true,
            help = "Timezone for dump1090 timestamps (Local, UTC, or IANA name e.g. Europe/Paris)"
        )
    )]
    #[serde(default = "default_dump1090_tz")]
    pub dump1090_tz: String,

    /// Forwarder backends to use (can be specified multiple times)
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "forwarder",
            default_value = "pulsar",
            help = "Forwarder backend: pulsar, file, noop (can be repeated)"
        )
    )]
    #[serde(default = "default_forwarders")]
    pub forwarders: Vec<ForwarderKind>,

    /// Output file path for the file forwarder
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "file-path",
            default_value_t = default_file_path(),
            help = "Output file path for the file forwarder"
        )
    )]
    #[serde(default = "default_file_path")]
    pub file_path: String,
}

// Default value functions for serde
fn default_source_id() -> String {
    "kraspberryPi".to_string()
}
fn default_socket_host() -> String {
    "10.0.0.200".to_string()
}
fn default_socket_port() -> u16 {
    30003
}
fn default_pulsar_broker() -> String {
    "pulsar://localhost:6650".to_string()
}
fn default_pulsar_topic() -> String {
    "persistent://kradsb/adsb/sbs-topic".to_string()
}
fn default_recv_buffer_size() -> usize {
    65536
}
fn default_socket_timeout_secs() -> u64 {
    90
}
fn default_socket_read_timeout_secs() -> u64 {
    75
}
fn default_initial_retry_delay_secs() -> u64 {
    1
}
fn default_max_retry_delay_secs() -> u64 {
    60
}
fn default_log_sample_rate() -> u64 {
    100
}
fn default_max_retry_queue_size() -> usize {
    100000
}
fn default_max_line_buffer_size() -> usize {
    10000000
}
fn default_pulsar_batch_delay_ms() -> u64 {
    100
}
fn default_pulsar_batch_max_messages() -> u32 {
    100
}
fn default_log_level() -> String {
    "info".to_string()
}
fn default_connection_mode() -> String {
    "client".to_string()
}
fn default_dump1090_tz() -> String {
    "Local".to_string()
}
fn default_forwarders() -> Vec<ForwarderKind> {
    vec![ForwarderKind::Pulsar]
}
fn default_file_path() -> String {
    format!(
        "adsb_messages_{}.sbs",
        chrono::Local::now().format("%Y%m%d_%H%M")
    )
}

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
            dump1090_tz: default_dump1090_tz(),
            forwarders: default_forwarders(),
            file_path: default_file_path(),
        }
    }
}

impl Config {
    /// Validates all configuration parameters.
    ///
    /// Checks for:
    /// - Non-empty source_id
    /// - Valid Pulsar broker URL format (only when Pulsar forwarder is selected)
    /// - Valid connection mode string
    /// - Non-zero buffer sizes
    pub fn validate(&self) -> Result<()> {
        // Validate source_id
        if self.source_id.trim().is_empty() {
            return Err(ClientError::Config("source_id cannot be empty".into()));
        }

        // Validate Pulsar broker URL only when Pulsar forwarder is configured
        if self.forwarders.contains(&ForwarderKind::Pulsar)
            && !self.pulsar_broker.starts_with("pulsar://")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dump1090_tz_defaults_to_local() {
        let config = Config::default();
        assert_eq!(config.dump1090_tz, "Local");
    }

    #[test]
    fn test_dump1090_tz_serializes() {
        let config = Config {
            dump1090_tz: "Europe/Paris".to_string(),
            ..Config::default()
        };
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["dump1090_tz"], "Europe/Paris");
    }

    #[test]
    fn test_dump1090_tz_deserializes_default_when_missing() {
        // Old configs without the field should deserialize to "Local"
        let json = serde_json::json!({ "source_id": "test" });
        let config: Config = serde_json::from_value(json).unwrap();
        assert_eq!(config.dump1090_tz, "Local");
    }

    #[test]
    fn test_default_config_is_valid() {
        assert!(Config::default().validate().is_ok());
    }

    #[test]
    fn test_validate_empty_source_id() {
        let mut config = Config::default();
        config.source_id = "".to_string();
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("source_id cannot be empty"));
    }

    #[test]
    fn test_validate_whitespace_source_id() {
        let mut config = Config::default();
        config.source_id = "   ".to_string();
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("source_id cannot be empty"));
    }

    #[test]
    fn test_validate_invalid_broker_http() {
        let mut config = Config::default();
        config.pulsar_broker = "http://localhost:6650".to_string();
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_valid_broker_ssl() {
        let mut config = Config::default();
        config.pulsar_broker = "pulsar+ssl://broker.example.com:6651".to_string();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_invalid_connection_mode() {
        let mut config = Config::default();
        config.connection_mode = "hybrid".to_string();
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_zero_recv_buffer() {
        let mut config = Config::default();
        config.recv_buffer_size = 0;
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("recv_buffer_size"));
    }

    #[test]
    fn test_validate_zero_line_buffer() {
        let mut config = Config::default();
        config.max_line_buffer_size = 0;
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("max_line_buffer_size"));
    }

    #[test]
    fn test_get_connection_mode_client() {
        let config = Config::default();
        assert_eq!(config.get_connection_mode(), ConnectionMode::Client);
    }

    #[test]
    fn test_get_connection_mode_server() {
        let mut config = Config::default();
        config.connection_mode = "server".to_string();
        assert_eq!(config.get_connection_mode(), ConnectionMode::Server);
    }

    #[test]
    fn test_get_connection_mode_unknown_defaults() {
        let mut config = Config::default();
        config.connection_mode = "something_else".to_string();
        assert_eq!(config.get_connection_mode(), ConnectionMode::Client);
    }

    #[test]
    fn test_socket_timeout_conversion() {
        let mut config = Config::default();
        config.socket_timeout_secs = 30;
        assert_eq!(config.socket_timeout(), Duration::from_secs(30));
    }

    #[test]
    fn test_socket_read_timeout_zero_is_none() {
        let mut config = Config::default();
        config.socket_read_timeout_secs = 0;
        assert_eq!(config.socket_read_timeout(), None);
    }

    #[test]
    fn test_socket_read_timeout_nonzero() {
        let mut config = Config::default();
        config.socket_read_timeout_secs = 75;
        assert_eq!(config.socket_read_timeout(), Some(Duration::from_secs(75)));
    }

    #[test]
    fn test_initial_retry_delay_conversion() {
        let mut config = Config::default();
        config.initial_retry_delay_secs = 5;
        assert_eq!(config.initial_retry_delay(), Duration::from_secs(5));
    }

    #[test]
    fn test_max_retry_delay_conversion() {
        let mut config = Config::default();
        config.max_retry_delay_secs = 120;
        assert_eq!(config.max_retry_delay(), Duration::from_secs(120));
    }

    #[test]
    fn test_pulsar_batch_delay_conversion() {
        let mut config = Config::default();
        config.pulsar_batch_delay_ms = 200;
        assert_eq!(config.pulsar_batch_delay(), Duration::from_millis(200));
    }

    #[test]
    fn test_config_serde_roundtrip() {
        let original = Config::default();
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: Config = serde_json::from_str(&json).unwrap();

        assert_eq!(original.source_id, deserialized.source_id);
        assert_eq!(original.socket_host, deserialized.socket_host);
        assert_eq!(original.socket_port, deserialized.socket_port);
        assert_eq!(original.pulsar_broker, deserialized.pulsar_broker);
        assert_eq!(original.pulsar_topic, deserialized.pulsar_topic);
        assert_eq!(original.recv_buffer_size, deserialized.recv_buffer_size);
        assert_eq!(
            original.socket_timeout_secs,
            deserialized.socket_timeout_secs
        );
        assert_eq!(
            original.max_line_buffer_size,
            deserialized.max_line_buffer_size
        );
        assert_eq!(
            original.pulsar_batch_delay_ms,
            deserialized.pulsar_batch_delay_ms
        );
        assert_eq!(original.test_mode, deserialized.test_mode);
        assert_eq!(original.connection_mode, deserialized.connection_mode);
        assert_eq!(original.forwarders, deserialized.forwarders);
    }

    #[test]
    fn test_validate_file_forwarder_skips_broker_check() {
        let mut config = Config::default();
        config.forwarders = vec![ForwarderKind::File];
        config.pulsar_broker = "not-a-valid-url".to_string();
        // Should pass because Pulsar broker is not checked when not using Pulsar
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_noop_forwarder_skips_broker_check() {
        let mut config = Config::default();
        config.forwarders = vec![ForwarderKind::Noop];
        config.pulsar_broker = "garbage".to_string();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_forwarder_kind_display() {
        assert_eq!(ForwarderKind::Pulsar.to_string(), "pulsar");
        assert_eq!(ForwarderKind::File.to_string(), "file");
        assert_eq!(ForwarderKind::Noop.to_string(), "noop");
    }

    #[test]
    fn test_forwarder_kind_from_str() {
        assert_eq!(
            "pulsar".parse::<ForwarderKind>().unwrap(),
            ForwarderKind::Pulsar
        );
        assert_eq!(
            "file".parse::<ForwarderKind>().unwrap(),
            ForwarderKind::File
        );
        assert_eq!(
            "noop".parse::<ForwarderKind>().unwrap(),
            ForwarderKind::Noop
        );
        assert_eq!(
            "PULSAR".parse::<ForwarderKind>().unwrap(),
            ForwarderKind::Pulsar
        );
        assert!("unknown".parse::<ForwarderKind>().is_err());
    }

    #[test]
    fn test_default_forwarders_is_pulsar() {
        let config = Config::default();
        assert_eq!(config.forwarders, vec![ForwarderKind::Pulsar]);
    }

    #[test]
    fn test_default_file_path_has_timestamp() {
        let config = Config::default();
        assert!(config.file_path.starts_with("adsb_messages_"));
        assert!(config.file_path.ends_with(".sbs"));
    }
}
