//! The recorder's Prometheus projection, and the cache it reads.
//!
//! # Why the statistics are cached rather than queried per scrape
//!
//! [`adsb_data_engine`]'s `get_stats` runs several full-table aggregates under
//! the same lock the ingest path holds. Querying it from the scrape handler
//! would mean Prometheus's cadence — plus every human hitting `/metrics`,
//! every retry after a timeout, and any second scraper — costing recorded
//! messages. The recorder's one job is not to drop them.
//!
//! It also keeps the handler bounded. A stats query over a multi-GB database
//! on a Pi can take seconds; past `scrape_timeout` the whole scrape fails, and
//! the failure mode is *all* metrics missing, including the ones that would
//! explain why.
//!
//! The staleness that buys is small and, more importantly, visible:
//! `adsb_recorder_stats_age_seconds` and
//! `adsb_recorder_stats_query_duration_seconds` are exported alongside, so
//! nobody has to guess how old the numbers are. A 15-second-old row count is
//! not meaningfully different from a live one.

use adsb_data_engine::{SharedStorage, StorageStats};
use adsb_pulsar_client::metrics_export::Exporter;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tracing::warn;

/// How often the cache refreshes. Well under a typical 15 s scrape interval's
/// tolerance for staleness, and far above what the query costs.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(15);

/// A cached [`StorageStats`], with how old it is and what it cost to get.
#[derive(Debug, Clone)]
pub struct CachedStats {
    pub stats: StorageStats,
    pub age: Duration,
    pub query_duration: Duration,
}

/// The shared cache the scrape handler reads and the refresher writes.
///
/// A `std::sync::RwLock` rather than tokio's: the critical section is a clone
/// of a ten-field struct, so an async lock would buy nothing and force the
/// handler to await.
#[derive(Clone, Default)]
pub struct StatsCache {
    inner: Arc<RwLock<Option<(StorageStats, Instant, Duration)>>>,
}

impl StatsCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The current snapshot, or `None` when no query has succeeded yet.
    pub fn snapshot(&self) -> Option<CachedStats> {
        let guard = self.inner.read().ok()?;
        let (stats, taken_at, query_duration) = guard.as_ref()?;
        Some(CachedStats {
            stats: stats.clone(),
            age: taken_at.elapsed(),
            query_duration: *query_duration,
        })
    }

    fn store(&self, stats: StorageStats, query_duration: Duration) {
        if let Ok(mut guard) = self.inner.write() {
            *guard = Some((stats, Instant::now(), query_duration));
        }
    }

    /// Forget the cached statistics, so a scrape reports storage as down.
    fn clear(&self) {
        if let Ok(mut guard) = self.inner.write() {
            *guard = None;
        }
    }

    /// Refresh the cache every [`REFRESH_INTERVAL`] until the task is dropped.
    ///
    /// The first tick fires immediately, so a scrape arriving shortly after
    /// startup already has numbers.
    pub async fn run(self, storage: SharedStorage, interval: Duration) {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            let started = Instant::now();
            match crate::tool_service::get_storage_stats(&storage).await {
                Ok(stats) => self.store(stats, started.elapsed()),
                Err(e) => {
                    // Reporting storage as down beats serving numbers whose
                    // age nobody can bound.
                    warn!("Storage statistics unavailable for /metrics: {e}");
                    self.clear();
                }
            }
        }
    }
}

