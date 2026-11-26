//! Layered configuration: defaults < TOML file < environment < CLI flags,
//! as in the weather service.
//!
//! Credentials come from `--client-id` / `--client-secret` (env
//! `ADSB_OPENSKY_CLIENT_ID` / `ADSB_OPENSKY_CLIENT_SECRET`) or from OpenSky's
//! downloaded `credentials.json` (`--credentials-file`). The secret is never
//! serialised: `--print-config` leaves it out, and clap never echoes its
//! environment value in `--help`.

use adsb_opensky_server::api::DEFAULT_HTTP_PORT;
use adsb_opensky_server::auth::{Credentials, DEFAULT_TOKEN_URL};
use adsb_opensky_server::budget::{
    ANONYMOUS_DAILY_CREDITS, ANONYMOUS_RESOLUTION, AUTHENTICATED_RESOLUTION, DEFAULT_DAILY_CREDITS,
    FEEDER_DAILY_CREDITS,
};
use adsb_opensky_server::provider::DEFAULT_API_URL;
use adsb_opensky_server::watch::WatchLimits;
use anyhow::{Context, bail};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Parser, Serialize, Deserialize)]
#[command(
    name = "adsb-opensky-server",
    about = "Polls OpenSky for selected aircraft and areas and publishes them over MQTT",
    version
)]
pub struct OpenSkyConfig {
    /// Path to a TOML config file.
    #[arg(
        long,
        env = "ADSB_OPENSKY_CONFIG",
        default_value = "/etc/adsb/opensky.toml"
    )]
    #[serde(skip)]
    pub config: PathBuf,

    /// Print the effective configuration (without the secret) and exit.
    #[arg(long)]
    #[serde(skip)]
    pub print_config: bool,

    /// Receiver identity. The MQTT client id is `<source_id>-opensky`.
    #[arg(long, env = "ADSB_SOURCE_ID", default_value = "adsb-edge")]
    #[serde(default = "default_source_id")]
    pub source_id: String,

    #[arg(long, env = "ADSB_MQTT_BROKER", default_value = "localhost")]
    #[serde(default = "default_mqtt_broker")]
    pub mqtt_broker: String,

    #[arg(long, env = "ADSB_MQTT_PORT", default_value = "1883")]
    #[serde(default = "default_mqtt_port")]
    pub mqtt_port: u16,

    /// Topic each poll is published to; status and availability are siblings.
    #[arg(
        long,
        env = "ADSB_MQTT_OPENSKY_TOPIC",
        default_value = "adsb/opensky/states"
    )]
    #[serde(default = "default_mqtt_topic")]
    pub mqtt_topic: String,

    /// OpenSky API client id (account page → API client).
    #[arg(long, env = "ADSB_OPENSKY_CLIENT_ID")]
    #[serde(default)]
    pub client_id: Option<String>,

    /// OpenSky API client secret. Never printed.
    #[arg(long, env = "ADSB_OPENSKY_CLIENT_SECRET", hide_env_values = true)]
    #[serde(default, skip_serializing)]
    pub client_secret: Option<String>,

    /// OpenSky's downloaded `credentials.json`, instead of the two above.
    #[arg(long, env = "ADSB_OPENSKY_CREDENTIALS_FILE")]
    #[serde(default)]
    pub credentials_file: Option<PathBuf>,

    /// The account feeds OpenSky (an active feeder, >= 30% uptime): its
    /// allowance is 8000 credits a day rather than a registered user's 4000.
    /// OpenSky's replies say what is left, never the allowance, so it is set
    /// here. On by default.
    #[arg(long, env = "ADSB_OPENSKY_FEEDER", default_value_t = true, action = clap::ArgAction::Set)]
    #[serde(default = "default_feeder")]
    pub feeder: bool,

    /// Daily credits to budget against, when neither 4000 nor 8000 fits:
    /// overrides `feeder`. Anonymous access is capped at 400 whatever is set.
    #[arg(long, env = "ADSB_OPENSKY_DAILY_CREDITS")]
    #[serde(default)]
    pub daily_credits: Option<u32>,

    /// Never poll more often than this, seconds.
    #[arg(long, env = "ADSB_OPENSKY_MIN_INTERVAL_S", default_value = "10")]
    #[serde(default = "default_min_interval_s")]
    pub min_interval_s: u64,

    /// A watch list lapses this long after it was last renewed, seconds.
    #[arg(long, env = "ADSB_OPENSKY_LEASE_SECONDS", default_value = "60")]
    #[serde(default = "default_lease_seconds")]
    pub lease_seconds: u64,

    #[arg(long, env = "ADSB_OPENSKY_MAX_ICAO", default_value = "20")]
    #[serde(default = "default_max_icao")]
    pub max_icao: usize,

    #[arg(long, env = "ADSB_OPENSKY_MAX_AREAS", default_value = "4")]
    #[serde(default = "default_max_areas")]
    pub max_areas: usize,

    /// Largest area accepted, square degrees (100 costs 2 credits a poll).
    #[arg(long, env = "ADSB_OPENSKY_MAX_AREA_SQ_DEG", default_value = "100")]
    #[serde(default = "default_max_area_sq_deg")]
    pub max_area_sq_deg: f64,

    #[arg(long, env = "ADSB_OPENSKY_API_URL", default_value = DEFAULT_API_URL)]
    #[serde(default = "default_api_url")]
    pub api_url: String,

    #[arg(long, env = "ADSB_OPENSKY_TOKEN_URL", default_value = DEFAULT_TOKEN_URL)]
    #[serde(default = "default_token_url")]
    pub token_url: String,

    /// Control API port. 0 disables it -- and with it any way to watch
    /// anything, so the service then only idles.
    #[arg(long, env = "ADSB_OPENSKY_HTTP_PORT", default_value = "8791")]
    #[serde(default = "default_http_port")]
    pub http_port: u16,

    /// Loopback by default: the API has no authentication.
    #[arg(long, env = "ADSB_OPENSKY_HTTP_BIND", default_value = "127.0.0.1")]
    #[serde(default = "default_http_bind")]
    pub http_bind: String,

    /// Where the credit ledger survives restarts. Unset keeps it in memory.
    #[arg(long, env = "ADSB_OPENSKY_STATE_PATH")]
    #[serde(default)]
    pub state_path: Option<PathBuf>,

    #[arg(long, env = "ADSB_LOG_LEVEL", default_value = "info")]
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

