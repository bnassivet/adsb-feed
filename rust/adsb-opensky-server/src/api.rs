//! The OpenSky service's HTTP control API: the contract both ends share.
//!
//! Commands go over HTTP, live data and status over MQTT. The desktop tells
//! the service *what to watch* with `PUT` on [`watch_path`]; the service polls
//! OpenSky for it and publishes what it finds on the states topic.
//!
//! The watch list is a **lease**, not a setting: it is kept in memory only and
//! lapses unless the client renews it. A desktop that crashes therefore stops
//! costing credits within one lease, and a restarted service learns the list
//! again from the next renewal.
//!
//! No service dependencies: the server and the client both build on this.

use crate::states::OpenSkyTrack;
use serde::{Deserialize, Serialize};

/// Port the API listens on unless configured otherwise. 8787-8790 are the
/// recorder, the desktop tool server, the weather service and the feed's
/// metrics.
pub const DEFAULT_HTTP_PORT: u16 = 8791;

/// `GET`: the current [`crate::status::OpenSkyStatus`].
pub const STATUS_PATH: &str = "/v1/status";

/// `PUT` an [`EnabledSetting`]: pause or resume polling.
pub const ENABLED_PATH: &str = "/v1/enabled";

/// `PUT` a [`WatchRequest`] at `/v1/watch/{client_id}`, `DELETE` to drop it.
pub const WATCH_PATH: &str = "/v1/watch/{client_id}";

/// `GET` the [`CreditsReport`]: credits spent per hour over the last 24 h.
pub const CREDITS_PATH: &str = "/v1/credits";

/// `GET` at `/v1/track/{icao24}`: the aircraft's live [`OpenSkyTrack`].
pub const TRACK_PATH: &str = "/v1/track/{icao24}";

/// `GET`: the API's OpenAPI document, generated from the code.
pub const OPENAPI_PATH: &str = "/v1/openapi.json";

/// Swagger UI over [`OPENAPI_PATH`]; the page is `SWAGGER_UI_PATH` + `/`.
pub const SWAGGER_UI_PATH: &str = "/swagger-ui";

/// `GET`: the Prometheus exposition. Unversioned and undocumented, as in the
/// weather service.
pub const METRICS_PATH: &str = "/metrics";

/// [`WATCH_PATH`] for one client.
pub fn watch_path(client_id: &str) -> String {
    WATCH_PATH.replace("{client_id}", client_id)
}

/// [`TRACK_PATH`] for one aircraft.
pub fn track_path(icao24: &str) -> String {
    TRACK_PATH.replace("{icao24}", icao24)
}

/// The body of a `PUT` to [`ENABLED_PATH`], and of its `202` reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct EnabledSetting {
    /// `false` pauses polling; `true` resumes it. In memory only.
    pub enabled: bool,
}

/// A geographic box. Longitudes do not wrap: `west < east`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct Area {
    /// The client's name for the area; echoed in each state's `matched`.
    pub id: String,
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
}

impl Area {
    /// Latitude span times longitude span, square degrees: what OpenSky
    /// charges by.
    pub fn square_degrees(&self) -> f64 {
        (self.north - self.south).abs() * (self.east - self.west).abs()
    }

    /// Why the box cannot be sent to OpenSky, if it cannot.
    pub fn problem(&self) -> Option<String> {
        let finite = [self.north, self.south, self.east, self.west]
            .iter()
            .all(|v| v.is_finite());
        if !finite {
            return Some(format!("area '{}' has a non-numeric bound", self.id));
        }
        if !(-90.0..=90.0).contains(&self.south) || !(-90.0..=90.0).contains(&self.north) {
            return Some(format!("area '{}': latitude out of range", self.id));
        }
        if !(-180.0..=180.0).contains(&self.west) || !(-180.0..=180.0).contains(&self.east) {
            return Some(format!("area '{}': longitude out of range", self.id));
        }
        if self.south >= self.north || self.west >= self.east {
            return Some(format!(
                "area '{}' is empty or inverted (south < north and west < east are required)",
                self.id
            ));
        }
        if self.id.is_empty() || self.id.len() > 64 {
            return Some("an area id must be 1 to 64 characters".into());
        }
        None
    }

    /// Whether a position is inside the box, edges included.
    pub fn contains(&self, lat: f64, lon: f64) -> bool {
        (self.south..=self.north).contains(&lat) && (self.west..=self.east).contains(&lon)
    }
}

