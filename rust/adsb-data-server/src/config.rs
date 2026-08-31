//! Layered configuration: defaults < TOML file < environment < CLI flags.

use adsb_data_engine::{ShareConfig, StorageConfig};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Runtime configuration for the recorder daemon.
///
/// Every field is settable four ways, in increasing precedence: the `Default`
/// impl, a TOML file, an environment variable, an explicit CLI flag.
#[derive(Debug, Clone, Parser, Serialize, Deserialize)]
#[command(
    name = "adsb-data-server",
    about = "Headless ADS-B recorder: MQTT ingest to DuckDB, with Quack sharing",
    version
)]
pub struct ServerConfig {
    /// Path to a TOML config file. Not itself settable from the file.
    #[arg(
        long,
        env = "ADSB_SERVER_CONFIG",
        default_value = "/etc/adsb/data-server.toml"
    )]
    #[serde(skip)]
    pub config: PathBuf,

    /// Print the effective configuration as TOML and exit.
    ///
    /// With four layers in play (defaults, file, environment, flags), "what did
    /// this node actually load?" is otherwise unanswerable on a running daemon.
    #[arg(long, help = "Print the effective configuration and exit")]
    #[serde(skip)]
    pub print_config: bool,

    /// Identifier for this receiver, stamped onto every stored record.
    #[arg(long, env = "ADSB_SOURCE_ID", default_value = "adsb-edge")]
    #[serde(default = "default_source_id")]
    pub source_id: String,

    /// Where the DuckDB database lives.
    #[arg(long, env = "ADSB_DB_PATH", default_value = "/var/lib/adsb/adsb.db")]
    #[serde(default = "default_db_path")]
    pub db_path: PathBuf,

    /// MQTT broker hostname or IP.
    #[arg(long, env = "ADSB_MQTT_BROKER", default_value = "localhost")]
    #[serde(default = "default_mqtt_broker")]
    pub mqtt_broker: String,

    /// MQTT broker port.
    #[arg(long, env = "ADSB_MQTT_PORT", default_value = "1883")]
    #[serde(default = "default_mqtt_port")]
    pub mqtt_port: u16,

    /// MQTT topic carrying raw SBS-1 lines.
    #[arg(long, env = "ADSB_MQTT_TOPIC", default_value = "adsb/sbs/raw")]
    #[serde(default = "default_mqtt_topic")]
    pub mqtt_topic: String,

    /// Timezone of the dump1090 timestamps.
    #[arg(long, env = "ADSB_DUMP1090_TZ", default_value = "Local")]
    #[serde(default = "default_tz")]
    pub dump1090_tz: String,

    /// Milliseconds of silence that separate one flight from the next.
    #[arg(long, env = "ADSB_GAP_THRESHOLD_MS", default_value = "3600000")]
    #[serde(default = "default_gap_threshold_ms")]
    pub gap_threshold_ms: i64,

    /// Seconds between DuckDB checkpoints. 0 disables maintenance.
    #[arg(long, env = "ADSB_CHECKPOINT_SECS", default_value = "300")]
    #[serde(default = "default_checkpoint_secs")]
    pub checkpoint_secs: u64,

    /// Discard data older than this many hours. 0 keeps everything.
    #[arg(long, env = "ADSB_RETENTION_HOURS", default_value = "0")]
    #[serde(default)]
    pub retention_hours: u64,

    /// Serve the read-only HTTP query API on this port. 0 disables it.
    #[arg(long, env = "ADSB_HTTP_PORT", default_value = "8787")]
    #[serde(default = "default_http_port")]
    pub http_port: u16,

    /// Expose the database over Quack so other processes can ATTACH.
    #[arg(long, env = "ADSB_SHARE")]
    #[serde(default)]
    pub share: bool,

    /// Quack URI to bind when sharing.
    #[arg(long, env = "ADSB_SHARE_URI", default_value = "quack:0.0.0.0:9494")]
    #[serde(default = "default_share_uri")]
    pub share_uri: String,

    /// Quack auth token. Unset lets DuckDB generate one at serve time.
    #[arg(long, env = "ADSB_SHARE_TOKEN")]
    #[serde(default)]
    pub share_token: Option<String>,

    /// Log level.
    #[arg(long, env = "ADSB_LOG_LEVEL", default_value = "info")]
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

