//! The refresh loop: fetch on a schedule, never lose the last good snapshot.
//!
//! Snapshots leave through a `watch` channel holding the latest one, which is
//! exactly the publisher's job description: it needs the newest grid, not a
//! queue of old ones, and it must be able to re-read it on every reconnect.
//!
//! A failed fetch never clears the channel. The consumer judges staleness from
//! `valid_time_ms`; withdrawing data because the uplink blinked would blank the
//! map for no gain.

use crate::cache;
use crate::grid::GridSpec;
use crate::provider::WeatherProvider;
use crate::snapshot::WeatherSnapshot;
use adsb_pulsar_client::backoff::{Backoff, should_log};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tracing::{info, warn};

/// Source of "now" in epoch milliseconds, injectable so tests can pin the
/// model hour a fetch asks for.
pub type Clock = fn() -> i64;

/// Wall-clock time in epoch milliseconds.
pub fn system_clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Retry pacing after a failed fetch: one minute, doubling, capped at thirty.
pub fn default_retry() -> Backoff {
    Backoff {
        base: Duration::from_secs(60),
        max: Duration::from_secs(30 * 60),
    }
}

/// What the last fetch did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Fetched,
    /// `failures` counts consecutive failures including this one (>= 1).
    Failed {
        failures: u32,
        rate_limited: bool,
    },
}

/// How long to wait before the next fetch.
///
/// - After a success: the refresh interval.
/// - After a failure: exponential retry, but never longer than the refresh
///   interval -- a transient error must not delay data past its normal schedule.
/// - After a rate limit: at least the refresh interval, and at least the retry
///   ceiling. The quota is spent; asking sooner only spends more of it.
pub fn next_delay(outcome: Outcome, refresh: Duration, retry: Backoff) -> Duration {
    match outcome {
        Outcome::Fetched => refresh,
        Outcome::Failed {
            rate_limited: true, ..
        } => refresh.max(retry.max),
        Outcome::Failed { failures, .. } => retry.delay(failures.saturating_sub(1)).min(refresh),
    }
}

/// Drives a [`WeatherProvider`] on a schedule.
pub struct Refresher<P> {
    provider: P,
    grid: GridSpec,
    levels: Vec<u16>,
    refresh: Duration,
    retry: Backoff,
    cache_path: Option<PathBuf>,
    clock: Clock,
}

impl<P: WeatherProvider> Refresher<P> {
    pub fn new(provider: P, grid: GridSpec, levels: Vec<u16>, refresh: Duration) -> Self {
        Self {
            provider,
            grid,
            levels,
            refresh,
            retry: default_retry(),
            cache_path: None,
            clock: system_clock_ms,
        }
    }

    /// Persists every good snapshot to `path` and replays it on start.
    pub fn with_cache(mut self, path: PathBuf) -> Self {
        self.cache_path = Some(path);
        self
    }

    pub fn with_retry(mut self, retry: Backoff) -> Self {
        self.retry = retry;
        self
    }

    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// The cached snapshot, if there is one for *this* grid and level set.
    ///
    /// A cache written before the receiver moved, or before `levels` changed,
    /// describes somewhere or something else. Replaying it would draw winds
    /// over the wrong area until the next fetch, so it is ignored.
    pub fn cached(&self) -> Option<WeatherSnapshot> {
        let path = self.cache_path.as_ref()?;
        match cache::load(path) {
            Ok(Some(snapshot)) if self.matches(&snapshot) => Some(snapshot),
            Ok(Some(_)) => {
                info!(
                    "Ignoring weather cache at {}: it was written for a different grid or level set",
                    path.display()
                );
                None
            }
            Ok(None) => None,
            Err(e) => {
                warn!("Ignoring weather cache at {}: {e}", path.display());
                None
            }
        }
    }

