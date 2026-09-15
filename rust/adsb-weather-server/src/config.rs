//! Layered configuration: defaults < TOML file < environment < CLI flags.
//!
//! Mirrors `adsb-data-server`'s loader. The one difference is that the
//! receiver position has no meaningful default, so those fields are `Option`
//! and "not given anywhere" is a validation error rather than a silent 0,0.

use adsb_weather_server::GridSpec;
use adsb_weather_server::api::DEFAULT_HTTP_PORT;
use adsb_weather_server::open_meteo::DEFAULT_BASE_URL;
use anyhow::{Context, bail};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::path::PathBuf;

/// Pressure levels Open-Meteo serves, hPa.
pub const OPEN_METEO_LEVELS: [u16; 19] = [
    1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30,
];

/// Runtime configuration for the weather service.
#[derive(Debug, Clone, Parser, Serialize, Deserialize)]
#[command(
    name = "adsb-weather-server",
    about = "Fetches gridded winds aloft and MSL pressure and publishes them over MQTT",
    version
)]
pub struct WeatherConfig {
    /// Path to a TOML config file. Not itself settable from the file.
    #[arg(
        long,
        env = "ADSB_WEATHER_CONFIG",
        default_value = "/etc/adsb/weather.toml"
    )]
    #[serde(skip)]
    pub config: PathBuf,

    /// Print the effective configuration as TOML and exit.
    #[arg(long, help = "Print the effective configuration and exit")]
    #[serde(skip)]
    pub print_config: bool,

    /// Receiver identity. The MQTT client id is `<source_id>-weather`.
    #[arg(long, env = "ADSB_SOURCE_ID", default_value = "adsb-edge")]
    #[serde(default = "default_source_id")]
    pub source_id: String,

    /// MQTT broker hostname or IP.
    #[arg(long, env = "ADSB_MQTT_BROKER", default_value = "localhost")]
    #[serde(default = "default_mqtt_broker")]
    pub mqtt_broker: String,

    /// MQTT broker port.
    #[arg(long, env = "ADSB_MQTT_PORT", default_value = "1883")]
    #[serde(default = "default_mqtt_port")]
    pub mqtt_port: u16,

    /// Topic the retained snapshot is published to.
    #[arg(
        long,
        env = "ADSB_MQTT_WEATHER_TOPIC",
        default_value = "adsb/weather/grid"
    )]
    #[serde(default = "default_mqtt_topic")]
    pub mqtt_topic: String,

    /// Receiver latitude, degrees. Required.
    #[arg(long, env = "ADSB_RECEIVER_LATITUDE", allow_negative_numbers = true)]
    #[serde(default)]
    pub receiver_latitude: Option<f64>,

    /// Receiver longitude, degrees. Required.
    #[arg(long, env = "ADSB_RECEIVER_LONGITUDE", allow_negative_numbers = true)]
    #[serde(default)]
    pub receiver_longitude: Option<f64>,

    /// Grid radius around the receiver, nautical miles.
    #[arg(long, env = "ADSB_WEATHER_RADIUS_NM", default_value = "300")]
    #[serde(default = "default_radius_nm")]
    pub radius_nm: f64,

    /// Grid spacing, degrees.
    #[arg(long, env = "ADSB_WEATHER_SPACING_DEG", default_value = "1.0")]
    #[serde(default = "default_spacing_deg")]
    pub spacing_deg: f64,

    /// Pressure levels to fetch, hPa, comma-separated.
    #[arg(
        long,
        env = "ADSB_WEATHER_LEVELS",
        value_delimiter = ',',
        default_value = "850,700,500,300,250,200"
    )]
    #[serde(default = "default_levels")]
    pub levels: Vec<u16>,

    /// Minutes between fetches.
    #[arg(long, env = "ADSB_WEATHER_REFRESH_MINUTES", default_value = "60")]
    #[serde(default = "default_refresh_minutes")]
    pub refresh_minutes: u32,

    /// Open-Meteo weather model, e.g. best_match, icon_eu, gfs_global.
    #[arg(long, env = "ADSB_WEATHER_MODEL", default_value = "best_match")]
    #[serde(default = "default_model")]
    pub model: String,

    /// Forecast endpoint. Overridable for tests and self-hosted instances.
    #[arg(long, env = "ADSB_WEATHER_BASE_URL", default_value = DEFAULT_BASE_URL)]
    #[serde(default = "default_base_url")]
    pub base_url: String,

    /// Where the last good snapshot is kept across restarts. Unset disables it.
    #[arg(long, env = "ADSB_WEATHER_CACHE_PATH")]
    #[serde(default)]
    pub cache_path: Option<PathBuf>,

    /// Control API port (enable/disable, status). 0 disables the API.
    #[arg(long, env = "ADSB_WEATHER_HTTP_PORT", default_value = "8789")]
    #[serde(default = "default_http_port")]
    pub http_port: u16,

    /// Address the control API binds. Loopback by default: the API has no
    /// authentication, so reaching it from another machine is a deliberate
    /// choice (`0.0.0.0` on a trusted LAN).
    #[arg(long, env = "ADSB_WEATHER_HTTP_BIND", default_value = "127.0.0.1")]
    #[serde(default = "default_http_bind")]
    pub http_bind: String,

    /// Where the enabled setting and any rate-limit deadline survive restarts.
    /// Unset keeps them in memory: a reboot re-enables fetching and forgets a
    /// rate limit.
    #[arg(long, env = "ADSB_WEATHER_STATE_PATH")]
    #[serde(default)]
    pub state_path: Option<PathBuf>,

    /// Log level.
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
    "adsb/weather/grid".into()
}
fn default_radius_nm() -> f64 {
    300.0
}
fn default_spacing_deg() -> f64 {
    1.0
}
fn default_levels() -> Vec<u16> {
    vec![850, 700, 500, 300, 250, 200]
}
fn default_refresh_minutes() -> u32 {
    60
}
fn default_model() -> String {
    "best_match".into()
}
fn default_base_url() -> String {
    DEFAULT_BASE_URL.into()
}
fn default_log_level() -> String {
    "info".into()
}
fn default_http_port() -> u16 {
    DEFAULT_HTTP_PORT
}
fn default_http_bind() -> String {
    "127.0.0.1".into()
}

