//! Prometheus exposition, shared by every ADS-B service.
//!
//! This module owns the two things all of them must agree on: the wire
//! content type, and the `adsb_build_info` identity series. Everything else —
//! which counters exist, and what they mean — belongs to the service that
//! registers them into [`Exporter::registry`].
//!
//! # Why a local registry
//!
//! [`Registry::new`] rather than `prometheus::default_registry()`. A global
//! registry makes tests order-dependent and double-registers when two of them
//! build a server in one process, which the weather crate's integration tests
//! already do.
//!
//! # Why identity is one series and not a label on every metric
//!
//! `source_id` on all ~30 series would be bytes on every scrape, cardinality
//! in the database, and series churn the day someone renames a receiver. As a
//! single always-`1` gauge it is joined at query time instead:
//!
//! ```promql
//! rate(adsb_feed_messages_received_total[1m])
//!   * on(instance) group_left(source_id) adsb_build_info
//! ```

use prometheus::{Encoder, Gauge, IntGauge, IntGaugeVec, Opts, Registry, TextEncoder};

/// The Prometheus text exposition content type, including its version
/// parameter.
///
/// Part of the wire contract: a scrape served as `text/html` is rejected.
pub fn content_type() -> String {
    TextEncoder::new().format_type().to_string()
}

/// The stage half of a receiver id, by the `<host-or-site>-<stage>` convention.
///
/// Read exactly as `make doctor` reads it (`${id##*-}`): the text after the
/// last `-`. An id with no `-` has no stage, and returns `""` — which
/// Prometheus treats as an absent label rather than a distinct value.
pub fn stage_of(source_id: &str) -> &str {
    match source_id.rsplit_once('-') {
        Some((_, stage)) => stage,
        None => "",
    }
}

/// A metrics registry plus the identity series every ADS-B process exposes.
pub struct Exporter {
    registry: Registry,
}

impl Exporter {
    /// Build an exporter for one service, registering `adsb_build_info`.
    ///
    /// `service` is the short name used as the metric prefix elsewhere
    /// (`feed`, `recorder`, `weather`, …); `source_id` is the receiver
    /// identity from the stack config, whose suffix supplies `stage`.
    pub fn new(service: &str, version: &str, source_id: &str) -> Self {
        let registry = Registry::new();
        let info = IntGaugeVec::new(
            Opts::new(
                "adsb_build_info",
                "Identity and version of this ADS-B process; always 1.",
            ),
            &["service", "version", "source_id", "stage"],
        )
        .expect("static metric definition");
        info.with_label_values(&[service, version, source_id, stage_of(source_id)])
            .set(1);
        registry
            .register(Box::new(info))
            .expect("nothing else is registered yet");
        Self { registry }
    }

    /// The registry, for a service to register its own metrics into.
    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// Register an integer gauge holding one fixed value.
    pub fn int_gauge(&self, name: &str, help: &str, value: i64) {
        let gauge = IntGauge::new(name, help).expect("static metric definition");
        gauge.set(value);
        self.register(Box::new(gauge));
    }

    /// Register a floating-point gauge holding one fixed value.
    pub fn gauge(&self, name: &str, help: &str, value: f64) {
        let gauge = Gauge::new(name, help).expect("static metric definition");
        gauge.set(value);
        self.register(Box::new(gauge));
    }

    /// Register an epoch-**milliseconds** field as epoch **seconds** — or, when
    /// it is `None`, register nothing at all.
    ///
    /// Seconds because that is the Prometheus convention and what `time() - x`
    /// expects. Omitted rather than zeroed because absent and "1970" are
    /// different facts: a recorder with no rows has no oldest record, and a
    /// zero would make `time() - oldest` a plausible-looking 56 years.
    pub fn timestamp_seconds(&self, name: &str, help: &str, ms: Option<i64>) {
        let Some(ms) = ms else { return };
        self.gauge(name, help, ms as f64 / 1000.0);
    }

    /// Register a **state set**: one series per `values` entry, carrying
    /// `label`, with the matching one at `1` and the rest at `0`.
    ///
    /// Preferred over an enum-valued gauge because it is self-describing, it
    /// alerts on a name rather than a magic number, and adding a member cannot
    /// silently change what an existing alert means.
    pub fn gauge_set(&self, name: &str, help: &str, label: &str, values: &[(&str, bool)]) {
        let set =
            IntGaugeVec::new(Opts::new(name, help), &[label]).expect("static metric definition");
        for (value, active) in values {
            set.with_label_values(&[value]).set(i64::from(*active));
        }
        self.register(Box::new(set));
    }

    fn register(&self, collector: Box<dyn prometheus::core::Collector>) {
        self.registry
            .register(collector)
            .expect("each metric name is registered once per exporter");
    }