fn default_source_id() -> String {
    "adsb-edge".into()
}
fn default_db_path() -> PathBuf {
    PathBuf::from("/var/lib/adsb/adsb.db")
}
fn default_mqtt_broker() -> String {
    "localhost".into()
}
fn default_mqtt_port() -> u16 {
    1883
}
fn default_mqtt_topic() -> String {
    "adsb/sbs/raw".into()
}
fn default_tz() -> String {
    "Local".into()
}
fn default_gap_threshold_ms() -> i64 {
    3_600_000
}
fn default_checkpoint_secs() -> u64 {
    300
}
fn default_http_port() -> u16 {
    8787
}
fn default_share_uri() -> String {
    "quack:0.0.0.0:9494".into()
}
fn default_log_level() -> String {
    "info".into()
}

impl ServerConfig {
    /// Loads configuration with full layering.
    ///
    /// The subtlety this exists to handle: clap cannot distinguish "the user
    /// passed `--mqtt-port 1883`" from "the default is 1883". Applying the TOML
    /// file first and letting clap overwrite everything would mean a clap
    /// *default* silently clobbering a value the operator wrote in the file. So
    /// the file is applied only to fields whose value came from a default —
    /// `ArgMatches::value_source` is the only way to know which those are.
    pub fn load() -> anyhow::Result<Self> {
        use clap::parser::ValueSource;

        let matches = <Self as clap::CommandFactory>::command().get_matches();
        let mut cfg = Self::parse();

        let path = cfg.config.clone();
        if !path.exists() {
            return Ok(cfg);
        }

        let from_file: toml::Value = toml::from_str(&std::fs::read_to_string(&path)?)?;
        cfg.overlay_file(&from_file, &|id| {
            matches.value_source(id) == Some(ValueSource::DefaultValue)
        });
        Ok(cfg)
    }

    /// Applies file values to fields the caller reports as still-defaulted.
    ///
    /// Split out from [`Self::load`] so precedence is testable without going
    /// through a real `argv`.
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

        overlay!("source_id", source_id, |v: &toml::Value| v
            .as_str()
            .map(String::from));
        overlay!("db_path", db_path, |v: &toml::Value| v
            .as_str()
            .map(PathBuf::from));
        overlay!("mqtt_broker", mqtt_broker, |v: &toml::Value| v
            .as_str()
            .map(String::from));
        overlay!("mqtt_port", mqtt_port, |v: &toml::Value| v
            .as_integer()
            .map(|i| i as u16));
        overlay!("mqtt_topic", mqtt_topic, |v: &toml::Value| v
            .as_str()
            .map(String::from));
        overlay!("dump1090_tz", dump1090_tz, |v: &toml::Value| v
            .as_str()
            .map(String::from));
        overlay!("gap_threshold_ms", gap_threshold_ms, |v: &toml::Value| v
            .as_integer());
        overlay!("checkpoint_secs", checkpoint_secs, |v: &toml::Value| v
            .as_integer()
            .map(|i| i as u64));
        overlay!("retention_hours", retention_hours, |v: &toml::Value| v
            .as_integer()
            .map(|i| i as u64));
        overlay!("http_port", http_port, |v: &toml::Value| v
            .as_integer()
            .map(|i| i as u16));
        overlay!("share", share, |v: &toml::Value| v.as_bool());
        overlay!("share_uri", share_uri, |v: &toml::Value| v
            .as_str()
            .map(String::from));
        overlay!("log_level", log_level, |v: &toml::Value| v
            .as_str()
            .map(String::from));

