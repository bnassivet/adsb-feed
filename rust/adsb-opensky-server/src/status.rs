//! The OpenSky service's status, and the topics it publishes on.
//!
//! Four topics share one base, derived by [`OpenSkyTopics`]:
//! - `states`: a [`crate::states::StatesMessage`] per poll, **not** retained;
//! - `tracks`: a [`crate::states::TrackMessage`] per track fetched, **not**
//!   retained -- what recorders store;
//! - `status`: the retained [`OpenSkyStatus`];
//! - `availability`: `online` / `offline`, the MQTT birth and last will.
//!
//! No service dependencies: the desktop decodes these.

use serde::{Deserialize, Serialize};

/// Status schema version. Bump on any incompatible change.
pub const STATUS_VERSION: u32 = 1;

pub const AVAILABILITY_ONLINE: &str = "online";
pub const AVAILABILITY_OFFLINE: &str = "offline";

/// What the poller is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    /// Nothing is watched: no polling, no credits spent.
    Idle,
    /// A poll is in flight.
    Polling,
    /// Waiting for the next scheduled poll.
    Waiting,
    /// The last poll failed transiently; backing off.
    Retrying,
    /// OpenSky refused for quota (HTTP 429); waiting for its deadline.
    RateLimited,
    /// OpenSky refused the credentials. Polling stops until a restart with
    /// valid ones: retrying would only be refused again.
    Unauthorized,
    /// Paused through the control API.
    Disabled,
}

/// What is being watched, summed over every live lease.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct WatchSummary {
    pub icao24: usize,
    pub areas: usize,
    /// Clients with a live lease.
    pub clients: usize,
}

/// Credits, as the bottom bar shows them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct CreditsSummary {
    /// The daily allowance the service budgets against, per bucket.
    pub daily_limit: u32,
    /// `/states` credits this service spent in the last 24 h.
    pub states_used_24h: u32,
    /// `/tracks` credits this service spent in the last 24 h.
    pub tracks_used_24h: u32,
    /// OpenSky's own remaining `/states` count, from its last reply.
    #[serde(default)]
    pub states_remaining: Option<i64>,
    /// OpenSky's own remaining `/tracks` count, from its last reply.
    #[serde(default)]
    pub tracks_remaining: Option<i64>,
}

/// The service's status, as published on the status topic and served by
/// `GET /v1/status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct OpenSkyStatus {
    pub version: u32,
    /// The desired state, set through the control API.
    pub enabled: bool,
    /// Whether the service has OpenSky credentials. Anonymous access has a
    /// tenth of the allowance and no tracks.
    pub authenticated: bool,
    pub state: ServiceState,
    pub watch: WatchSummary,
    /// The interval the poller plans between cycles, seconds.
    #[serde(default)]
    pub interval_seconds: Option<f64>,
    /// What one cycle costs, credits.
    #[serde(default)]
    pub cycle_cost: u32,
    pub credits: CreditsSummary,
    pub consecutive_failures: u32,
    /// Set while `state` is `rate_limited`, epoch ms.
    #[serde(default)]
    pub rate_limited_until_ms: Option<i64>,
    #[serde(default)]
    pub last_success_ms: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub next_poll_ms: Option<i64>,
    pub updated_at_ms: i64,
}

impl OpenSkyStatus {
    /// A status before anything has happened.
    pub fn initial(enabled: bool, authenticated: bool, daily_limit: u32, now_ms: i64) -> Self {
        Self {
            version: STATUS_VERSION,
            enabled,
            authenticated,
            state: if enabled {
                ServiceState::Idle
            } else {
                ServiceState::Disabled
            },
            watch: WatchSummary::default(),
            interval_seconds: None,
            cycle_cost: 0,
            credits: CreditsSummary {
                daily_limit,
                ..CreditsSummary::default()
            },
            consecutive_failures: 0,
            rate_limited_until_ms: None,
            last_success_ms: None,
            last_error: None,
            next_poll_ms: None,
            updated_at_ms: now_ms,
        }
    }

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

/// Why a status payload was rejected.
#[derive(Debug, thiserror::Error)]
pub enum StatusError {
    #[error("malformed OpenSky status JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported status version {found} (expected {expected})")]
    Version { found: u32, expected: u32 },
}

/// Whether the service's publisher is connected to the broker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Online,
    Offline,
}

impl Availability {
    /// Anything but the two known words is `None`.
    pub fn parse(payload: &[u8]) -> Option<Self> {
        match std::str::from_utf8(payload).ok()?.trim() {
            AVAILABILITY_ONLINE => Some(Self::Online),
            AVAILABILITY_OFFLINE => Some(Self::Offline),
            _ => None,
        }
    }
}

/// The service's topics, all derived from the states topic.
///
/// Both ends apply this to the same states topic, which each derives from the
/// feed topic (`Config::opensky_topic` in Rust, `opensky_topic()` in
/// `render-config.py`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenSkyTopics {
    pub states: String,
    pub tracks: String,
    pub status: String,
    pub availability: String,
}

impl OpenSkyTopics {
    pub fn from_states_topic(states: &str) -> Self {
        let base = states.strip_suffix("/states").unwrap_or(states);
        Self {
            states: states.to_string(),
            tracks: format!("{base}/tracks"),
            status: format!("{base}/status"),
            availability: format!("{base}/availability"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_topics_are_siblings_of_the_states_topic() {
        let t = OpenSkyTopics::from_states_topic("adsb/dev/opensky/states");
        assert_eq!(t.status, "adsb/dev/opensky/status");
        assert_eq!(t.availability, "adsb/dev/opensky/availability");
        assert_eq!(t.tracks, "adsb/dev/opensky/tracks");
    }

    #[test]
    fn any_other_topic_gets_children() {
        let t = OpenSkyTopics::from_states_topic("lab/osky");
        assert_eq!(t.status, "lab/osky/status");
    }

    #[test]
    fn a_status_round_trips() {
        let mut s = OpenSkyStatus::initial(true, true, 4_000, 5);
        s.state = ServiceState::RateLimited;
        s.rate_limited_until_ms = Some(9);
        s.credits.states_remaining = Some(12);
        let bytes = serde_json::to_vec(&s).unwrap();
        assert_eq!(OpenSkyStatus::from_json(&bytes).unwrap(), s);
    }

    #[test]
    fn states_serialise_as_snake_case() {
        assert_eq!(
            serde_json::to_value(ServiceState::RateLimited).unwrap(),
            "rate_limited"
        );
    }

    #[test]
    fn a_disabled_service_starts_disabled() {
        assert_eq!(
            OpenSkyStatus::initial(false, false, 400, 0).state,
            ServiceState::Disabled
        );
    }

    #[test]
    fn another_version_is_rejected() {
        let mut v = serde_json::to_value(OpenSkyStatus::initial(true, true, 1, 0)).unwrap();
        v["version"] = 2.into();
        assert!(OpenSkyStatus::from_json(&serde_json::to_vec(&v).unwrap()).is_err());
    }

    #[test]
    fn availability_parses_only_the_two_words() {
        assert_eq!(Availability::parse(b"online"), Some(Availability::Online));
        assert_eq!(
            Availability::parse(b"offline\n"),
            Some(Availability::Offline)
        );
        assert_eq!(Availability::parse(b"maybe"), None);
    }
}
