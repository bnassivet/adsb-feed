//! The weather service's status: the query side of its control plane.
//!
//! Like [`crate::snapshot`], these types carry no service dependencies, so a
//! consumer -- the desktop app -- can decode what the service publishes without
//! building an HTTP client or an MQTT publisher.
//!
//! Three retained topics share one base, derived by [`WeatherTopics`]:
//! - `grid`: the [`crate::WeatherSnapshot`];
//! - `status`: a [`WeatherStatus`], the last thing the service reported;
//! - `availability`: `online` / `offline`, the MQTT birth and last-will pair.
//!
//! Liveness is kept off the status topic on purpose. A last will is fixed when
//! the client connects, so a will carrying a full status would overwrite the
//! real one with fields frozen at connect time the moment the service died.

use serde::{Deserialize, Serialize};

/// Status schema version. Bump on any incompatible change.
pub const STATUS_VERSION: u32 = 1;

/// Availability payload while the publisher is connected.
pub const AVAILABILITY_ONLINE: &str = "online";

/// Availability payload after the publisher is gone: its last will, and what
/// it sends itself before a graceful disconnect.
pub const AVAILABILITY_OFFLINE: &str = "offline";

/// Which Open-Meteo request limit a rate-limited fetch ran into.
///
/// The limits are per IP and come in three windows. Which one was hit decides
/// how long asking again is pointless.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum RateLimitScope {
    Minutely,
    Hourly,
    Daily,
    /// Rate limited, but the provider did not say which window.
    Unknown,
}

/// What the refresh loop is doing: the *reported* state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    /// Waiting for the next scheduled fetch.
    Idle,
    /// A fetch is in flight.
    Fetching,
    /// The last fetch failed transiently; backing off.
    Retrying,
    /// The provider refused for quota; waiting for its window to roll over.
    RateLimited,
    /// The provider refused the request itself; waiting a full refresh.
    Rejected,
    /// Disabled by the operator: no fetches.
    Disabled,
}

/// The service's status, as published on the status topic and served by
/// `GET /v1/status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct WeatherStatus {
    /// Status schema version; currently 1.
    pub version: u32,
    /// The *desired* state: the operator's accepted, persisted setting.
    pub enabled: bool,
    /// The *reported* state. A UI shows a change as pending until this agrees
    /// with `enabled`.
    pub state: ServiceState,
    /// Consecutive failed fetches; zero after a success.
    pub consecutive_failures: u32,
    /// Set while `state` is `rate_limited`.
    #[serde(default)]
    pub rate_limit: Option<RateLimitScope>,
    /// Epoch ms of the last successful fetch.
    #[serde(default)]
    pub last_success_ms: Option<i64>,
    /// Why the last fetch failed, while it is still failing.
    #[serde(default)]
    pub last_error: Option<String>,
    /// Epoch ms of the next fetch, when one is scheduled.
    #[serde(default)]
    pub next_fetch_ms: Option<i64>,
    /// Valid time of the grid being published, epoch ms.
    #[serde(default)]
    pub snapshot_valid_time_ms: Option<i64>,
    /// When this status was produced, epoch ms.
    pub updated_at_ms: i64,
}

/// Why a status payload was rejected.
#[derive(Debug, thiserror::Error)]
pub enum StatusError {
    #[error("malformed weather status JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported status version {found} (expected {expected})")]
    Version { found: u32, expected: u32 },
}

impl WeatherStatus {
    /// Parses a payload and checks its version.
    pub fn from_json(bytes: &[u8]) -> Result<Self, StatusError> {
        let status: Self = serde_json::from_slice(bytes)?;
        if status.version != STATUS_VERSION {
            return Err(StatusError::Version {
                found: status.version,
                expected: STATUS_VERSION,
            });
        }
        Ok(status)
    }
}

/// Whether the service's publisher is connected to the broker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Online,
    Offline,
}

impl Availability {
    /// Parses an availability payload. Anything but the two known words is
    /// `None`, so a stray publish cannot mark the service online.
    pub fn parse(payload: &[u8]) -> Option<Self> {
        match std::str::from_utf8(payload).ok()?.trim() {
            AVAILABILITY_ONLINE => Some(Self::Online),
            AVAILABILITY_OFFLINE => Some(Self::Offline),
            _ => None,
        }
    }