/// Render the exposition for a cached snapshot, or for no snapshot at all.
pub fn render(version: &str, source_id: &str, cached: Option<&CachedStats>) -> String {
    let exporter = Exporter::new("recorder", version, source_id);

    exporter.int_gauge(
        "adsb_recorder_storage_up",
        "1 when the database is open and the last statistics query succeeded.",
        i64::from(cached.is_some()),
    );

    // No snapshot: identity and `storage_up 0` only. Exporting zeroed counts
    // would be indistinguishable from an empty database, and a recorder whose
    // stats query is failing is not an empty recorder.
    let Some(cached) = cached else {
        return exporter.encode();
    };
    let stats = &cached.stats;

    exporter.int_gauge(
        "adsb_recorder_positions_rows",
        "Rows in the positions table.",
        count(stats.row_count),
    );
    exporter.int_gauge(
        "adsb_recorder_db_size_bytes",
        "On-disk size of the positions database.",
        count(stats.db_size_bytes),
    );
    exporter.int_gauge(
        "adsb_recorder_raw_messages_rows",
        "Rows in the raw SBS-1 message table.",
        count(stats.raw_message_count),
    );
    exporter.int_gauge(
        "adsb_recorder_raw_db_size_bytes",
        "On-disk size of the raw message table.",
        count(stats.raw_db_size_bytes),
    );
    exporter.int_gauge(
        "adsb_recorder_flights_rows",
        "Rows in the flights table.",
        count(stats.flight_count),
    );
    exporter.int_gauge(
        "adsb_recorder_flights_size_bytes",
        "On-disk size of the flights table.",
        count(stats.flight_size_bytes),
    );
    exporter.int_gauge(
        "adsb_recorder_status_events_rows",
        "Rows in the status event table.",
        count(stats.status_event_count),
    );
    exporter.int_gauge(
        "adsb_recorder_events_of_interest_rows",
        "User-created events of interest.",
        count(stats.event_of_interest_count),
    );
    exporter.int_gauge(
        "adsb_recorder_weather_snapshots_rows",
        "Stored weather snapshots, one per model hour.",
        count(stats.weather_snapshot_count),
    );

    exporter.timestamp_seconds(
        "adsb_recorder_oldest_record_timestamp_seconds",
        "Timestamp of the oldest recorded position.",
        stats.oldest_timestamp_ms,
    );
    exporter.timestamp_seconds(
        "adsb_recorder_newest_record_timestamp_seconds",
        "Timestamp of the newest recorded position.",
        stats.newest_timestamp_ms,
    );

    // The cache, made honest about itself.
    exporter.gauge(
        "adsb_recorder_stats_age_seconds",
        "Age of the cached storage statistics.",
        cached.age.as_secs_f64(),
    );
    exporter.gauge(
        "adsb_recorder_stats_query_duration_seconds",
        "How long the last storage statistics query took.",
        cached.query_duration.as_secs_f64(),
    );

    exporter.encode()
}

