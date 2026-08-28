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

/// Where the live SBS-1 feed comes from.
///
/// A consumer either connects straight to dump1090, or subscribes to a feed
/// another process is publishing. The latter is what lets the desktop app run
/// against a Raspberry Pi with no Apache Pulsar in the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    /// Connect directly to a dump1090 TCP socket (default).
    #[default]
    Socket,
    /// Subscribe to raw SBS-1 lines on an MQTT topic.
    Mqtt,
}

impl std::fmt::Display for SourceKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SourceKind::Socket => write!(f, "socket"),
            SourceKind::Mqtt => write!(f, "mqtt"),
        }
    }
}

impl std::str::FromStr for SourceKind {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "socket" => Ok(SourceKind::Socket),
            "mqtt" => Ok(SourceKind::Mqtt),
            other => Err(format!(
                "Unknown source kind: '{}'. Expected: socket, mqtt",
                other
            )),
        }
    }
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
    /// MQTT publish (lightweight LAN transport; enables no-Pulsar deployments)
    Mqtt,
    /// No-op (discard messages; used in test mode and Tauri app)
    Noop,
}

impl std::fmt::Display for ForwarderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ForwarderKind::Pulsar => write!(f, "pulsar"),
            ForwarderKind::File => write!(f, "file"),
            ForwarderKind::Mqtt => write!(f, "mqtt"),
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
            "mqtt" => Ok(ForwarderKind::Mqtt),
            "noop" => Ok(ForwarderKind::Noop),
            other => Err(format!(
                "Unknown forwarder kind: '{}'. Expected: pulsar, mqtt, file, noop",
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
    /// Path to a TOML config file. Not itself settable from the file.
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "/etc/adsb/feed.toml",
            env = "ADSB_FEED_CONFIG",
            help = "Path to a TOML config file"
        )
    )]
    #[serde(skip, default = "default_config_path")]
    pub config: std::path::PathBuf,

    /// Print the effective configuration as TOML and exit.
    ///
    /// With four layers in play (defaults, file, environment, flags), "what did
    /// this node actually load?" is otherwise unanswerable on a running edge
    /// device.
    #[cfg_attr(
        feature = "cli",
        arg(long, help = "Print the effective configuration and exit")
    )]
    #[serde(skip)]
    pub print_config: bool,

    /// Where the live feed comes from: a direct dump1090 socket, or an MQTT
    /// subscription to a feed another process publishes.
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "source-kind",
            default_value = "socket",
            env = "ADSB_SOURCE_KIND",
            help = "Live feed source: socket, mqtt"
        )
    )]
    #[serde(default)]
    pub source_kind: SourceKind,

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
            help = "Forwarder backend: pulsar, mqtt, file, noop (can be repeated)"
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

    /// Heartbeat inactivity timeout in seconds (0 = disabled).
    ///
    /// If no heartbeat (hex_ident 000000) or data message arrives within this
    /// period, the connection is considered stale and reconnection is triggered.
    /// Default: 90s (1.5x the dump1090 60s heartbeat interval).
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = "90",
            env = "ADSB_HEARTBEAT_TIMEOUT",
            help = "Heartbeat inactivity timeout in seconds (0 disables). Triggers reconnect if no heartbeat/data arrives."
        )
    )]
    #[serde(default = "default_heartbeat_timeout_secs")]
    pub heartbeat_timeout_secs: u64,

    /// Byte pattern that identifies a heartbeat line from dump1090.
    ///
    /// The default `,000000,` matches the hex_ident field in SBS-1 heartbeat
    /// messages. Empty string disables pattern matching (all lines count as data).
    #[cfg_attr(
        feature = "cli",
        arg(
            long,
            default_value = ",000000,",
            env = "ADSB_HEARTBEAT_PATTERN",
            help = "Byte pattern identifying heartbeat lines (empty to disable)"
        )
    )]
    #[serde(default = "default_heartbeat_pattern")]
    pub heartbeat_pattern: String,

    /// MQTT broker hostname or IP.
    ///
    /// The MQTT hop is the lightweight LAN transport between this feed client
    /// and local consumers (`adsb-data-server`, the desktop app). Selecting
    /// only the `mqtt` forwarder yields a deployment with no Pulsar at all.
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "mqtt-broker",
            default_value = "localhost",
            env = "ADSB_MQTT_BROKER",
            help = "MQTT broker hostname or IP"
        )
    )]
    #[serde(default = "default_mqtt_broker")]
    pub mqtt_broker: String,

    /// MQTT broker port
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "mqtt-port",
            default_value = "1883",
            env = "ADSB_MQTT_PORT",
            help = "MQTT broker port"
        )
    )]
    #[serde(default = "default_mqtt_port")]
    pub mqtt_port: u16,

    /// MQTT topic to publish raw SBS-1 lines on
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "mqtt-topic",
            default_value = "adsb/sbs/raw",
            env = "ADSB_MQTT_TOPIC",
            help = "MQTT topic carrying raw SBS-1 lines"
        )
    )]
    #[serde(default = "default_mqtt_topic")]
    pub mqtt_topic: String,

    /// MQTT client identifier. Empty derives it from `source_id`.
    ///
    /// Brokers disconnect an existing session when a second client connects
    /// with the same id, so every node in a fleet needs a distinct value —
    /// which `source_id` already guarantees.
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "mqtt-client-id",
            default_value = "",
            env = "ADSB_MQTT_CLIENT_ID",
            help = "MQTT client id (defaults to source_id)"
        )
    )]
    #[serde(default)]
    pub mqtt_client_id: String,

    /// MQTT quality of service: 0, 1 or 2.
    ///
    /// Defaults to 0. This is a LAN hop feeding a recorder and a UI, and the
    /// forwarder fan-out is fire-and-forget by design — a slow MQTT sink must
    /// never backpressure the Pulsar leg or the socket read loop.
    #[cfg_attr(
        feature = "cli",
        arg(
            long = "mqtt-qos",
            default_value = "0",
            env = "ADSB_MQTT_QOS",
            help = "MQTT QoS level: 0, 1 or 2"
        )
    )]
    #[serde(default)]
    pub mqtt_qos: u8,

    /// Receiver antenna latitude (decimal degrees)
    #[cfg_attr(feature = "cli", arg(skip))]
    #[serde(default)]
    pub receiver_latitude: Option<f64>,

    /// Receiver antenna longitude (decimal degrees)
    #[cfg_attr(feature = "cli", arg(skip))]
    #[serde(default)]
    pub receiver_longitude: Option<f64>,

    /// Receiver antenna altitude (feet, for consistency with aircraft altitudes)
    #[cfg_attr(feature = "cli", arg(skip))]
    #[serde(default)]
    pub receiver_altitude: Option<f64>,
}