fn default_source_id() -> String {
    "adsb-edge".into()
}
fn default_mqtt_broker() -> String {
    "localhost".into()
}
fn default_mqtt_port() -> u16 {
    1883
}
fn default_mqtt_topic() -> String {
    "adsb/opensky/states".into()
}
fn default_feeder() -> bool {
    true
}
fn default_min_interval_s() -> u64 {
    10
}
fn default_lease_seconds() -> u64 {
    60
}
fn default_max_icao() -> usize {
    20
}
fn default_max_areas() -> usize {
    4
}
fn default_max_area_sq_deg() -> f64 {
    100.0
}
fn default_api_url() -> String {
    DEFAULT_API_URL.into()
}
fn default_token_url() -> String {
    DEFAULT_TOKEN_URL.into()
}
fn default_http_port() -> u16 {
    DEFAULT_HTTP_PORT
}
fn default_http_bind() -> String {
    "127.0.0.1".into()
}
fn default_log_level() -> String {
    "info".into()
}

impl OpenSkyConfig {
    pub fn load() -> anyhow::Result<Self> {
        use clap::parser::ValueSource;
        let matches = <Self as clap::CommandFactory>::command().get_matches();
        let mut cfg = Self::parse();
        let path = cfg.config.clone();
        if !path.exists() {
            return Ok(cfg);
        }
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let file: toml::Value =
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        cfg.overlay_file(&file, &|id| {
            matches!(
                matches.value_source(id),
                None | Some(ValueSource::DefaultValue)
            )
        });
        Ok(cfg)
    }

    /// Applies file values to fields no flag or environment variable set.
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
        let string = |v: &toml::Value| v.as_str().map(String::from);
        // An empty string in the file means "not set", as the template has it.
        let opt_string = |v: &toml::Value| {
            v.as_str()
                .map(|s| (!s.trim().is_empty()).then(|| s.to_string()))
        };
        let opt_path = |v: &toml::Value| {
            v.as_str()
                .map(|s| (!s.trim().is_empty()).then(|| PathBuf::from(s)))
        };
        let uint = |v: &toml::Value| v.as_integer().filter(|i| *i >= 0);
        let float = |v: &toml::Value| v.as_float().or_else(|| v.as_integer().map(|i| i as f64));

