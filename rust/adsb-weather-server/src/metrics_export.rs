//! The weather service's Prometheus projection.
//!
//! [`WeatherStatus`] rendered as metrics. There is no background task and no
//! cache: the status is a small struct behind a `watch` lock, so a scrape
//! projects whatever `GET /v1/status` would report at that instant. One
//! source of truth, no third copy of the mapping.
//!
//! # Why a state *set* rather than an enum-valued gauge
//!
//! `ServiceState` becomes one series per variant with exactly one at `1`,
//! rather than a single gauge holding `0..5`. It is self-describing (no
//! mapping table in the dashboard), it alerts directly
//! (`adsb_weather_state{state="rate_limited"} == 1 for 30m` instead of
//! `== 3`), it aggregates across a fleet with `sum by(state)`, and inserting a
//! variant cannot silently change what an existing alert means. Six series is
//! a bounded cost.
//!
//! # Absent is not zero
//!
//! The optional timestamps are **omitted** when `None`. A service that has
//! never fetched has no last-success time; exporting `0` would plot it as a
//! success in 1970 and make `time() - last_success` enormous but finite.
//! Prometheus handles an absent series correctly; it cannot un-see a wrong one.

use crate::status::{RateLimitScope, ServiceState, WeatherStatus};
use adsb_pulsar_client::metrics_export::Exporter;

/// Every [`ServiceState`], so the exposition always carries the full set.
pub const ALL_STATES: [ServiceState; 6] = [
    ServiceState::Idle,
    ServiceState::Fetching,
    ServiceState::Retrying,
    ServiceState::RateLimited,
    ServiceState::Rejected,
    ServiceState::Disabled,
];

/// Every [`RateLimitScope`].
pub const ALL_SCOPES: [RateLimitScope; 4] = [
    RateLimitScope::Minutely,
    RateLimitScope::Hourly,
    RateLimitScope::Daily,
    RateLimitScope::Unknown,
];

/// The label for a state.
///
/// Exhaustive on purpose: adding a `ServiceState` variant fails to compile
/// here, which is the point. A `_ => "unknown"` arm would export a new state
/// as an old one and nobody would notice.
fn state_label(state: ServiceState) -> &'static str {
    match state {
        ServiceState::Idle => "idle",
        ServiceState::Fetching => "fetching",
        ServiceState::Retrying => "retrying",
        ServiceState::RateLimited => "rate_limited",
        ServiceState::Rejected => "rejected",
        ServiceState::Disabled => "disabled",
    }
}

/// The label for a rate-limit scope. Exhaustive, as above.
fn scope_label(scope: RateLimitScope) -> &'static str {
    match scope {
        RateLimitScope::Minutely => "minutely",
        RateLimitScope::Hourly => "hourly",
        RateLimitScope::Daily => "daily",
        RateLimitScope::Unknown => "unknown",
    }
}