// Default value functions for serde
fn default_config_path() -> std::path::PathBuf {
    std::path::PathBuf::from("/etc/adsb/feed.toml")
}
fn default_source_id() -> String {
    "kraspberryPi".to_string()
}
fn default_socket_host() -> String {
    "10.0.0.200".to_string()
}
fn default_socket_port() -> u16 {
    30003
}
fn default_mqtt_broker() -> String {
    "localhost".to_string()
}
fn default_mqtt_port() -> u16 {
    1883
}
fn default_mqtt_topic() -> String {
    "adsb/sbs/raw".to_string()
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
fn default_heartbeat_timeout_secs() -> u64 {
    90
}
fn default_heartbeat_pattern() -> String {
    ",000000,".to_string()
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
            config: default_config_path(),
            print_config: false,
            source_kind: SourceKind::Socket,
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
            mqtt_broker: default_mqtt_broker(),
            mqtt_port: default_mqtt_port(),
            mqtt_topic: default_mqtt_topic(),
            mqtt_client_id: String::new(),
            mqtt_qos: 0,
            heartbeat_timeout_secs: default_heartbeat_timeout_secs(),
            heartbeat_pattern: default_heartbeat_pattern(),
            receiver_latitude: None,
            receiver_longitude: None,
            receiver_altitude: None,
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

        // Validate MQTT settings only when the MQTT forwarder is configured,
        // mirroring the Pulsar rule above: an unused backend must never block
        // startup of a deployment that does not use it.
        if self.forwarders.contains(&ForwarderKind::Mqtt) {
            if self.mqtt_broker.trim().is_empty() {
                return Err(ClientError::Config("mqtt_broker cannot be empty".into()));
            }

            if self.mqtt_topic.trim().is_empty() {
                return Err(ClientError::Config("mqtt_topic cannot be empty".into()));
            }

            if self.mqtt_qos > 2 {
                return Err(ClientError::Config("mqtt_qos must be 0, 1 or 2".into()));
            }
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

    /// Loads configuration with full layering: defaults < TOML < env < flags.
    ///
    /// The subtlety this exists to handle: clap cannot distinguish "the user
    /// passed `--socket-port 30003`" from "the default is 30003". Applying the
    /// file first and letting clap overwrite everything would mean a clap
    /// *default* silently clobbering a value the operator wrote in the file, so
    /// the file is applied only to fields whose value came from a default.
    /// `ArgMatches::value_source` is the only way to know which those are.
    #[cfg(feature = "cli")]
    pub fn load() -> Result<Self> {
        use clap::parser::ValueSource;
        use clap::{CommandFactory, Parser};

        let matches = <Self as CommandFactory>::command().get_matches();
        let mut cfg = Self::parse();

        let path = cfg.config.clone();
        if !path.exists() {
            return Ok(cfg);
        }

        let text = std::fs::read_to_string(&path)
            .map_err(|e| ClientError::Config(format!("reading {}: {e}", path.display())))?;
        let from_file: toml::Value = toml::from_str(&text)
            .map_err(|e| ClientError::Config(format!("parsing {}: {e}", path.display())))?;

        cfg.overlay_file(&from_file, &|id| {
            matches.value_source(id) == Some(ValueSource::DefaultValue)
        });
        Ok(cfg)
    }

    /// Applies file values to fields the caller reports as still-defaulted.
    ///
    /// Split out from [`Self::load`] so precedence is testable without a real
    /// `argv`. A file value of the wrong type is ignored rather than fatal: a
    /// typo in one key must not stop an edge node from booting.
    #[cfg(feature = "cli")]
    pub fn overlay_file(&mut self, file: &toml::Value, is_defaulted: &dyn Fn(&str) -> bool) {
        macro_rules! overlay {
            ($id:literal, $field:ident, $conv:expr) => {
                if is_defaulted($id)
                    && let Some(v) = file.get($id)
                    && let Some(parsed) = $conv(v)
                {
                    self.$field = parsed;
                }
            };
        }

        let as_string = |v: &toml::Value| v.as_str().map(String::from);

        overlay!("source_id", source_id, as_string);
        overlay!("socket_host", socket_host, as_string);
        overlay!("socket_port", socket_port, |v: &toml::Value| v
            .as_integer()
            .map(|i| i as u16));
        overlay!("connection_mode", connection_mode, as_string);
        overlay!("pulsar_broker", pulsar_broker, as_string);
        overlay!("pulsar_topic", pulsar_topic, as_string);
        overlay!("mqtt_broker", mqtt_broker, as_string);
        overlay!("mqtt_port", mqtt_port, |v: &toml::Value| v
            .as_integer()
            .map(|i| i as u16));
        overlay!("mqtt_topic", mqtt_topic, as_string);
        overlay!("mqtt_client_id", mqtt_client_id, as_string);
        overlay!("mqtt_qos", mqtt_qos, |v: &toml::Value| v
            .as_integer()
            .map(|i| i as u8));
        overlay!("file_path", file_path, as_string);
        overlay!("dump1090_tz", dump1090_tz, as_string);
        overlay!("log_level", log_level, as_string);
        overlay!("log_sample_rate", log_sample_rate, |v: &toml::Value| v
            .as_integer()
            .map(|i| i as u64));
        overlay!(
            "socket_read_timeout_secs",
            socket_read_timeout_secs,
            |v: &toml::Value| v.as_integer().map(|i| i as u64)
        );
        overlay!(
            "heartbeat_timeout_secs",
            heartbeat_timeout_secs,
            |v: &toml::Value| v.as_integer().map(|i| i as u64)
        );

        // Receiver location is `arg(skip)`: file-only, with no flag or env
        // fallback, so the file is the ONLY way to set it.
        //
        // These deliberately do NOT consult `is_defaulted`. clap's
        // `ArgMatches::value_source` *panics* on an id it does not know --
        // `"receiver_latitude" is not an id of an argument or a group` -- and a
        // skipped field is not in `ArgMatches` at all. Asking the question
        // crashes the process on any config file that sets a receiver location.
        // There is nothing to ask anyway: no flag could have set them.
        //
        // Accept an integer as well as a float: TOML distinguishes 20 from
        // 20.0, and a hand-written config may reasonably use either.
        let as_f64 = |v: &toml::Value| v.as_float().or_else(|| v.as_integer().map(|i| i as f64));
        if let Some(v) = file.get("receiver_latitude").and_then(as_f64) {
            self.receiver_latitude = Some(v);
        }
        if let Some(v) = file.get("receiver_longitude").and_then(as_f64) {
            self.receiver_longitude = Some(v);
        }
        if let Some(v) = file.get("receiver_altitude").and_then(as_f64) {
            self.receiver_altitude = Some(v);
        }

        // `forwarders` decides whether this node is a no-Pulsar deployment, so
        // it has to survive coming from the file. Unparseable entries are
        // dropped rather than defaulting the whole list, and an entirely
        // unusable list leaves the existing value alone.
        if is_defaulted("forwarders")
            && let Some(list) = file.get("forwarders").and_then(|v| v.as_array())
        {
            let parsed: Vec<ForwarderKind> = list
                .iter()
                .filter_map(|v| v.as_str())
                .filter_map(|s| s.parse().ok())
                .collect();
            if !parsed.is_empty() {
                self.forwarders = parsed;
            }
        }
    }

    /// Liveness thresholds appropriate to the configured source.
    ///
    /// The two sources have no comparable timeout, so this must follow
    /// `source_kind` rather than always deriving from the socket read timeout.
    pub fn liveness_policy(&self) -> crate::source::LivenessPolicy {
        match self.source_kind {
            SourceKind::Socket => {
                crate::source::LivenessPolicy::for_socket(self.socket_read_timeout_secs)
            }
            SourceKind::Mqtt => {
                crate::source::LivenessPolicy::for_mqtt(self.heartbeat_timeout_secs)
            }
        }
    }

    /// Effective MQTT client id, falling back to `source_id` when unset.
    pub fn mqtt_client_id(&self) -> &str {
        if self.mqtt_client_id.trim().is_empty() {
            &self.source_id
        } else {
            &self.mqtt_client_id
        }
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

    /// Gets heartbeat timeout as an optional [`Duration`].
    ///
    /// Returns `None` when `heartbeat_timeout_secs` is 0 (disabled).
    pub fn heartbeat_timeout(&self) -> Option<Duration> {
        if self.heartbeat_timeout_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(self.heartbeat_timeout_secs))
        }
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
        assert_eq!(
            original.heartbeat_timeout_secs,
            deserialized.heartbeat_timeout_secs
        );
        assert_eq!(original.heartbeat_pattern, deserialized.heartbeat_pattern);
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
    fn test_heartbeat_timeout_defaults() {
        let config = Config::default();
        assert_eq!(config.heartbeat_timeout_secs, 90);
        assert_eq!(config.heartbeat_pattern, ",000000,");
    }

    #[test]
    fn test_heartbeat_timeout_zero_is_none() {
        let mut config = Config::default();
        config.heartbeat_timeout_secs = 0;
        assert_eq!(config.heartbeat_timeout(), None);
    }

    #[test]
    fn test_heartbeat_timeout_nonzero() {
        let mut config = Config::default();
        config.heartbeat_timeout_secs = 90;
        assert_eq!(config.heartbeat_timeout(), Some(Duration::from_secs(90)));
    }

    #[test]
    fn test_heartbeat_config_deserializes_default_when_missing() {
        let json = serde_json::json!({ "source_id": "test" });
        let config: Config = serde_json::from_value(json).unwrap();
        assert_eq!(config.heartbeat_timeout_secs, 90);
        assert_eq!(config.heartbeat_pattern, ",000000,");
    }

    #[test]
    fn test_receiver_location_defaults_to_none() {
        let config = Config::default();
        assert_eq!(config.receiver_latitude, None);
        assert_eq!(config.receiver_longitude, None);
        assert_eq!(config.receiver_altitude, None);
    }

    #[test]
    fn test_receiver_location_serde_roundtrip() {
        let config = Config {
            receiver_latitude: Some(45.5),
            receiver_longitude: Some(-73.6),
            receiver_altitude: Some(100.0),
            ..Config::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let deserialized: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.receiver_latitude, Some(45.5));
        assert_eq!(deserialized.receiver_longitude, Some(-73.6));
        assert_eq!(deserialized.receiver_altitude, Some(100.0));
    }

    #[test]
    fn test_receiver_location_deserializes_none_when_missing() {
        let json = serde_json::json!({ "source_id": "test" });
        let config: Config = serde_json::from_value(json).unwrap();
        assert_eq!(config.receiver_latitude, None);
        assert_eq!(config.receiver_longitude, None);
        assert_eq!(config.receiver_altitude, None);
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

    // --- MQTT forwarder configuration (Phase 1) ---

    #[test]
    fn test_forwarder_kind_mqtt_from_str() {
        assert_eq!(
            "mqtt".parse::<ForwarderKind>().unwrap(),
            ForwarderKind::Mqtt
        );
        assert_eq!(
            "MQTT".parse::<ForwarderKind>().unwrap(),
            ForwarderKind::Mqtt
        );
    }

    #[test]
    fn test_forwarder_kind_mqtt_display_roundtrip() {
        let kind = ForwarderKind::Mqtt;
        assert_eq!(kind.to_string(), "mqtt");
        assert_eq!(kind.to_string().parse::<ForwarderKind>().unwrap(), kind);
    }

    #[test]
    fn test_unknown_forwarder_error_lists_mqtt() {
        let err = "carrier-pigeon".parse::<ForwarderKind>().unwrap_err();
        assert!(err.contains("mqtt"), "error should list mqtt: {}", err);
    }

    #[test]
    fn test_mqtt_defaults() {
        let config = Config::default();
        assert_eq!(config.mqtt_broker, "localhost");
        assert_eq!(config.mqtt_port, 1883);
        assert_eq!(config.mqtt_topic, "adsb/sbs/raw");
        assert_eq!(config.mqtt_qos, 0);
        // Client id defaults to empty, meaning "derive from source_id".
        assert_eq!(config.mqtt_client_id, "");
    }

    #[test]
    fn test_mqtt_client_id_falls_back_to_source_id() {
        let config = Config {
            source_id: "pi-roof".to_string(),
            ..Config::default()
        };
        assert_eq!(config.mqtt_client_id(), "pi-roof");
    }

    #[test]
    fn test_mqtt_client_id_explicit_wins() {
        let config = Config {
            source_id: "pi-roof".to_string(),
            mqtt_client_id: "custom-id".to_string(),
            ..Config::default()
        };
        assert_eq!(config.mqtt_client_id(), "custom-id");
    }

    #[test]
    fn test_mqtt_deserializes_default_when_missing() {
        // Configs written before MQTT existed must still load.
        let json = serde_json::json!({ "source_id": "test" });
        let config: Config = serde_json::from_value(json).unwrap();
        assert_eq!(config.mqtt_broker, "localhost");
        assert_eq!(config.mqtt_port, 1883);
        assert_eq!(config.mqtt_topic, "adsb/sbs/raw");
    }

    #[test]
    fn test_mqtt_only_config_is_valid() {
        // A no-Pulsar deployment must validate even with a nonsense broker URL,
        // because the Pulsar forwarder is not selected.
        let config = Config {
            forwarders: vec![ForwarderKind::Mqtt],
            pulsar_broker: "not-a-pulsar-url".to_string(),
            ..Config::default()
        };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_rejects_empty_mqtt_topic_when_selected() {
        let config = Config {
            forwarders: vec![ForwarderKind::Mqtt],
            mqtt_topic: "  ".to_string(),
            ..Config::default()
        };
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("mqtt_topic"), "got: {}", err);
    }

    #[test]
    fn test_validate_ignores_empty_mqtt_topic_when_not_selected() {
        let config = Config {
            forwarders: vec![ForwarderKind::Pulsar],
            mqtt_topic: String::new(),
            ..Config::default()
        };
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_rejects_empty_mqtt_broker_when_selected() {
        let config = Config {
            forwarders: vec![ForwarderKind::Mqtt],
            mqtt_broker: String::new(),
            ..Config::default()
        };
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("mqtt_broker"), "got: {}", err);
    }

    #[test]
    fn test_validate_rejects_out_of_range_qos() {
        let config = Config {
            forwarders: vec![ForwarderKind::Mqtt],
            mqtt_qos: 3,
            ..Config::default()
        };
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("mqtt_qos"), "got: {}", err);
    }
}

#[cfg(all(test, feature = "cli"))]
mod layering_tests {
    use super::*;
    use clap::Parser;

    fn defaults() -> Config {
        Config::parse_from(["adsb-pulsar-client"])
    }

    fn file(text: &str) -> toml::Value {
        toml::from_str(text).unwrap()
    }

    fn all_defaulted(_: &str) -> bool {
        true
    }

    fn explicit(names: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |id: &str| !names.contains(&id)
    }

    #[test]
    fn file_overrides_defaults() {
        let mut cfg = defaults();
        assert_eq!(cfg.socket_port, 30003);
        cfg.overlay_file(&file("socket_port = 30005"), &all_defaulted);
        assert_eq!(cfg.socket_port, 30005);
    }

    #[test]
    fn explicit_flag_beats_the_file() {
        let mut cfg = Config::parse_from(["adsb-pulsar-client", "--socket-port", "30009"]);
        cfg.overlay_file(&file("socket_port = 30005"), &explicit(&["socket_port"]));
        assert_eq!(cfg.socket_port, 30009);
    }

    #[test]
    fn a_clap_default_does_not_clobber_a_file_value() {
        let mut cfg = defaults();
        cfg.overlay_file(
            &file("source_id = 'pi-roof'\nmqtt_broker = 'broker.lan'"),
            &all_defaulted,
        );
        assert_eq!(cfg.source_id, "pi-roof");
        assert_eq!(cfg.mqtt_broker, "broker.lan");
    }

    #[test]
    fn forwarders_list_layers_from_the_file() {
        // The setting that decides whether a node is a no-Pulsar deployment,
        // so it must survive coming from the config file.
        let mut cfg = defaults();
        assert_eq!(cfg.forwarders, vec![ForwarderKind::Pulsar]);
        cfg.overlay_file(&file("forwarders = ['mqtt']"), &all_defaulted);
        assert_eq!(cfg.forwarders, vec![ForwarderKind::Mqtt]);
    }

    #[test]
    fn multiple_forwarders_layer_from_the_file() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("forwarders = ['pulsar', 'mqtt']"), &all_defaulted);
        assert_eq!(
            cfg.forwarders,
            vec![ForwarderKind::Pulsar, ForwarderKind::Mqtt]
        );
    }

    #[test]
    fn an_unknown_forwarder_in_the_file_is_ignored_not_fatal() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("forwarders = ['carrier-pigeon']"), &all_defaulted);
        assert_eq!(cfg.forwarders, vec![ForwarderKind::Pulsar]);
    }

    #[test]
    fn wrong_typed_file_value_is_ignored_not_fatal() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("socket_port = 'not-a-number'"), &all_defaulted);
        assert_eq!(cfg.socket_port, 30003);
    }

    #[test]
    fn receiver_location_layers_from_the_file() {
        // These are `arg(skip)` -- file-only, unreachable from any flag or env
        // var -- so if overlay_file ignores them there is no other way to set
        // them, and the omission is silent: the client starts happily with no
        // receiver location at all.
        let mut cfg = defaults();
        assert_eq!(cfg.receiver_latitude, None);
        cfg.overlay_file(
            &file("receiver_latitude = 46.717915\nreceiver_longitude = -2.33716964\nreceiver_altitude = 20.0"),
            &all_defaulted,
        );
        assert_eq!(cfg.receiver_latitude, Some(46.717915));
        assert_eq!(cfg.receiver_longitude, Some(-2.33716964));
        assert_eq!(cfg.receiver_altitude, Some(20.0));
    }

    /// Every `arg(skip)` field: present in `Config`, absent from `ArgMatches`.
    const SKIPPED: [&str; 3] = [
        "receiver_latitude",
        "receiver_longitude",
        "receiver_altitude",
    ];

    /// Mimics clap: `ArgMatches::value_source` panics for an id that is not a
    /// real argument, which is exactly what a skipped field is.
    fn clap_like(id: &str) -> bool {
        assert!(
            !SKIPPED.contains(&id),
            "`{id}` is not an id of an argument or a group -- clap would panic here"
        );
        true
    }

    #[test]
    fn skipped_fields_are_never_asked_about() {
        // Regression: consulting is_defaulted for an arg(skip) field crashed
        // the client (exit 101) on any config carrying a receiver location.
        // The bug survived a unit test because the test double answered every
        // id happily, where the real clap predicate panics.
        let mut cfg = defaults();
        cfg.overlay_file(
            &file("receiver_latitude = 46.7\nsource_id = 'x'"),
            &clap_like,
        );
        assert_eq!(cfg.receiver_latitude, Some(46.7));
        assert_eq!(cfg.source_id, "x");
    }

    #[test]
    fn an_integer_receiver_coordinate_is_accepted() {
        // TOML distinguishes 20 from 20.0; a hand-written config may use either.
        let mut cfg = defaults();
        cfg.overlay_file(&file("receiver_altitude = 20"), &all_defaulted);
        assert_eq!(cfg.receiver_altitude, Some(20.0));
    }

    #[test]
    fn absent_file_keys_leave_defaults_intact() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("socket_port = 30005"), &all_defaulted);
        assert_eq!(cfg.source_id, "kraspberryPi");
        assert_eq!(cfg.mqtt_topic, "adsb/sbs/raw");
    }
}