        if self.share_token.is_none()
            && let Some(t) = file.get("share_token").and_then(|v| v.as_str())
        {
            self.share_token = Some(t.to_string());
        }
    }

    /// Builds the storage configuration this daemon should open.
    pub fn storage_config(&self) -> StorageConfig {
        StorageConfig {
            db_path: Some(self.db_path.clone()),
            source_id: self.source_id.clone(),
            gap_threshold_ms: self.gap_threshold_ms,
            share: self.share.then(|| ShareConfig {
                uri: self.share_uri.clone(),
                token: self.share_token.clone(),
                // Required by DuckDB to bind anything but a local hostname.
                // The Quack server terminates no TLS of its own, so binding
                // off-host belongs behind a reverse proxy on an untrusted net.
                allow_other_hostname: true,
                auto_start: true,
            }),
            // The daemon is always the owner of its database; only the desktop
            // app attaches to someone else's.
            remote: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> ServerConfig {
        ServerConfig::parse_from(["adsb-data-server"])
    }

    fn file(text: &str) -> toml::Value {
        toml::from_str(text).unwrap()
    }

    /// Stands in for clap: every field still holds its default.
    fn all_defaulted(_: &str) -> bool {
        true
    }

    /// Stands in for clap: the named fields were given explicitly.
    fn explicit(names: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |id: &str| !names.contains(&id)
    }

    #[test]
    fn file_overrides_defaults() {
        let mut cfg = defaults();
        assert_eq!(cfg.mqtt_port, 1883);
        cfg.overlay_file(&file("mqtt_port = 1884"), &all_defaulted);
        assert_eq!(cfg.mqtt_port, 1884);
    }

    #[test]
    fn explicit_flag_beats_the_file() {
        // The whole reason overlay_file takes an is_defaulted predicate: a
        // value the operator passed must survive a file that disagrees.
        let mut cfg = ServerConfig::parse_from(["adsb-data-server", "--mqtt-port", "1999"]);
        cfg.overlay_file(&file("mqtt_port = 1884"), &explicit(&["mqtt_port"]));
        assert_eq!(cfg.mqtt_port, 1999);
    }

    #[test]
    fn a_clap_default_does_not_clobber_a_file_value() {
        // The bug this design avoids: parsing the file first and letting clap
        // overwrite everything means an untouched flag's *default* silently
        // wins over what the operator wrote in the file.
        let mut cfg = defaults();
        cfg.overlay_file(
            &file("source_id = 'pi-roof'\nmqtt_broker = 'broker.lan'"),
            &all_defaulted,
        );
        assert_eq!(cfg.source_id, "pi-roof");
        assert_eq!(cfg.mqtt_broker, "broker.lan");
    }

    #[test]
    fn absent_file_keys_leave_defaults_intact() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("mqtt_port = 1884"), &all_defaulted);
        assert_eq!(cfg.source_id, "adsb-edge", "unrelated field was disturbed");
        assert_eq!(cfg.mqtt_topic, "adsb/sbs/raw");
    }

    #[test]
    fn wrong_typed_file_value_is_ignored_not_fatal() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("mqtt_port = 'not-a-number'"), &all_defaulted);
        assert_eq!(cfg.mqtt_port, 1883);
    }

    #[test]
    fn booleans_and_tokens_layer_too() {
        let mut cfg = defaults();
        assert!(!cfg.share);
        cfg.overlay_file(
            &file("share = true\nshare_token = 'secret'"),
            &all_defaulted,
        );
        assert!(cfg.share);
        assert_eq!(cfg.share_token.as_deref(), Some("secret"));
    }

    #[test]
    fn sharing_is_off_unless_requested() {
        assert!(defaults().storage_config().share.is_none());
    }

    #[test]
    fn sharing_config_binds_off_host_when_enabled() {
        let mut cfg = defaults();
        cfg.share = true;
        let share = cfg.storage_config().share.expect("share config");
        assert!(share.auto_start);
        // DuckDB refuses to bind a non-local hostname without this.
        assert!(share.allow_other_hostname);
        assert_eq!(share.uri, "quack:0.0.0.0:9494");
    }

    #[test]
    fn storage_config_carries_identity_and_gap_threshold() {
        let cfg = defaults();
        let sc = cfg.storage_config();
        assert_eq!(sc.source_id, "adsb-edge");
        assert_eq!(sc.gap_threshold_ms, 3_600_000);
        assert!(
            sc.db_path.is_some(),
            "daemon must never run in-memory by accident"
        );
    }
}
