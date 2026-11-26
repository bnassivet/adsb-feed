//! The OpenSky service's Prometheus projection: [`OpenSkyStatus`] as metrics.
//!
//! Projected per scrape from the same status `GET /v1/status` serves, as the
//! weather service does. One metric name per credit bucket rather than a
//! `bucket` label: the shared exporter's helpers have no labelled gauge, and
//! two names cost nothing.

use crate::status::{OpenSkyStatus, ServiceState};
use adsb_pulsar_client::metrics_export::Exporter;

pub const ALL_STATES: [ServiceState; 7] = [
    ServiceState::Idle,
    ServiceState::Polling,
    ServiceState::Waiting,
    ServiceState::Retrying,
    ServiceState::RateLimited,
    ServiceState::Unauthorized,
    ServiceState::Disabled,
];

/// Exhaustive on purpose: a new state fails to compile here.
fn state_label(state: ServiceState) -> &'static str {
    match state {
        ServiceState::Idle => "idle",
        ServiceState::Polling => "polling",
        ServiceState::Waiting => "waiting",
        ServiceState::Retrying => "retrying",
        ServiceState::RateLimited => "rate_limited",
        ServiceState::Unauthorized => "unauthorized",
        ServiceState::Disabled => "disabled",
    }
}

pub fn render(version: &str, source_id: &str, status: &OpenSkyStatus) -> String {
    let e = Exporter::new("opensky", version, source_id);
    let c = &status.credits;

    e.int_gauge(
        "adsb_opensky_enabled",
        "The desired setting: 1 when polling is enabled.",
        i64::from(status.enabled),
    );
    e.int_gauge(
        "adsb_opensky_authenticated",
        "1 when the service has OpenSky credentials.",
        i64::from(status.authenticated),
    );
    e.gauge_set(
        "adsb_opensky_state",
        "What the poller is doing; 1 on the current state.",
        "state",
        &ALL_STATES.map(|s| (state_label(s), s == status.state)),
    );
    e.int_gauge(
        "adsb_opensky_daily_credit_limit",
        "Daily credits the service budgets against, per bucket.",
        i64::from(c.daily_limit),
    );
    e.int_gauge(
        "adsb_opensky_states_credits_used_24h",
        "/states credits this service spent in the last 24 hours.",
        i64::from(c.states_used_24h),
    );
    e.int_gauge(
        "adsb_opensky_tracks_credits_used_24h",
        "/tracks credits this service spent in the last 24 hours.",
        i64::from(c.tracks_used_24h),
    );
    if let Some(r) = c.states_remaining {
        e.int_gauge(
            "adsb_opensky_states_credits_remaining",
            "OpenSky's own remaining /states count, from its last reply.",
            r,
        );
    }
    if let Some(r) = c.tracks_remaining {
        e.int_gauge(
            "adsb_opensky_tracks_credits_remaining",
            "OpenSky's own remaining /tracks count, from its last reply.",
            r,
        );
    }
    e.int_gauge(
        "adsb_opensky_watched_aircraft",
        "Aircraft watched over every live lease.",
        status.watch.icao24 as i64,
    );
    e.int_gauge(
        "adsb_opensky_watched_areas",
        "Areas watched over every live lease.",
        status.watch.areas as i64,
    );
    e.int_gauge(
        "adsb_opensky_cycle_cost_credits",
        "What one poll cycle costs.",
        i64::from(status.cycle_cost),
    );
    if let Some(i) = status.interval_seconds {
        e.gauge(
            "adsb_opensky_poll_interval_seconds",
            "The interval the poller plans between cycles.",
            i,
        );
    }
    e.int_gauge(
        "adsb_opensky_consecutive_failures",
        "Consecutive failed polls; zero after a success.",
        i64::from(status.consecutive_failures),
    );
    e.timestamp_seconds(
        "adsb_opensky_last_success_timestamp_seconds",
        "When the last poll succeeded.",
        status.last_success_ms,
    );
    e.timestamp_seconds(
        "adsb_opensky_rate_limited_until_timestamp_seconds",
        "When an OpenSky rate limit lifts, while one is in force.",
        status.rate_limited_until_ms,
    );
    e.encode()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value_of(body: &str, metric: &str) -> Option<f64> {
        body.lines()
            .find(|l| l.starts_with(metric) && !l.starts_with('#'))
            .and_then(|l| l.rsplit(' ').next())
            .and_then(|v| v.parse().ok())
    }

    #[test]
    fn credits_and_watch_are_exported() {
        let mut s = OpenSkyStatus::initial(true, true, 4_000, 0);
        s.credits.states_used_24h = 120;
        s.credits.states_remaining = Some(3_870);
        s.watch.icao24 = 2;
        let body = render("0.1.0", "pi-dev", &s);
        assert_eq!(
            value_of(&body, "adsb_opensky_states_credits_used_24h"),
            Some(120.0)
        );
        assert_eq!(
            value_of(&body, "adsb_opensky_states_credits_remaining"),
            Some(3_870.0)
        );
        assert_eq!(value_of(&body, "adsb_opensky_watched_aircraft"), Some(2.0));
        assert!(body.contains("adsb_build_info{service=\"opensky\""));
    }

    #[test]
    fn exactly_one_state_is_one() {
        let s = OpenSkyStatus::initial(true, true, 4_000, 0);
        let body = render("0.1.0", "pi-dev", &s);
        let ones = body
            .lines()
            .filter(|l| l.starts_with("adsb_opensky_state{") && l.ends_with(" 1"))
            .count();
        assert_eq!(ones, 1);
        assert!(body.contains("adsb_opensky_state{state=\"idle\"} 1"));
    }

    #[test]
    fn unknown_values_are_absent_not_zero() {
        let s = OpenSkyStatus::initial(true, false, 400, 0);
        let body = render("0.1.0", "pi-dev", &s);
        assert!(!body.contains("adsb_opensky_states_credits_remaining"));
        assert!(!body.contains("adsb_opensky_last_success_timestamp_seconds"));
        assert!(!body.contains("adsb_opensky_poll_interval_seconds"));
    }
}