    /// The wire payload.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => AVAILABILITY_ONLINE,
            Self::Offline => AVAILABILITY_OFFLINE,
        }
    }
}

/// The service's topics, all derived from the grid topic.
///
/// The one rule both ends use: the service derives its topics from the topic
/// it publishes the grid to, and the desktop from the grid topic it subscribes
/// to. A trailing `/grid` is replaced; any other grid topic gets children.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeatherTopics {
    pub grid: String,
    pub status: String,
    pub availability: String,
}

impl WeatherTopics {
    pub fn from_grid_topic(grid: &str) -> Self {
        let base = grid.strip_suffix("/grid").unwrap_or(grid);
        Self {
            grid: grid.to_string(),
            status: format!("{base}/status"),
            availability: format!("{base}/availability"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> WeatherStatus {
        WeatherStatus {
            version: STATUS_VERSION,
            enabled: true,
            state: ServiceState::RateLimited,
            consecutive_failures: 2,
            rate_limit: Some(RateLimitScope::Daily),
            last_success_ms: Some(1),
            last_error: Some("Daily API request limit exceeded".into()),
            next_fetch_ms: Some(3),
            snapshot_valid_time_ms: Some(2),
            updated_at_ms: 4,
        }
    }

    #[test]
    fn rate_limit_scope_serialises_as_snake_case() {
        // The desktop's TypeScript union matches on these strings.
        assert_eq!(
            serde_json::to_value(RateLimitScope::Minutely).unwrap(),
            "minutely"
        );
        assert_eq!(
            serde_json::to_value(RateLimitScope::Unknown).unwrap(),
            "unknown"
        );
    }

    #[test]
    fn service_state_serialises_as_snake_case() {
        assert_eq!(
            serde_json::to_value(ServiceState::RateLimited).unwrap(),
            "rate_limited"
        );
    }

    #[test]
    fn a_status_round_trips() {
        let bytes = serde_json::to_vec(&status()).unwrap();
        assert_eq!(WeatherStatus::from_json(&bytes).unwrap(), status());
    }

    #[test]
    fn missing_optional_fields_decode_as_none() {
        let minimal = r#"{"version":1,"enabled":false,"state":"disabled",
                          "consecutive_failures":0,"updated_at_ms":5}"#;
        let decoded = WeatherStatus::from_json(minimal.as_bytes()).unwrap();
        assert_eq!(decoded.state, ServiceState::Disabled);
        assert_eq!(decoded.next_fetch_ms, None);
    }

    #[test]
    fn another_version_is_rejected() {
        let mut future = serde_json::to_value(status()).unwrap();
        future["version"] = 2.into();
        let bytes = serde_json::to_vec(&future).unwrap();
        assert!(matches!(
            WeatherStatus::from_json(&bytes),
            Err(StatusError::Version { found: 2, .. })
        ));
    }

    #[test]
    fn a_weather_grid_is_not_a_status() {
        assert!(WeatherStatus::from_json(br#"{"version":1,"grid":{}}"#).is_err());
    }

    #[test]
    fn availability_parses_only_the_two_words() {
        assert_eq!(Availability::parse(b"online"), Some(Availability::Online));
        assert_eq!(
            Availability::parse(b"offline\n"),
            Some(Availability::Offline)
        );
        assert_eq!(Availability::parse(b"ONLINE"), None);
        assert_eq!(Availability::parse(b""), None);
        assert_eq!(Availability::parse(&[0xff, 0xfe]), None);
    }

    #[test]
    fn availability_round_trips_through_its_payload() {
        for a in [Availability::Online, Availability::Offline] {
            assert_eq!(Availability::parse(a.as_str().as_bytes()), Some(a));
        }
    }

    #[test]
    fn staged_topics_are_siblings_of_the_grid() {
        let topics = WeatherTopics::from_grid_topic("adsb/dev/weather/grid");
        assert_eq!(topics.grid, "adsb/dev/weather/grid");
        assert_eq!(topics.status, "adsb/dev/weather/status");
        assert_eq!(topics.availability, "adsb/dev/weather/availability");
    }

    #[test]
    fn any_other_grid_topic_gets_children() {
        let topics = WeatherTopics::from_grid_topic("lab/wx");
        assert_eq!(topics.status, "lab/wx/status");
        assert_eq!(topics.availability, "lab/wx/availability");
    }
}
