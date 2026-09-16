//! The weather service's HTTP control API: the contract both ends share.
//!
//! Commands go over HTTP, status over MQTT. `PUT` on [`ENABLED_PATH`] sets
//! the *desired* state and answers `202 Accepted`; what the service then does
//! is published on the status topic (and served by [`STATUS_PATH`]). A caller
//! that wants to know the command took effect watches the status, not the
//! reply.
//!
//! No service dependencies: the server and the client both build on this.
//! The OpenAPI schemas are derived only with the `openapi` feature.

use serde::{Deserialize, Serialize};

/// Port the API listens on unless configured otherwise.
pub const DEFAULT_HTTP_PORT: u16 = 8789;

/// `GET`: the current [`crate::status::WeatherStatus`].
pub const STATUS_PATH: &str = "/v1/status";

/// `PUT` an [`EnabledSetting`]: enable or disable fetching.
pub const ENABLED_PATH: &str = "/v1/enabled";

/// `GET`: the API's OpenAPI document, generated from the code.
pub const OPENAPI_PATH: &str = "/v1/openapi.json";

/// Swagger UI over [`OPENAPI_PATH`]; the page is `SWAGGER_UI_PATH` + `/`.
pub const SWAGGER_UI_PATH: &str = "/swagger-ui";

/// `GET`: the Prometheus exposition.
///
/// Deliberately **not** under `/v1/`. It is Prometheus's well-known default,
/// so every scrape job can omit `metrics_path`, and its contract is the
/// exposition format rather than this crate's JSON control API -- the two
/// version independently. For the same reason it is not in the OpenAPI
/// document: see [`crate::api_server::router_with_metrics`].
pub const METRICS_PATH: &str = "/metrics";

/// The body of a `PUT` to [`ENABLED_PATH`], and of its `202` reply.
///
/// A desired state, not a toggle: sending it twice is the same as once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct EnabledSetting {
    /// `false` pauses fetching (the last grid stays published); `true` resumes it.
    pub enabled: bool,
}

/// The body of an error reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct ApiError {
    /// What went wrong, for a person to read.
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setting_is_a_single_boolean_field() {
        assert_eq!(
            serde_json::to_value(EnabledSetting { enabled: false }).unwrap(),
            serde_json::json!({ "enabled": false })
        );
    }

    #[test]
    fn a_setting_without_the_field_is_rejected() {
        // An empty body must not silently mean "disable".
        assert!(serde_json::from_str::<EnabledSetting>("{}").is_err());
    }

    #[test]
    fn the_metrics_path_is_deliberately_unversioned() {
        // Prometheus's well-known default, so scrape configs need no
        // metrics_path. It does not move with the control API's version.
        assert_eq!(METRICS_PATH, "/metrics");
        assert!(!METRICS_PATH.starts_with("/v1/"));
    }

    #[test]
    fn routes_are_versioned() {
        assert!(STATUS_PATH.starts_with("/v1/"));
        assert!(ENABLED_PATH.starts_with("/v1/"));
        // The document describes one API version, so it lives under it.
        assert!(OPENAPI_PATH.starts_with("/v1/"));
    }
}