    /// Whether `snapshot` covers this grid and exactly this set of levels.
    /// Config lists levels in any order (usually 850 -> 200); the snapshot's
    /// map is sorted, so compare as sets.
    fn matches(&self, snapshot: &WeatherSnapshot) -> bool {
        let mut wanted = self.levels.clone();
        wanted.sort_unstable();
        wanted.dedup();
        snapshot.grid == self.grid && snapshot.levels.keys().copied().eq(wanted)
    }

    /// Runs until `shutdown` turns true (or its sender is dropped).
    pub async fn run(
        self,
        snapshots: watch::Sender<Option<WeatherSnapshot>>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        if let Some(cached) = self.cached() {
            info!(
                "Replaying cached weather snapshot (valid at {} ms) until the first fetch",
                cached.valid_time_ms
            );
            // send_replace, not send: it stores the value even while nothing is
            // subscribed yet, so a publisher attaching later still starts with it.
            snapshots.send_replace(Some(cached));
        }

        let mut failures: u32 = 0;
        loop {
            if *shutdown.borrow() {
                return;
            }

            let now_ms = (self.clock)();
            let outcome = match self.provider.fetch(self.grid, &self.levels, now_ms).await {
                Ok(snapshot) => {
                    if failures > 0 {
                        info!("Weather fetch recovered after {failures} failure(s)");
                    }
                    failures = 0;
                    if let Some(path) = &self.cache_path
                        && let Err(e) = cache::save(path, &snapshot)
                    {
                        // Non-fatal: the snapshot is still published, it just
                        // will not survive a restart.
                        warn!("Could not write weather cache {}: {e}", path.display());
                    }
                    info!(
                        "Fetched weather from {}: {} points, valid at {} ms",
                        self.provider.name(),
                        snapshot.grid.len(),
                        snapshot.valid_time_ms
                    );
                    snapshots.send_replace(Some(snapshot));
                    Outcome::Fetched
                }
                Err(e) => {
                    failures = failures.saturating_add(1);
                    if should_log(failures - 1) {
                        warn!(
                            "Weather fetch from {} failed ({failures} in a row); \
                             keeping the last good snapshot: {e}",
                            self.provider.name()
                        );
                    }
                    Outcome::Failed {
                        failures,
                        rate_limited: e.is_rate_limited(),
                    }
                }
            };

            // Sleep to a fixed deadline. `changed()` also fires for a `false`
            // that means "keep running"; treating that as a wake-up would fetch
            // early and spend quota.
            let deadline =
                tokio::time::Instant::now() + next_delay(outcome, self.refresh, self.retry);
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => break,
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderError;
    use crate::snapshot::{LevelFields, SNAPSHOT_VERSION, SurfaceFields};
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::{Arc, Mutex};
    use tokio::time::Instant;

    const REFRESH: Duration = Duration::from_secs(60 * 60);

    fn grid() -> GridSpec {
        GridSpec {
            lat0: 47.0,
            lon0: -2.0,
            dlat: 1.0,
            dlon: 1.0,
            nlat: 1,
            nlon: 1,
        }
    }

    fn snapshot_for(grid: GridSpec, levels: &[u16], mslp: f32) -> WeatherSnapshot {
        let n = grid.len();
        WeatherSnapshot {
            version: SNAPSHOT_VERSION,
            source: "fake".into(),
            attribution: "test".into(),
            model: "best_match".into(),
            fetched_at_ms: 0,
            valid_time_ms: 0,
            grid,
            surface: SurfaceFields {
                mslp_hpa: vec![Some(mslp); n],
                wind_speed_kt: vec![None; n],
                wind_dir_deg: vec![None; n],
            },
            levels: levels
                .iter()
                .map(|&l| {
                    let fields = LevelFields {
                        wind_speed_kt: vec![None; n],
                        wind_dir_deg: vec![None; n],
                    };
                    (l, fields)
                })
                .collect::<BTreeMap<_, _>>(),
        }
    }

    fn snapshot(mslp: f32) -> WeatherSnapshot {
        snapshot_for(grid(), &[250], mslp)
    }

    fn http_error() -> ProviderError {
        ProviderError::Http {
            base_url: "fake".into(),
            message: "connection refused".into(),
        }
    }

    fn rate_limited() -> ProviderError {
        ProviderError::Status {
            base_url: "fake".into(),
            status: 429,
        }
    }

    /// Plays back a script of results and records when, and for which "now",
    /// it was asked.
    #[derive(Default)]
    struct Fake {
        script: Mutex<VecDeque<Result<WeatherSnapshot, ProviderError>>>,
        calls: Mutex<Vec<(Instant, i64)>>,
    }

    impl Fake {
        fn scripted(results: Vec<Result<WeatherSnapshot, ProviderError>>) -> Arc<Self> {
            Arc::new(Self {
                script: Mutex::new(results.into()),
                calls: Mutex::default(),
            })
        }

        fn call_count(&self) -> usize {
            self.calls.lock().unwrap().len()
        }

        fn gaps(&self) -> Vec<Duration> {
            let calls = self.calls.lock().unwrap();
            calls.windows(2).map(|w| w[1].0 - w[0].0).collect()
        }
    }

    #[async_trait::async_trait]
    impl WeatherProvider for Arc<Fake> {
        fn name(&self) -> &str {
            "fake"
        }

        async fn fetch(
            &self,
            _grid: GridSpec,
            _levels: &[u16],
            now_ms: i64,
        ) -> Result<WeatherSnapshot, ProviderError> {
            self.calls.lock().unwrap().push((Instant::now(), now_ms));
            self.script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(http_error()))
        }
    }

    struct Running {
        snapshots: watch::Receiver<Option<WeatherSnapshot>>,
        shutdown: watch::Sender<bool>,
        task: tokio::task::JoinHandle<()>,
    }

    fn start(refresher: Refresher<Arc<Fake>>) -> Running {
        let (snap_tx, snapshots) = watch::channel(None);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(refresher.run(snap_tx, shutdown_rx));
        Running {
            snapshots,
            shutdown,
            task,
        }
    }

    /// Lets the paused clock advance until the fake has been called `n` times.
    ///
    /// Bounded in virtual time: if the loop dies (a panic in a spawned task is
    /// silent), polling would otherwise spin forever on a paused clock instead
    /// of failing. A day is far beyond any schedule these tests exercise.
    async fn until_calls(fake: &Fake, n: usize) {
        tokio::time::timeout(Duration::from_secs(24 * 3600), async {
            while fake.call_count() < n {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("provider called {} times, expected {n}", fake.call_count()));
    }

    // --- next_delay ---------------------------------------------------------

    #[test]
    fn after_success_wait_the_refresh_interval() {
        assert_eq!(
            next_delay(Outcome::Fetched, REFRESH, default_retry()),
            REFRESH
        );
    }

    #[test]
    fn after_failures_back_off_exponentially() {
        let failed = |failures| Outcome::Failed {
            failures,
            rate_limited: false,
        };
        let retry = default_retry();
        assert_eq!(
            next_delay(failed(1), REFRESH, retry),
            Duration::from_secs(60)
        );
        assert_eq!(
            next_delay(failed(2), REFRESH, retry),
            Duration::from_secs(120)
        );
        assert_eq!(next_delay(failed(10), REFRESH, retry), retry.max);
    }

    #[test]
    fn a_retry_never_waits_longer_than_a_refresh() {
        let short_refresh = Duration::from_secs(10 * 60);
        let outcome = Outcome::Failed {
            failures: 10,
            rate_limited: false,
        };
        assert_eq!(
            next_delay(outcome, short_refresh, default_retry()),
            short_refresh
        );
    }

    #[test]
    fn a_rate_limit_waits_at_least_a_refresh_and_the_retry_ceiling() {
        let outcome = Outcome::Failed {
            failures: 1,
            rate_limited: true,
        };
        let retry = default_retry();
        assert_eq!(next_delay(outcome, REFRESH, retry), REFRESH);
        assert_eq!(
            next_delay(outcome, Duration::from_secs(10 * 60), retry),
            retry.max
        );
    }

    // --- run ----------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn publishes_each_successful_fetch() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);
        let mut running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));

        running.snapshots.changed().await.unwrap();
        assert_eq!(*running.snapshots.borrow(), Some(snapshot(1013.0)));
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn fetches_with_the_injected_clock() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);
        let running = start(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH)
                .with_clock(|| 1_789_413_000_000),
        );
        until_calls(&fake, 1).await;
        assert_eq!(fake.calls.lock().unwrap()[0].1, 1_789_413_000_000);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_keeps_the_last_good_snapshot() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0)), Err(http_error())]);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));

        until_calls(&fake, 2).await;
        tokio::task::yield_now().await;
        assert_eq!(*running.snapshots.borrow(), Some(snapshot(1013.0)));
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn waits_a_full_refresh_after_success_and_backs_off_after_errors() {
        let fake = Fake::scripted(vec![
            Ok(snapshot(1013.0)),
            Err(http_error()),
            Err(http_error()),
            Ok(snapshot(1012.0)),
        ]);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));

        until_calls(&fake, 5).await;
        assert_eq!(
            fake.gaps(),
            vec![
                REFRESH,                  // success -> full interval
                Duration::from_secs(60),  // first failure
                Duration::from_secs(120), // second failure
                REFRESH,                  // recovered -> full interval again
            ]
        );
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limit_waits_a_full_refresh() {
        let fake = Fake::scripted(vec![Err(rate_limited()), Ok(snapshot(1013.0))]);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));

        until_calls(&fake, 2).await;
        assert_eq!(fake.gaps(), vec![REFRESH]);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_successful_fetch_is_written_to_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weather-cache.json");
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);
        let mut running = start(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH).with_cache(path.clone()),
        );

        running.snapshots.changed().await.unwrap();
        assert_eq!(cache::load(&path).unwrap(), Some(snapshot(1013.0)));
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn the_cached_snapshot_is_published_before_the_first_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weather-cache.json");
        cache::save(&path, &snapshot(1001.0)).unwrap();

        // The uplink is down: every fetch fails. The map must still get data.
        let fake = Fake::scripted(vec![Err(http_error())]);
        let running = start(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH).with_cache(path.clone()),
        );

        until_calls(&fake, 1).await;
        assert_eq!(*running.snapshots.borrow(), Some(snapshot(1001.0)));
        running.task.abort();
    }

    #[test]
    fn a_cache_for_another_grid_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weather-cache.json");
        let moved = GridSpec {
            lat0: 50.0,
            ..grid()
        };
        cache::save(&path, &snapshot_for(moved, &[250], 1001.0)).unwrap();

        let refresher =
            Refresher::new(Fake::scripted(vec![]), grid(), vec![250], REFRESH).with_cache(path);
        assert_eq!(refresher.cached(), None);
    }

    #[test]
    fn a_cache_for_other_levels_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weather-cache.json");
        cache::save(&path, &snapshot_for(grid(), &[850], 1001.0)).unwrap();

        let refresher =
            Refresher::new(Fake::scripted(vec![]), grid(), vec![250], REFRESH).with_cache(path);
        assert_eq!(refresher.cached(), None);
    }

    #[test]
    fn a_matching_cache_is_used() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weather-cache.json");
        cache::save(&path, &snapshot(1001.0)).unwrap();

        let refresher =
            Refresher::new(Fake::scripted(vec![]), grid(), vec![250], REFRESH).with_cache(path);
        assert_eq!(refresher.cached(), Some(snapshot(1001.0)));
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_stops_the_loop() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));
        until_calls(&fake, 1).await;

        running.shutdown.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), running.task)
            .await
            .expect("loop must exit on shutdown")
            .unwrap();
    }
}