/// Counts are `u64` on the way in and gauges on the way out.
///
/// Saturating rather than wrapping: the values here cannot reach `i64::MAX` in
/// practice, and a silently negative row count would be worse than a pinned one.
fn count(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats() -> StorageStats {
        StorageStats {
            row_count: 1_234,
            db_size_bytes: 5_000_000,
            oldest_timestamp_ms: Some(1_789_412_400_000),
            newest_timestamp_ms: Some(1_789_416_000_000),
            raw_message_count: 9_000,
            raw_db_size_bytes: 2_000_000,
            flight_count: 42,
            flight_size_bytes: 3_000,
            status_event_count: 7,
            event_of_interest_count: 2,
            weather_snapshot_count: 24,
        }
    }

    fn cached(stats: StorageStats) -> CachedStats {
        CachedStats {
            stats,
            age: Duration::from_millis(1_500),
            query_duration: Duration::from_millis(250),
        }
    }

    fn value_of(body: &str, metric: &str) -> Option<f64> {
        body.lines()
            .find(|l| l.starts_with(&format!("{metric} ")))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
    }

    #[test]
    fn before_the_first_query_storage_is_down_and_no_stats_are_exported() {
        let body = render("0.1.0", "pi-prod", None);
        assert_eq!(
            value_of(&body, "adsb_recorder_storage_up"),
            Some(0.0),
            "{body}"
        );
        assert!(!body.contains("adsb_recorder_positions_rows"), "{body}");
        assert!(!body.contains("adsb_recorder_stats_age_seconds"), "{body}");
    }

    #[test]
    fn identity_is_exported_even_when_storage_is_down() {
        // A target that is up but degraded must still be identifiable, or the
        // one series that says so cannot be joined to anything.
        let body = render("0.1.0", "pi-kitchen-prod", None);
        assert!(body.contains(r#"service="recorder""#), "{body}");
        assert!(body.contains(r#"source_id="pi-kitchen-prod""#), "{body}");
        assert!(body.contains(r#"stage="prod""#), "{body}");
    }

    #[test]
    fn a_cached_snapshot_exports_every_storage_gauge() {
        let body = render("0.1.0", "pi-prod", Some(&cached(stats())));
        assert_eq!(value_of(&body, "adsb_recorder_storage_up"), Some(1.0));
        assert_eq!(
            value_of(&body, "adsb_recorder_positions_rows"),
            Some(1234.0)
        );
        assert_eq!(
            value_of(&body, "adsb_recorder_db_size_bytes"),
            Some(5_000_000.0)
        );
        assert_eq!(
            value_of(&body, "adsb_recorder_raw_messages_rows"),
            Some(9000.0)
        );
        assert_eq!(
            value_of(&body, "adsb_recorder_raw_db_size_bytes"),
            Some(2_000_000.0)
        );
        assert_eq!(value_of(&body, "adsb_recorder_flights_rows"), Some(42.0));
        assert_eq!(
            value_of(&body, "adsb_recorder_flights_size_bytes"),
            Some(3000.0)
        );
        assert_eq!(
            value_of(&body, "adsb_recorder_status_events_rows"),
            Some(7.0)
        );
        assert_eq!(
            value_of(&body, "adsb_recorder_events_of_interest_rows"),
            Some(2.0)
        );
    }

    #[test]
    fn record_timestamps_are_seconds_not_milliseconds() {
        let body = render("0.1.0", "pi-prod", Some(&cached(stats())));
        assert_eq!(
            value_of(&body, "adsb_recorder_oldest_record_timestamp_seconds"),
            Some(1_789_412_400.0),
            "{body}"
        );
        assert_eq!(
            value_of(&body, "adsb_recorder_newest_record_timestamp_seconds"),
            Some(1_789_416_000.0),
            "{body}"
        );
    }

    #[test]
    fn an_empty_database_emits_no_record_timestamps() {
        // No rows means no oldest record. Zero would plot as 1970 and make
        // `time() - newest` look like a finite, enormous recording lag.
        let empty = StorageStats {
            row_count: 0,
            oldest_timestamp_ms: None,
            newest_timestamp_ms: None,
            ..stats()
        };
        let body = render("0.1.0", "pi-prod", Some(&cached(empty)));

        assert_eq!(value_of(&body, "adsb_recorder_positions_rows"), Some(0.0));
        assert!(
            !body.contains("adsb_recorder_oldest_record_timestamp_seconds"),
            "{body}"
        );
        assert!(
            !body.contains("adsb_recorder_newest_record_timestamp_seconds"),
            "{body}"
        );
    }

    #[test]
    fn the_cache_reports_its_own_age_and_cost() {
        // The honesty half of caching: without these, nobody can tell whether
        // a flat row count means "no traffic" or "the refresher died".
        let body = render("0.1.0", "pi-prod", Some(&cached(stats())));
        assert_eq!(
            value_of(&body, "adsb_recorder_stats_age_seconds"),
            Some(1.5)
        );
        assert_eq!(
            value_of(&body, "adsb_recorder_stats_query_duration_seconds"),
            Some(0.25)
        );
    }

    #[test]
    fn a_fresh_cache_has_no_snapshot() {
        assert!(StatsCache::new().snapshot().is_none());
    }

    #[test]
    fn a_stored_snapshot_is_returned_and_ages() {
        let cache = StatsCache::new();
        cache.store(stats(), Duration::from_millis(10));
        let snap = cache.snapshot().expect("a snapshot was stored");
        assert_eq!(snap.stats.row_count, 1_234);
        assert_eq!(snap.query_duration, Duration::from_millis(10));
    }

    #[test]
    fn clearing_the_cache_makes_storage_report_down() {
        let cache = StatsCache::new();
        cache.store(stats(), Duration::from_millis(10));
        cache.clear();
        assert!(cache.snapshot().is_none());
    }

    #[test]
    fn the_cache_is_shared_not_copied() {
        // The refresher writes through its clone; the handler must see it.
        let cache = StatsCache::new();
        let handler_side = cache.clone();
        cache.store(stats(), Duration::from_millis(10));
        assert!(handler_side.snapshot().is_some());
    }
}