#[cfg(test)]
mod source_kind_tests {
    use super::*;

    #[test]
    fn source_kind_parses_both_spellings() {
        assert_eq!("socket".parse::<SourceKind>().unwrap(), SourceKind::Socket);
        assert_eq!("MQTT".parse::<SourceKind>().unwrap(), SourceKind::Mqtt);
    }

    #[test]
    fn source_kind_display_roundtrips() {
        for k in [SourceKind::Socket, SourceKind::Mqtt] {
            assert_eq!(k.to_string().parse::<SourceKind>().unwrap(), k);
        }
    }

    #[test]
    fn unknown_source_kind_is_an_error_that_lists_the_options() {
        let e = "carrier-pigeon".parse::<SourceKind>().unwrap_err();
        assert!(e.contains("socket") && e.contains("mqtt"), "got: {e}");
    }

    #[test]
    fn default_source_is_the_direct_socket() {
        // Existing installs must keep connecting straight to dump1090.
        assert_eq!(Config::default().source_kind, SourceKind::Socket);
    }

    #[test]
    fn source_kind_deserializes_default_when_missing() {
        // Configs written before MQTT input existed must still load.
        let json = serde_json::json!({ "source_id": "test" });
        let cfg: Config = serde_json::from_value(json).unwrap();
        assert_eq!(cfg.source_kind, SourceKind::Socket);
    }

    #[test]
    fn liveness_policy_follows_the_selected_source() {
        let socket = Config::default();
        let mqtt = Config {
            source_kind: SourceKind::Mqtt,
            ..Config::default()
        };
        assert_ne!(socket.liveness_policy(), mqtt.liveness_policy());
        assert_eq!(
            socket.liveness_policy(),
            crate::source::LivenessPolicy::for_socket(socket.socket_read_timeout_secs)
        );
        assert_eq!(
            mqtt.liveness_policy(),
            crate::source::LivenessPolicy::for_mqtt(mqtt.heartbeat_timeout_secs)
        );
    }
}