/// Render the exposition for one status.
///
/// `version` and `source_id` become `adsb_build_info`; everything else is
/// projected from `status`.
pub fn render(version: &str, source_id: &str, status: &WeatherStatus) -> String {
    // An exporter per scrape. Every metric here is derived from `status`, so
    // there is no counter to carry between scrapes -- and building it fresh is
    // what lets an absent field be an absent series rather than a zero.
    let exporter = Exporter::new("weather", version, source_id);

    exporter.int_gauge(
        "adsb_weather_enabled",
        "The desired setting: 1 when fetching is enabled.",
        i64::from(status.enabled),
    );
    exporter.int_gauge(
        "adsb_weather_consecutive_failures",
        "Consecutive failed fetches; zero after a success.",
        i64::from(status.consecutive_failures),
    );
    exporter.int_gauge(
        "adsb_weather_status_version",
        "Schema version of the status this was projected from.",
        i64::from(status.version),
    );

    exporter.gauge_set(
        "adsb_weather_state",
        "What the refresh loop is doing; 1 on the current state.",
        "state",
        &ALL_STATES.map(|variant| (state_label(variant), variant == status.state)),
    );
    exporter.gauge_set(
        "adsb_weather_rate_limited",
        "1 on the provider limit window the last fetch ran into, if any.",
        "scope",
        &ALL_SCOPES.map(|scope| (scope_label(scope), status.rate_limit == Some(scope))),
    );

    exporter.timestamp_seconds(
        "adsb_weather_status_updated_timestamp_seconds",
        "When this status was produced.",
        Some(status.updated_at_ms),
    );
    exporter.timestamp_seconds(
        "adsb_weather_last_success_timestamp_seconds",
        "When the last fetch succeeded.",
        status.last_success_ms,
    );
    exporter.timestamp_seconds(
        "adsb_weather_next_fetch_timestamp_seconds",
        "When the next fetch is scheduled.",
        status.next_fetch_ms,
    );
    exporter.timestamp_seconds(
        "adsb_weather_snapshot_valid_timestamp_seconds",
        "Valid time of the grid currently published.",
        status.snapshot_valid_time_ms,
    );

    exporter.encode()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::STATUS_VERSION;

    fn status(state: ServiceState) -> WeatherStatus {
        WeatherStatus {
            version: STATUS_VERSION,
            enabled: true,
            state,
            consecutive_failures: 0,
            rate_limit: None,
            last_success_ms: None,
            last_error: None,
            next_fetch_ms: None,
            snapshot_valid_time_ms: None,
            updated_at_ms: 1_789_412_400_000,
        }
    }

    /// The value of a single (unlabelled) series in an exposition body.
    fn value_of(body: &str, metric: &str) -> Option<f64> {
        body.lines()
            .find(|l| l.starts_with(&format!("{metric} ")))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
    }

    /// Whether a labelled series is present at all.
    fn has_series(body: &str, prefix: &str) -> bool {
        body.lines().any(|l| l.starts_with(prefix))
    }

    #[test]
    fn exactly_one_state_series_is_one() {
        for state in ALL_STATES {
            let body = render("0.1.0", "pi-dev", &status(state));
            let ones: Vec<&str> = body
                .lines()
                .filter(|l| l.starts_with("adsb_weather_state{") && l.ends_with(" 1"))
                .collect();
            assert_eq!(ones.len(), 1, "for {state:?}: {body}");
            assert!(
                ones[0].contains(&format!(r#"state="{}""#, state_label(state))),
                "for {state:?}: {}",
                ones[0]
            );
            // Every variant is still present, as a zero.
            for other in ALL_STATES {
                assert!(
                    body.contains(&format!(r#"state="{}""#, state_label(other))),
                    "{other:?} missing from the state set: {body}"
                );
            }
        }
    }

    #[test]
    fn optional_timestamps_are_omitted_when_none() {
        // Absent, not zero: a service that has never fetched has no
        // last-success time, and 0 would read as a success in 1970.
        let body = render("0.1.0", "pi-dev", &status(ServiceState::Idle));
        assert!(!has_series(
            &body,
            "adsb_weather_last_success_timestamp_seconds"
        ));
        assert!(!has_series(
            &body,
            "adsb_weather_next_fetch_timestamp_seconds"
        ));
        assert!(!has_series(
            &body,
            "adsb_weather_snapshot_valid_timestamp_seconds"
        ));
        // The one that is never optional is still there.
        assert!(has_series(
            &body,
            "adsb_weather_status_updated_timestamp_seconds"
        ));
    }

    #[test]
    fn present_timestamps_are_seconds_not_milliseconds() {
        let mut s = status(ServiceState::Idle);
        s.last_success_ms = Some(1_789_412_400_000);
        let body = render("0.1.0", "pi-dev", &s);
        assert_eq!(
            value_of(&body, "adsb_weather_last_success_timestamp_seconds"),
            Some(1_789_412_400.0),
            "{body}"
        );
    }

    #[test]
    fn rate_limit_scope_is_a_label_not_a_value() {
        let mut s = status(ServiceState::RateLimited);
        s.rate_limit = Some(RateLimitScope::Daily);
        let body = render("0.1.0", "pi-dev", &s);

        assert!(
            body.contains(r#"adsb_weather_rate_limited{scope="daily"} 1"#),
            "{body}"
        );
        assert!(
            body.contains(r#"adsb_weather_rate_limited{scope="hourly"} 0"#),
            "{body}"
        );
    }

    #[test]
    fn no_rate_limit_leaves_every_scope_at_zero() {
        let body = render("0.1.0", "pi-dev", &status(ServiceState::Idle));
        for scope in ALL_SCOPES {
            assert!(
                body.contains(&format!(
                    r#"adsb_weather_rate_limited{{scope="{}"}} 0"#,
                    scope_label(scope)
                )),
                "{body}"
            );
        }
    }

    #[test]
    fn enabled_and_state_disagree_while_a_command_is_pending() {
        // The CQRS pending window made visible: the operator has enabled
        // fetching, the loop has not acted yet. An alert can catch a command
        // that never lands.
        let mut s = status(ServiceState::Disabled);
        s.enabled = true;
        let body = render("0.1.0", "pi-dev", &s);

        assert_eq!(value_of(&body, "adsb_weather_enabled"), Some(1.0), "{body}");
        assert!(
            body.contains(r#"adsb_weather_state{state="disabled"} 1"#),
            "{body}"
        );
    }

    #[test]
    fn failures_and_status_version_are_exported() {
        let mut s = status(ServiceState::Retrying);
        s.consecutive_failures = 3;
        let body = render("0.1.0", "pi-dev", &s);
        assert_eq!(
            value_of(&body, "adsb_weather_consecutive_failures"),
            Some(3.0),
            "{body}"
        );
        assert_eq!(
            value_of(&body, "adsb_weather_status_version"),
            Some(f64::from(STATUS_VERSION)),
            "{body}"
        );
    }

    #[test]
    fn the_exposition_carries_this_services_identity() {
        let body = render("0.1.0", "pi-kitchen-prod", &status(ServiceState::Idle));
        assert!(body.contains(r#"service="weather""#), "{body}");
        assert!(body.contains(r#"source_id="pi-kitchen-prod""#), "{body}");
        assert!(body.contains(r#"stage="prod""#), "{body}");
    }

    #[test]
    fn the_last_error_string_is_never_a_label() {
        // Unbounded cardinality, and it belongs to the status API. Prometheus
        // is told *that* it is failing and how often, not the message.
        let mut s = status(ServiceState::Retrying);
        s.last_error = Some("Daily API request limit exceeded".into());
        let body = render("0.1.0", "pi-dev", &s);
        assert!(!body.contains("Daily API request limit"), "{body}");
    }
}