/// What a client wants watched: the body of a `PUT` to [`watch_path`].
///
/// Replaces that client's previous request whole. Both lists empty is the
/// same as a `DELETE`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct WatchRequest {
    /// Aircraft to follow, by ICAO 24-bit address (hex, any case).
    #[serde(default)]
    pub icao24: Vec<String>,
    /// Areas to watch.
    #[serde(default)]
    pub areas: Vec<Area>,
}

/// The reply to an accepted [`WatchRequest`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct WatchAccepted {
    /// Aircraft now watched for this client.
    pub icao24: usize,
    /// Areas now watched for this client.
    pub areas: usize,
    /// Renew before this many seconds pass, or the request lapses.
    pub lease_seconds: u64,
    /// The interval the poller now plans, seconds; `None` when idle.
    #[serde(default)]
    pub interval_seconds: Option<f64>,
}

/// Credits spent in one hour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct HourCredits {
    /// Start of the hour, epoch ms.
    pub hour_start_ms: i64,
    /// Credits charged to OpenSky's `/states` bucket.
    pub states: u32,
    /// Credits charged to OpenSky's `/tracks` bucket.
    pub tracks: u32,
}

/// The body of `GET` on [`CREDITS_PATH`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct CreditsReport {
    /// Credits the service allows itself per day, per bucket.
    pub daily_limit: u32,
    /// The last 24 hours, oldest first; the last entry is the current hour.
    pub hours: Vec<HourCredits>,
    /// When the report was made, epoch ms.
    pub generated_ms: i64,
    /// OpenSky's own remaining `/states` count, from its last reply
    /// (`X-Rate-Limit-Remaining`). It counts the whole account, so it can be
    /// lower than `daily_limit` minus what this service spent. OpenSky reports
    /// what is left, never the allowance itself: that is `daily_limit`.
    #[serde(default)]
    pub states_remaining: Option<i64>,
    /// The same for `/tracks`.
    #[serde(default)]
    pub tracks_remaining: Option<i64>,
}

/// The body of `GET` on [`track_path`].
pub type TrackReply = OpenSkyTrack;

/// The body of an error reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct ApiError {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(n: f64, s: f64, e: f64, w: f64) -> Area {
        Area {
            id: "a".into(),
            north: n,
            south: s,
            east: e,
            west: w,
        }
    }

    #[test]
    fn routes_are_versioned_except_metrics() {
        for p in [
            STATUS_PATH,
            ENABLED_PATH,
            WATCH_PATH,
            CREDITS_PATH,
            TRACK_PATH,
            OPENAPI_PATH,
        ] {
            assert!(p.starts_with("/v1/"), "{p}");
        }
        assert_eq!(METRICS_PATH, "/metrics");
    }

    #[test]
    fn paths_fill_their_parameter() {
        assert_eq!(watch_path("laptop-dev"), "/v1/watch/laptop-dev");
        assert_eq!(track_path("3c6444"), "/v1/track/3c6444");
    }

    #[test]
    fn an_area_is_charged_by_its_square_degrees() {
        assert_eq!(area(48.0, 46.0, 0.0, -3.0).square_degrees(), 6.0);
    }

    #[test]
    fn a_valid_area_has_no_problem() {
        assert_eq!(area(48.0, 46.0, 0.0, -3.0).problem(), None);
    }

    #[test]
    fn inverted_or_out_of_range_areas_are_refused() {
        assert!(area(46.0, 48.0, 0.0, -3.0).problem().is_some());
        assert!(area(48.0, 46.0, -3.0, 0.0).problem().is_some());
        assert!(area(95.0, 46.0, 0.0, -3.0).problem().is_some());
        assert!(area(48.0, 46.0, 190.0, -3.0).problem().is_some());
        assert!(area(f64::NAN, 46.0, 0.0, -3.0).problem().is_some());
        let unnamed = Area {
            id: String::new(),
            ..area(48.0, 46.0, 0.0, -3.0)
        };
        assert!(unnamed.problem().is_some());
    }

    #[test]
    fn containment_includes_the_edges() {
        let a = area(48.0, 46.0, 0.0, -3.0);
        assert!(a.contains(46.0, -3.0));
        assert!(a.contains(47.0, -1.0));
        assert!(!a.contains(48.1, -1.0));
    }

    #[test]
    fn an_empty_body_is_an_empty_watch() {
        let w: WatchRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(w, WatchRequest::default());
    }

    #[test]
    fn an_enabled_setting_without_the_field_is_rejected() {
        assert!(serde_json::from_str::<EnabledSetting>("{}").is_err());
    }
}
