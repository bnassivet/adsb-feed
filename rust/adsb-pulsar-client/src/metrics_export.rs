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

use prometheus::{Encoder, IntGaugeVec, Opts, Registry, TextEncoder};

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