impl WeatherConfig {
    /// Loads configuration with full layering.
    ///
    /// A file value is applied only to fields that no flag or environment
    /// variable set. For fields with a default that is `ValueSource::DefaultValue`;
    /// for the `Option` fields with no default, clap reports *no* source at all
    /// when nothing set them, which must count as "defaulted" too -- otherwise
    /// the rendered file's receiver position would be silently ignored.
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
        let from_file: toml::Value =
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        cfg.overlay_file(&from_file, &|id| {
            matches!(
                matches.value_source(id),
                None | Some(ValueSource::DefaultValue)
            )
        });
        Ok(cfg)
    }

    /// Applies file values to fields the caller reports as still-defaulted.
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
        // TOML distinguishes 47 from 47.0; an operator writing either means the same.
        let float = |v: &toml::Value| v.as_float().or_else(|| v.as_integer().map(|i| i as f64));

        overlay!("source_id", source_id, string);
        overlay!("mqtt_broker", mqtt_broker, string);
        overlay!("mqtt_port", mqtt_port, |v: &toml::Value| v
            .as_integer()
            .and_then(|i| u16::try_from(i).ok()));
        overlay!("mqtt_topic", mqtt_topic, string);
        overlay!("receiver_latitude", receiver_latitude, |v| float(v)
            .map(Some));
        overlay!("receiver_longitude", receiver_longitude, |v| float(v)
            .map(Some));
        overlay!("radius_nm", radius_nm, float);
        overlay!("spacing_deg", spacing_deg, float);
        // All or nothing: one malformed entry leaves the default list in place
        // rather than fetching a silently shortened set of levels.
        overlay!("levels", levels, |v: &toml::Value| v.as_array().and_then(
            |a| {
                a.iter()
                    .map(|x| x.as_integer().and_then(|i| u16::try_from(i).ok()))
                    .collect::<Option<Vec<u16>>>()
            }
        ));
        overlay!("refresh_minutes", refresh_minutes, |v: &toml::Value| v
            .as_integer()
            .and_then(|i| u32::try_from(i).ok()));
        overlay!("model", model, string);
        overlay!("base_url", base_url, string);
        overlay!("cache_path", cache_path, |v: &toml::Value| v
            .as_str()
            .map(|s| Some(PathBuf::from(s))));
        overlay!("http_port", http_port, |v: &toml::Value| v
            .as_integer()
            .and_then(|i| u16::try_from(i).ok()));
        overlay!("http_bind", http_bind, string);
        overlay!("state_path", state_path, |v: &toml::Value| v
            .as_str()
            .map(|s| Some(PathBuf::from(s))));
        overlay!("log_level", log_level, string);
    }

    /// Rejects configuration that would fail later, or quietly do the wrong thing.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.receiver_latitude.is_none() {
            bail!("receiver_latitude is required: set [receiver] latitude in adsb-stack.toml");
        }
        if self.receiver_longitude.is_none() {
            bail!("receiver_longitude is required: set [receiver] longitude in adsb-stack.toml");
        }
        if self.refresh_minutes == 0 {
            bail!("refresh_minutes must be at least 1");
        }
        if self.levels.is_empty() {
            bail!("levels must name at least one pressure level");
        }
        if let Some(bad) = self.levels.iter().find(|l| !OPEN_METEO_LEVELS.contains(l)) {
            bail!(
                "pressure level {bad} hPa is not served by Open-Meteo (available: {OPEN_METEO_LEVELS:?})"
            );
        }
        // The model name is placed in the query string unencoded, so anything
        // beyond a plain identifier could smuggle in extra parameters.
        let plain_identifier = |s: &str| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        };
        if !plain_identifier(&self.model) {
            bail!(
                "model '{}' must be one Open-Meteo model name (lowercase letters, digits, underscores)",
                self.model
            );
        }
        self.grid()?;
        self.http_bind_addr()?;
        Ok(())
    }

    /// The address the control API binds.
    pub fn http_bind_addr(&self) -> anyhow::Result<IpAddr> {
        self.http_bind.parse().with_context(|| {
            format!(
                "http_bind '{}' must be an IP address, e.g. 127.0.0.1 or 0.0.0.0",
                self.http_bind
            )
        })
    }

    /// The sampling grid this configuration describes.
    pub fn grid(&self) -> anyhow::Result<GridSpec> {
        let (Some(lat), Some(lon)) = (self.receiver_latitude, self.receiver_longitude) else {
            bail!("receiver_latitude and receiver_longitude are required");
        };
        GridSpec::centered(lat, lon, self.radius_nm, self.spacing_deg)
            .context("invalid weather grid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> WeatherConfig {
        WeatherConfig::parse_from(["adsb-weather-server"])
    }

    fn located() -> WeatherConfig {
        WeatherConfig {
            receiver_latitude: Some(46.717915),
            receiver_longitude: Some(-2.33716964),
            ..defaults()
        }
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
        cfg.overlay_file(
            &file("mqtt_topic = 'adsb/dev/weather/grid'\nrefresh_minutes = 120\nspacing_deg = 0.5"),
            &all_defaulted,
        );
        assert_eq!(cfg.mqtt_topic, "adsb/dev/weather/grid");
        assert_eq!(cfg.refresh_minutes, 120);
        assert_eq!(cfg.spacing_deg, 0.5);
    }

    #[test]
    fn explicit_flag_beats_the_file() {
        let mut cfg = WeatherConfig::parse_from(["adsb-weather-server", "--refresh-minutes", "30"]);
        cfg.overlay_file(
            &file("refresh_minutes = 120"),
            &explicit(&["refresh_minutes"]),
        );
        assert_eq!(cfg.refresh_minutes, 30);
    }

    #[test]
    fn receiver_position_and_cache_path_come_from_the_file() {
        let mut cfg = defaults();
        cfg.overlay_file(
            &file(
                "receiver_latitude = 46.717915\nreceiver_longitude = -2.33716964\n\
                 cache_path = '/tmp/weather.json'",
            ),
            &all_defaulted,
        );
        assert_eq!(cfg.receiver_latitude, Some(46.717915));
        assert_eq!(cfg.receiver_longitude, Some(-2.33716964));
        assert_eq!(cfg.cache_path, Some(PathBuf::from("/tmp/weather.json")));
    }

    #[test]
    fn an_integer_coordinate_in_the_file_is_accepted() {
        // TOML distinguishes 47 from 47.0; an operator writing either means the same.
        let mut cfg = defaults();
        cfg.overlay_file(
            &file("receiver_latitude = 47\nradius_nm = 250"),
            &all_defaulted,
        );
        assert_eq!(cfg.receiver_latitude, Some(47.0));
        assert_eq!(cfg.radius_nm, 250.0);
    }

    #[test]
    fn levels_come_from_a_file_array() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("levels = [300, 250]"), &all_defaulted);
        assert_eq!(cfg.levels, vec![300, 250]);
    }

    #[test]
    fn a_malformed_levels_array_is_ignored_not_fatal() {
        let mut cfg = defaults();
        cfg.overlay_file(&file("levels = [300, 'high']"), &all_defaulted);
        assert_eq!(cfg.levels, default_levels());
    }

    #[test]
    fn negative_longitude_parses_from_the_command_line() {
        let cfg = WeatherConfig::parse_from([
            "adsb-weather-server",
            "--receiver-latitude",
            "46.7",
            "--receiver-longitude",
            "-2.3",
        ]);
        assert_eq!(cfg.receiver_longitude, Some(-2.3));
    }

    #[test]
    fn a_located_default_config_is_valid() {
        assert!(located().validate().is_ok());
    }

    #[test]
    fn a_missing_receiver_position_is_an_error() {
        let err = defaults().validate().unwrap_err().to_string();
        assert!(err.contains("receiver_latitude"), "{err}");
    }

    #[test]
    fn an_unknown_pressure_level_is_an_error() {
        let cfg = WeatherConfig {
            levels: vec![850, 123],
            ..located()
        };
        let err = cfg.validate().unwrap_err().to_string();
        assert!(err.contains("123"), "{err}");
    }

    #[test]
    fn no_levels_is_an_error() {
        let cfg = WeatherConfig {
            levels: vec![],
            ..located()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn a_zero_refresh_interval_is_an_error() {
        let cfg = WeatherConfig {
            refresh_minutes: 0,
            ..located()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn a_model_that_would_inject_url_parameters_is_an_error() {
        // The model name goes into the query string unencoded.
        let cfg = WeatherConfig {
            model: "best_match&latitude=0".into(),
            ..located()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn an_invalid_grid_is_an_error() {
        let cfg = WeatherConfig {
            spacing_deg: 0.0,
            ..located()
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn the_control_api_is_loopback_only_by_default() {
        let cfg = defaults();
        assert_eq!(cfg.http_bind, "127.0.0.1");
        assert!(cfg.http_bind_addr().unwrap().is_loopback());
        assert_eq!(cfg.state_path, None);
    }

    #[test]
    fn the_default_http_port_is_the_api_contract_port() {
        // clap needs a string literal, the contract a number: pin them together.
        assert_eq!(defaults().http_port, DEFAULT_HTTP_PORT);
    }

    #[test]
    fn control_api_settings_come_from_the_file() {
        let mut cfg = defaults();
        cfg.overlay_file(
            &file(
                "http_port = 9000\nhttp_bind = '0.0.0.0'\n\
                 state_path = '/var/lib/adsb/weather-state.json'",
            ),
            &all_defaulted,
        );
        assert_eq!(cfg.http_port, 9000);
        assert_eq!(cfg.http_bind, "0.0.0.0");
        assert_eq!(
            cfg.state_path,
            Some(PathBuf::from("/var/lib/adsb/weather-state.json"))
        );
    }

    #[test]
    fn an_http_bind_that_is_not_an_address_is_an_error() {
        let cfg = WeatherConfig {
            http_bind: "localhost".into(),
            ..located()
        };
        let err = cfg.validate().unwrap_err().to_string();
        assert!(err.contains("http_bind"), "{err}");
    }

    #[test]
    fn the_default_grid_is_centred_on_the_receiver() {
        let grid = located().grid().unwrap();
        assert_eq!(grid.len(), 187);
        assert_eq!(grid.point(grid.nlat / 2, grid.nlon / 2), (47.0, -2.0));
    }
}