    /// Render the exposition body.
    ///
    /// An encoding error is reported as a comment rather than propagated, so a
    /// scrape still distinguishes "process alive, metrics broken" from
    /// "process gone" — the latter is what `up == 0` already means.
    pub fn encode(&self) -> String {
        // The `Vec` form, not `encode_to_string`: the latter only exists in
        // later 0.13 patch releases, and the lockfile is not the only place
        // this crate gets built from.
        let mut buf = Vec::with_capacity(4096);
        match TextEncoder::new().encode(&self.registry.gather(), &mut buf) {
            Ok(()) => String::from_utf8(buf).unwrap_or_default(),
            Err(e) => format!("# encoding error: {e}\n"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_content_type_names_the_exposition_version() {
        // The version parameter is part of the contract, not decoration.
        assert_eq!(content_type(), "text/plain; version=0.0.4");
    }

    #[test]
    fn stage_is_taken_from_the_source_id_suffix() {
        assert_eq!(stage_of("dev-laptop-dev"), "dev");
        assert_eq!(stage_of("pi-kitchen-prod"), "prod");
    }

    #[test]
    fn a_source_id_without_a_stage_has_an_empty_stage() {
        // Prometheus treats an empty label value as absent, which is the
        // honest answer for an id that carries no stage.
        assert_eq!(stage_of("laptop"), "");
    }

    #[test]
    fn build_info_is_always_one_and_carries_identity() {
        let exporter = Exporter::new("feed", "0.1.0", "dev-laptop-dev");
        let body = exporter.encode();

        assert!(body.contains("# TYPE adsb_build_info gauge"), "{body}");
        assert!(body.contains(r#"service="feed""#), "{body}");
        assert!(body.contains(r#"version="0.1.0""#), "{body}");
        assert!(body.contains(r#"source_id="dev-laptop-dev""#), "{body}");
        assert!(body.contains(r#"stage="dev""#), "{body}");
        // The value carries no information; the labels do.
        assert!(
            body.lines()
                .any(|l| l.starts_with("adsb_build_info{") && l.ends_with(" 1")),
            "build_info must be exactly 1: {body}"
        );
    }

    #[test]
    fn a_fresh_exporter_exposes_only_its_identity_series() {
        // Guards against something being registered here that belongs to a
        // service: this module is shared by all of them.
        let exporter = Exporter::new("recorder", "0.1.0", "pi-prod");
        let metric_lines: Vec<_> = exporter
            .encode()
            .lines()
            .filter(|l| !l.starts_with('#') && !l.is_empty())
            .map(str::to_string)
            .collect();
        assert_eq!(metric_lines.len(), 1, "{metric_lines:?}");
    }

    #[test]
    fn an_int_gauge_is_exposed_with_its_value() {
        let exporter = Exporter::new("feed", "0.1.0", "dev-laptop-dev");
        exporter.int_gauge("adsb_feed_retry_queue_messages", "Queued.", 7);
        assert!(
            exporter
                .encode()
                .contains("adsb_feed_retry_queue_messages 7")
        );
    }

    #[test]
    fn a_timestamp_is_converted_from_milliseconds_to_seconds() {
        let exporter = Exporter::new("feed", "0.1.0", "dev-laptop-dev");
        exporter.timestamp_seconds(
            "adsb_feed_start_time_seconds",
            "Start.",
            Some(1_789_412_400_000),
        );
        assert!(
            exporter
                .encode()
                .contains("adsb_feed_start_time_seconds 1789412400")
        );
    }

    #[test]
    fn an_absent_timestamp_registers_no_series_at_all() {
        // Absent and "1970" are different facts. Zero would read as a real
        // instant and make `time() - x` a plausible-looking 56 years.
        let exporter = Exporter::new("feed", "0.1.0", "dev-laptop-dev");
        exporter.timestamp_seconds("adsb_feed_start_time_seconds", "Start.", None);
        assert!(!exporter.encode().contains("adsb_feed_start_time_seconds"));
    }

    #[test]
    fn a_gauge_set_marks_one_member_and_zeroes_the_rest() {
        let exporter = Exporter::new("weather", "0.1.0", "pi-prod");
        exporter.gauge_set(
            "adsb_weather_state",
            "State.",
            "state",
            &[("idle", false), ("fetching", true), ("disabled", false)],
        );
        let body = exporter.encode();

        assert!(
            body.contains(r#"adsb_weather_state{state="fetching"} 1"#),
            "{body}"
        );
        assert!(
            body.contains(r#"adsb_weather_state{state="idle"} 0"#),
            "{body}"
        );
        // Every member is present, so a member dropping to zero is visible
        // rather than the series simply vanishing.
        assert!(
            body.contains(r#"adsb_weather_state{state="disabled"} 0"#),
            "{body}"
        );
    }

    #[test]
    fn a_service_metric_registered_into_it_is_exposed() {
        let exporter = Exporter::new("feed", "0.1.0", "dev-laptop-dev");
        let counter = prometheus::IntCounter::new("adsb_feed_errors_total", "Errors.")
            .expect("static metric definition");
        counter.inc();
        exporter
            .registry()
            .register(Box::new(counter))
            .expect("fresh registry");

        assert!(exporter.encode().contains("adsb_feed_errors_total 1"));
    }
}