        overlay!("source_id", source_id, string);
        overlay!("mqtt_broker", mqtt_broker, string);
        overlay!("mqtt_port", mqtt_port, |v| uint(v)
            .and_then(|i| u16::try_from(i).ok()));
        overlay!("mqtt_topic", mqtt_topic, string);
        overlay!("client_id", client_id, opt_string);
        overlay!("client_secret", client_secret, opt_string);
        overlay!("credentials_file", credentials_file, opt_path);
        overlay!("feeder", feeder, |v: &toml::Value| v.as_bool());
        overlay!("daily_credits", daily_credits, |v| uint(v)
            .and_then(|i| u32::try_from(i).ok())
            .map(Some));
        overlay!("min_interval_s", min_interval_s, |v| uint(v)
            .map(|i| i as u64));
        overlay!("lease_seconds", lease_seconds, |v| uint(v)
            .map(|i| i as u64));
        overlay!("max_icao", max_icao, |v| uint(v).map(|i| i as usize));
        overlay!("max_areas", max_areas, |v| uint(v).map(|i| i as usize));
        overlay!("max_area_sq_deg", max_area_sq_deg, float);
        overlay!("api_url", api_url, string);
        overlay!("token_url", token_url, string);
        overlay!("http_port", http_port, |v| uint(v)
            .and_then(|i| u16::try_from(i).ok()));
        overlay!("http_bind", http_bind, string);
        overlay!("state_path", state_path, opt_path);
        overlay!("log_level", log_level, string);
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        if self.daily_credits == Some(0) {
            bail!("daily_credits must be at least 1");
        }
        if self.lease_seconds < 10 {
            bail!("lease_seconds must be at least 10: clients renew every 20 s at most");
        }
        if self.max_icao == 0 && self.max_areas == 0 {
            bail!("max_icao and max_areas are both 0: nothing could ever be watched");
        }
        if self.max_area_sq_deg.is_nan() || self.max_area_sq_deg <= 0.0 {
            bail!("max_area_sq_deg must be positive");
        }
        self.http_bind_addr()?;
        self.credentials()?;
        Ok(())
    }

    pub fn http_bind_addr(&self) -> anyhow::Result<IpAddr> {
        self.http_bind.parse().with_context(|| {
            format!(
                "http_bind '{}' must be an IP address, e.g. 127.0.0.1 or 0.0.0.0",
                self.http_bind
            )
        })
    }

    /// The credentials, if any: the file wins when both are given.
    pub fn credentials(&self) -> anyhow::Result<Option<Credentials>> {
        if let Some(path) = &self.credentials_file {
            return Ok(Some(Credentials::from_file(path)?));
        }
        Ok(Credentials::from_parts(
            self.client_id.clone(),
            self.client_secret.clone(),
        )?)
    }

    /// The daily allowance, capped for anonymous access.
    pub fn effective_daily_credits(&self, authenticated: bool) -> u32 {
        let account = self.daily_credits.unwrap_or(if self.feeder {
            FEEDER_DAILY_CREDITS
        } else {
            DEFAULT_DAILY_CREDITS
        });
        if authenticated {
            account
        } else {
            account.min(ANONYMOUS_DAILY_CREDITS)
        }
    }

    /// The minimum interval, never under OpenSky's own time resolution.
    pub fn effective_min_interval(&self, authenticated: bool) -> Duration {
        let resolution = if authenticated {
            AUTHENTICATED_RESOLUTION
        } else {
            ANONYMOUS_RESOLUTION
        };
        Duration::from_secs(self.min_interval_s).max(resolution)
    }

    pub fn limits(&self) -> WatchLimits {
        WatchLimits {
            max_icao: self.max_icao,
            max_areas: self.max_areas,
            max_area_sq_deg: self.max_area_sq_deg,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> OpenSkyConfig {
        OpenSkyConfig::parse_from(["adsb-opensky-server"])
    }

    fn file(text: &str) -> toml::Value {
        toml::from_str(text).unwrap()
    }

    #[test]
    fn defaults_are_valid_and_anonymous() {
        let cfg = defaults();
        cfg.validate().unwrap();
        assert!(cfg.credentials().unwrap().is_none());
        assert_eq!(cfg.http_port, DEFAULT_HTTP_PORT);
        assert!(cfg.http_bind_addr().unwrap().is_loopback());
    }

    #[test]
    fn the_secret_is_never_printed() {
        let cfg = OpenSkyConfig {
            client_id: Some("me-api-client".into()),
            client_secret: Some("s3cr3t".into()),
            ..defaults()
        };
        let printed = toml::to_string_pretty(&cfg).unwrap();
        assert!(printed.contains("me-api-client"));
        assert!(!printed.contains("s3cr3t"), "{printed}");
        assert!(!printed.contains("client_secret"), "{printed}");
    }

    #[test]
    fn credentials_come_from_flags() {
        let cfg = OpenSkyConfig::parse_from([
            "adsb-opensky-server",
            "--client-id",
            "me",
            "--client-secret",
            "x",
        ]);
        let c = cfg.credentials().unwrap().unwrap();
        assert_eq!(
            (c.client_id.as_str(), c.client_secret.as_str()),
            ("me", "x")
        );
    }

    #[test]
    fn an_id_without_a_secret_is_an_error_not_anonymous() {
        let cfg = OpenSkyConfig {
            client_id: Some("me".into()),
            ..defaults()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn the_credentials_file_wins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        std::fs::write(&path, r#"{"clientId":"from-file","clientSecret":"y"}"#).unwrap();
        let cfg = OpenSkyConfig {
            client_id: Some("from-flag".into()),
            client_secret: Some("x".into()),
            credentials_file: Some(path),
            ..defaults()
        };
        assert_eq!(cfg.credentials().unwrap().unwrap().client_id, "from-file");
    }

    #[test]
    fn empty_strings_in_the_file_mean_unset() {
        let mut cfg = defaults();
        cfg.overlay_file(
            &file("client_id = ''\nclient_secret = ''\ncredentials_file = ''"),
            &|_| true,
        );
        assert_eq!(cfg.client_id, None);
        assert_eq!(cfg.credentials_file, None);
        assert!(cfg.credentials().unwrap().is_none());
    }

    #[test]
    fn settings_layer_from_the_file_unless_set_explicitly() {
        let mut cfg = OpenSkyConfig::parse_from(["adsb-opensky-server", "--daily-credits", "8000"]);
        cfg.overlay_file(
            &file(
                "daily_credits = 4000\nmqtt_topic = 'adsb/dev/opensky/states'\n\
                 state_path = '.run/opensky-state.json'\nmax_area_sq_deg = 25",
            ),
            &|id| id != "daily_credits",
        );
        assert_eq!(cfg.daily_credits, Some(8_000));
        assert_eq!(cfg.mqtt_topic, "adsb/dev/opensky/states");
        assert_eq!(
            cfg.state_path,
            Some(PathBuf::from(".run/opensky-state.json"))
        );
        assert_eq!(cfg.max_area_sq_deg, 25.0);
    }

    #[test]
    fn a_feeder_by_default_budgets_8000_credits() {
        let cfg = defaults();
        assert!(cfg.feeder);
        assert_eq!(cfg.daily_credits, None);
        assert_eq!(cfg.effective_daily_credits(true), 8_000);
    }

    #[test]
    fn a_registered_user_who_does_not_feed_budgets_4000() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("feeder = false"), &|_| true);
        assert!(!cfg.feeder);
        assert_eq!(cfg.effective_daily_credits(true), 4_000);
    }

    #[test]
    fn an_explicit_daily_credits_overrides_the_feeder_flag() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("feeder = true\ndaily_credits = 6000"), &|_| true);
        assert_eq!(cfg.effective_daily_credits(true), 6_000);
        let cfg = OpenSkyConfig::parse_from(["adsb-opensky-server", "--feeder", "false"]);
        assert!(!cfg.feeder);
    }

    #[test]
    fn zero_daily_credits_is_an_error() {
        let cfg = OpenSkyConfig {
            daily_credits: Some(0),
            ..defaults()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn anonymous_access_is_capped_at_400_credits_and_10_seconds() {
        let cfg = OpenSkyConfig {
            min_interval_s: 1,
            ..defaults()
        };
        assert_eq!(cfg.effective_daily_credits(false), 400);
        assert_eq!(cfg.effective_daily_credits(true), 8_000);
        assert_eq!(cfg.effective_min_interval(false), Duration::from_secs(10));
        assert_eq!(cfg.effective_min_interval(true), Duration::from_secs(5));
    }

    #[test]
    fn a_short_lease_is_an_error() {
        let cfg = OpenSkyConfig {
            lease_seconds: 5,
            ..defaults()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn an_http_bind_that_is_not_an_address_is_an_error() {
        let cfg = OpenSkyConfig {
            http_bind: "localhost".into(),
            ..defaults()
        };
        assert!(cfg.validate().is_err());
    }
}
