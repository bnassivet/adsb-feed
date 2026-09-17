//! The refresh loop: fetch on a schedule, never lose the last good snapshot.
//!
//! Snapshots leave through a `watch` channel holding the latest one, which is
//! exactly the publisher's job description: it needs the newest grid, not a
//! queue of old ones, and it must be able to re-read it on every reconnect.
//!
//! A failed fetch never clears the channel. The consumer judges staleness from
//! `valid_time_ms`; withdrawing data because the uplink blinked would blank the
//! map for no gain.
//!
//! The loop reads the operator's *desired* setting and is the only writer of
//! the *reported* state. It never decides what the operator wants; it only
//! reports what it is doing about it.

use crate::cache;
use crate::grid::GridSpec;
use crate::provider::{ErrorClass, WeatherProvider};
use crate::snapshot::WeatherSnapshot;
use crate::state_file::StateStore;
use crate::status::{RateLimitScope, ServiceState};
use adsb_pulsar_client::backoff::{Backoff, should_log};
use std::path::PathBuf;
use std::sync::Arc;
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
        class: ErrorClass,
    },
}

/// Source of jitter: a fraction in `[0.0, 1.0]`, injectable so tests can pin
/// it. `1.0` means no jitter; see [`next_delay`].
pub type Jitter = fn() -> f64;

/// Uniform jitter.
pub fn random_jitter() -> f64 {
    fastrand::f64()
}

/// No jitter: every delay is its nominal value.
pub fn no_jitter() -> f64 {
    1.0
}

/// How long a minutely rate limit lasts.
pub const MINUTE_WINDOW: Duration = Duration::from_secs(60);

/// Longest wait after a daily rate limit.
///
/// Open-Meteo does not document when its daily counter resets. Waiting for
/// the next UTC midnight is the guess, but if the window is rolling instead,
/// a refused recheck a few times a day costs almost nothing, while waiting
/// another full day would leave the map without fresh weather for no reason.
pub const DAILY_RECHECK: Duration = Duration::from_secs(6 * 3600);

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// How long to wait before the next fetch. `now_ms` is UTC epoch time;
/// `jitter` is a fraction in `[0.0, 1.0]`, where `1.0` means no jitter.
///
/// - Success: the refresh interval.
/// - Transient failure: exponential retry, never longer than the refresh
///   interval, so a blip cannot delay data past its normal schedule. Jitter
///   shortens it by up to half, so nodes sharing an uplink do not retry in
///   lockstep.
/// - Rejected: the refresh interval. The same request would be refused again.
/// - Rate limited: until the window the provider named rolls over, and never
///   sooner than its `Retry-After`. Hourly, daily and unknown limits also wait
///   at least a refresh. Jitter only ever *lengthens* this wait, by up to 10%:
///   arriving early just gets refused again.
pub fn next_delay(
    outcome: Outcome,
    refresh: Duration,
    retry: Backoff,
    now_ms: i64,
    jitter: f64,
) -> Duration {
    let u = jitter.clamp(0.0, 1.0);
    match outcome {
        Outcome::Fetched => refresh,
        Outcome::Failed {
            failures,
            class: ErrorClass::Transient,
        } => {
            let nominal = retry.delay(failures.saturating_sub(1)).min(refresh);
            nominal.mul_f64(0.5 + 0.5 * u)
        }
        Outcome::Failed {
            class: ErrorClass::Rejected,
            ..
        } => refresh,
        Outcome::Failed {
            class: ErrorClass::RateLimited { scope, retry_after },
            ..
        } => {
            let window = match scope {
                RateLimitScope::Minutely => MINUTE_WINDOW,
                RateLimitScope::Hourly => until_next(now_ms, HOUR_MS).max(refresh),
                RateLimitScope::Daily => until_next(now_ms, DAY_MS).min(DAILY_RECHECK).max(refresh),
                RateLimitScope::Unknown => refresh.max(retry.max),
            };
            let nominal = window.max(retry_after.unwrap_or_default());
            nominal.mul_f64(1.0 + 0.1 * (1.0 - u))
        }
    }
}

/// Time from `now_ms` to the next multiple of `period_ms` in UTC epoch time.
/// Exactly on a boundary, that is a whole period away, never zero.
fn until_next(now_ms: i64, period_ms: i64) -> Duration {
    Duration::from_millis((period_ms - now_ms.rem_euclid(period_ms)) as u64)
}

/// What the refresh loop reports about itself.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportedState {
    pub state: ServiceState,
    pub consecutive_failures: u32,
    pub rate_limit: Option<RateLimitScope>,
    pub last_success_ms: Option<i64>,
    pub last_error: Option<String>,
    pub next_fetch_ms: Option<i64>,
    pub snapshot_valid_time_ms: Option<i64>,
}

impl Default for ReportedState {
    fn default() -> Self {
        Self {
            state: ServiceState::Idle,
            consecutive_failures: 0,
            rate_limit: None,
            last_success_ms: None,
            last_error: None,
            next_fetch_ms: None,
            snapshot_valid_time_ms: None,
        }
    }
}

/// What the loop is doing while it waits after `outcome`.
pub fn waiting_state(outcome: Outcome) -> ServiceState {
    match outcome {
        Outcome::Fetched => ServiceState::Idle,
        Outcome::Failed {
            class: ErrorClass::Transient,
            ..
        } => ServiceState::Retrying,
        Outcome::Failed {
            class: ErrorClass::RateLimited { .. },
            ..
        } => ServiceState::RateLimited,
        Outcome::Failed {
            class: ErrorClass::Rejected,
            ..
        } => ServiceState::Rejected,
    }
}

/// A scheduled fetch, kept in both clocks: the monotonic one to sleep on, the
/// wall clock to report and persist.
#[derive(Debug, Clone, Copy)]
struct Pending {
    at: tokio::time::Instant,
    epoch_ms: i64,
}

impl Pending {
    fn after(delay: Duration, now_ms: i64) -> Self {
        Self {
            at: tokio::time::Instant::now() + delay,
            epoch_ms: now_ms.saturating_add(delay.as_millis() as i64),
        }
    }

    /// A wall-clock deadline; one already past is due now.
    fn at_epoch_ms(epoch_ms: i64, now_ms: i64) -> Self {
        let remaining = Duration::from_millis(epoch_ms.saturating_sub(now_ms).max(0) as u64);
        Self {
            at: tokio::time::Instant::now() + remaining,
            epoch_ms,
        }
    }
}

/// Publishes `report` only when it differs from what subscribers already hold.
fn publish(reported: &watch::Sender<ReportedState>, report: &ReportedState) {
    reported.send_if_modified(|current| {
        if current == report {
            false
        } else {
            *current = report.clone();
            true
        }
    });
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
    jitter: Jitter,
    desired: watch::Receiver<bool>,
    store: Arc<StateStore>,
}

impl<P: WeatherProvider> Refresher<P> {
    /// Always enabled, with nothing persisted, until told otherwise.
    pub fn new(provider: P, grid: GridSpec, levels: Vec<u16>, refresh: Duration) -> Self {
        Self {
            provider,
            grid,
            levels,
            refresh,
            retry: default_retry(),
            cache_path: None,
            clock: system_clock_ms,
            jitter: random_jitter,
            // The sender is dropped at once. A closed command channel means
            // "no more commands", never "stop", so this stays enabled.
            desired: watch::channel(true).1,
            store: Arc::new(StateStore::in_memory()),
        }
    }

    pub fn with_jitter(mut self, jitter: Jitter) -> Self {
        self.jitter = jitter;
        self
    }

    /// Follows the operator's enabled setting.
    pub fn with_desired(mut self, desired: watch::Receiver<bool>) -> Self {
        self.desired = desired;
        self
    }

    /// Persists the not-before time after a rate limit, and honours one left
    /// by a previous run.
    pub fn with_state_store(mut self, store: Arc<StateStore>) -> Self {
        self.store = store;
        self
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
        reported: watch::Sender<ReportedState>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let mut report = ReportedState::default();
        if let Some(cached) = self.cached() {
            info!(
                "Replaying cached weather snapshot (valid at {} ms) until the first fetch",
                cached.valid_time_ms
            );
            report.snapshot_valid_time_ms = Some(cached.valid_time_ms);
            // send_replace, not send: it stores the value even while nothing is
            // subscribed yet, so a publisher attaching later still starts with it.
            snapshots.send_replace(Some(cached));
        }

        let mut desired = self.desired.clone();
        let mut commands_open = true;
        let mut failures: u32 = 0;
        let mut last_outcome: Option<Outcome> = None;

        // A rate limit recorded before a restart still stands: the provider's
        // window did not reset because this process did.
        let mut pending = None;
        if let Some(not_before_ms) = self.store.get().not_before_ms {
            let now_ms = (self.clock)();
            if not_before_ms > now_ms {
                info!(
                    "Honouring a rate limit from the previous run: next fetch in {} min",
                    (not_before_ms - now_ms).div_euclid(60_000) + 1
                );
                report.state = ServiceState::RateLimited;
            }
            pending = Some(Pending::at_epoch_ms(not_before_ms, now_ms));
        }

        loop {
            if *shutdown.borrow() {
                return;
            }

            // Disabled: no fetches until enabled again. `pending` survives, so
            // re-enabling never fetches earlier than already scheduled, and a
            // deadline that passed meanwhile fires straight away.
            if !*desired.borrow() {
                info!("Weather fetching is disabled");
                report.state = ServiceState::Disabled;
                report.next_fetch_ms = None;
                publish(&reported, &report);
                loop {
                    tokio::select! {
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() {
                                return;
                            }
                        }
                        changed = desired.changed(), if commands_open => {
                            if changed.is_err() {
                                commands_open = false;
                            } else if *desired.borrow() {
                                info!("Weather fetching is enabled");
                                break;
                            }
                        }
                    }
                }
                continue;
            }

            if let Some(due) = pending {
                if let Some(outcome) = last_outcome {
                    report.state = waiting_state(outcome);
                } else if report.state == ServiceState::Disabled {
                    report.state = ServiceState::RateLimited;
                }
                report.next_fetch_ms = Some(due.epoch_ms);
                publish(&reported, &report);

                // Sleep to a fixed deadline. `changed()` also fires for a
                // `false` that means "keep running"; treating that as a wake-up
                // would fetch early and spend quota.
                let mut disabled = false;
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep_until(due.at) => break,
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() {
                                return;
                            }
                        }
                        changed = desired.changed(), if commands_open => {
                            if changed.is_err() {
                                commands_open = false;
                            } else if !*desired.borrow() {
                                disabled = true;
                                break;
                            }
                        }
                    }
                }
                if disabled {
                    continue;
                }
                pending = None;
            }

            report.state = ServiceState::Fetching;
            report.next_fetch_ms = None;
            publish(&reported, &report);

            let now_ms = (self.clock)();
            let result = {
                let fetch = self.provider.fetch(self.grid, &self.levels, now_ms);
                tokio::pin!(fetch);
                loop {
                    tokio::select! {
                        result = &mut fetch => break Some(result),
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() {
                                return;
                            }
                        }
                        changed = desired.changed(), if commands_open => {
                            if changed.is_err() {
                                commands_open = false;
                            } else if !*desired.borrow() {
                                // Dropping the future abandons the request. The
                                // chunks already fetched stay with the provider
                                // for the next attempt in the same hour.
                                info!("Weather fetch cancelled: fetching was disabled");
                                break None;
                            }
                        }
                    }
                }
            };
            let Some(result) = result else {
                continue;
            };

            let outcome = match result {
                Ok(snapshot) => {
                    if failures > 0 {
                        info!("Weather fetch recovered after {failures} failure(s)");
                    }
                    failures = 0;
                    report.consecutive_failures = 0;
                    report.rate_limit = None;
                    report.last_error = None;
                    report.last_success_ms = Some(now_ms);
                    report.snapshot_valid_time_ms = Some(snapshot.valid_time_ms);
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
                    let class = e.class();
                    report.consecutive_failures = failures;
                    report.last_error = Some(e.to_string());
                    report.rate_limit = match class {
                        ErrorClass::RateLimited { scope, .. } => Some(scope),
                        _ => None,
                    };
                    Outcome::Failed { failures, class }
                }
            };

            let now_ms = (self.clock)();
            let delay = next_delay(outcome, self.refresh, self.retry, now_ms, (self.jitter)());
            if let Outcome::Failed {
                class: ErrorClass::RateLimited { scope, .. },
                ..
            } = outcome
            {
                warn!(
                    "Rate limited by {} ({scope:?} limit); next attempt in {} min",
                    self.provider.name(),
                    delay.as_secs().div_ceil(60)
                );
            }
            let due = Pending::after(delay, now_ms);
            self.persist_not_before(outcome, due.epoch_ms);
            last_outcome = Some(outcome);
            pending = Some(due);
        }
    }

    /// Records when the provider may next be asked, if a rate limit says so.
    ///
    /// Any other outcome clears it: by then the window has been waited out.
    /// A failed write is logged, not fatal -- it only matters if the process
    /// also restarts before the window ends.
    fn persist_not_before(&self, outcome: Outcome, next_fetch_ms: i64) {
        let not_before = match outcome {
            Outcome::Failed {
                class: ErrorClass::RateLimited { .. },
                ..
            } => Some(next_fetch_ms),
            _ => None,
        };
        if let Err(e) = self.store.update(|s| s.not_before_ms = not_before) {
            warn!(
                "Could not record the next fetch time; a restart may ask the provider too early: {e}"
            );
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
            reason: None,
            retry_after: None,
        }
    }

    /// Plays back a script of results and records when, and for which "now",
    /// it was asked.
    #[derive(Default)]
    struct Fake {
        script: Mutex<VecDeque<Result<WeatherSnapshot, ProviderError>>>,
        calls: Mutex<Vec<(Instant, i64)>>,
        /// How long each fetch takes, in (paused) virtual time.
        latency: Duration,
    }

    impl Fake {
        fn scripted(results: Vec<Result<WeatherSnapshot, ProviderError>>) -> Arc<Self> {
            Self::slow(results, Duration::ZERO)
        }

        fn slow(
            results: Vec<Result<WeatherSnapshot, ProviderError>>,
            latency: Duration,
        ) -> Arc<Self> {
            Arc::new(Self {
                script: Mutex::new(results.into()),
                calls: Mutex::default(),
                latency,
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
            if !self.latency.is_zero() {
                tokio::time::sleep(self.latency).await;
            }
            self.script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(http_error()))
        }
    }

    struct Running {
        snapshots: watch::Receiver<Option<WeatherSnapshot>>,
        reported: watch::Receiver<ReportedState>,
        desired: watch::Sender<bool>,
        shutdown: watch::Sender<bool>,
        task: tokio::task::JoinHandle<()>,
    }

    fn start(refresher: Refresher<Arc<Fake>>) -> Running {
        start_with(refresher, true)
    }

    fn start_with(refresher: Refresher<Arc<Fake>>, enabled: bool) -> Running {
        let (desired, desired_rx) = watch::channel(enabled);
        // Pinned: the schedule assertions below are exact.
        let refresher = refresher.with_jitter(no_jitter).with_desired(desired_rx);
        let (snap_tx, snapshots) = watch::channel(None);
        let (reported_tx, reported) = watch::channel(ReportedState::default());
        let (shutdown, shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(refresher.run(snap_tx, reported_tx, shutdown_rx));
        Running {
            snapshots,
            reported,
            desired,
            shutdown,
            task,
        }
    }

    /// Lets the loop run at the current virtual instant without advancing it.
    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
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

    const MINUTE: Duration = Duration::from_secs(60);
    const H_MS: i64 = 3_600_000;
    /// A UTC midnight: the start of the fixture's day.
    const MIDNIGHT_MS: i64 = 1_789_344_000_000;
    /// 12:20 UTC that day.
    const MIDDAY_MS: i64 = MIDNIGHT_MS + 12 * H_MS + 20 * 60_000;

    fn transient(failures: u32) -> Outcome {
        Outcome::Failed {
            failures,
            class: ErrorClass::Transient,
        }
    }

    fn limited(scope: RateLimitScope, retry_after: Option<Duration>) -> Outcome {
        Outcome::Failed {
            failures: 1,
            class: ErrorClass::RateLimited { scope, retry_after },
        }
    }

    /// `next_delay` at 12:20 UTC, without jitter.
    fn delay(outcome: Outcome, refresh: Duration) -> Duration {
        next_delay(outcome, refresh, default_retry(), MIDDAY_MS, no_jitter())
    }

    #[test]
    fn after_success_wait_the_refresh_interval() {
        assert_eq!(delay(Outcome::Fetched, REFRESH), REFRESH);
    }

    #[test]
    fn after_failures_back_off_exponentially() {
        assert_eq!(delay(transient(1), REFRESH), MINUTE);
        assert_eq!(delay(transient(2), REFRESH), 2 * MINUTE);
        assert_eq!(delay(transient(10), REFRESH), default_retry().max);
    }

    #[test]
    fn a_retry_never_waits_longer_than_a_refresh() {
        let short_refresh = 10 * MINUTE;
        assert_eq!(delay(transient(10), short_refresh), short_refresh);
    }

    #[test]
    fn transient_jitter_shortens_a_retry_by_at_most_half() {
        let at = |u| next_delay(transient(2), REFRESH, default_retry(), MIDDAY_MS, u);
        assert_eq!(at(0.0), MINUTE);
        assert_eq!(at(1.0), 2 * MINUTE);
        assert!(at(0.5) > MINUTE && at(0.5) < 2 * MINUTE);
    }

    #[test]
    fn a_rejected_request_waits_a_full_refresh() {
        let outcome = Outcome::Failed {
            failures: 7,
            class: ErrorClass::Rejected,
        };
        assert_eq!(delay(outcome, REFRESH), REFRESH);
    }

    #[test]
    fn a_minutely_limit_waits_a_minute_not_a_refresh() {
        assert_eq!(
            delay(limited(RateLimitScope::Minutely, None), REFRESH),
            MINUTE
        );
    }

    #[test]
    fn an_hourly_limit_waits_for_the_next_utc_hour() {
        // 12:20 -> 13:00: longer than a 10-minute refresh...
        assert_eq!(
            delay(limited(RateLimitScope::Hourly, None), 10 * MINUTE),
            40 * MINUTE
        );
        // ...but never shorter than the refresh interval.
        assert_eq!(
            delay(limited(RateLimitScope::Hourly, None), REFRESH),
            REFRESH
        );
    }

    #[test]
    fn exactly_on_the_hour_the_next_hour_is_a_whole_hour_away() {
        let on_the_hour = MIDNIGHT_MS + 13 * H_MS;
        let d = next_delay(
            limited(RateLimitScope::Hourly, None),
            10 * MINUTE,
            default_retry(),
            on_the_hour,
            no_jitter(),
        );
        assert_eq!(d, 60 * MINUTE);
    }

    #[test]
    fn a_daily_limit_waits_for_utc_midnight() {
        let at_22h = next_delay(
            limited(RateLimitScope::Daily, None),
            REFRESH,
            default_retry(),
            MIDNIGHT_MS + 22 * H_MS,
            no_jitter(),
        );
        assert_eq!(at_22h, 120 * MINUTE);
    }

    #[test]
    fn a_daily_limit_rechecks_within_six_hours() {
        // At 12:20 midnight is almost 12 h away, and the reset time is a guess.
        assert_eq!(
            delay(limited(RateLimitScope::Daily, None), REFRESH),
            DAILY_RECHECK
        );
    }

    #[test]
    fn an_unknown_limit_waits_at_least_a_refresh_and_the_retry_ceiling() {
        assert_eq!(
            delay(limited(RateLimitScope::Unknown, None), REFRESH),
            REFRESH
        );
        assert_eq!(
            delay(limited(RateLimitScope::Unknown, None), 10 * MINUTE),
            default_retry().max
        );
    }

    #[test]
    fn a_longer_retry_after_wins() {
        assert_eq!(
            delay(limited(RateLimitScope::Minutely, Some(5 * MINUTE)), REFRESH),
            5 * MINUTE
        );
    }

    #[test]
    fn a_shorter_retry_after_does_not_cut_the_window_short() {
        assert_eq!(
            delay(limited(RateLimitScope::Hourly, Some(MINUTE)), 10 * MINUTE),
            40 * MINUTE
        );
    }

    #[test]
    fn rate_limit_jitter_only_ever_delays() {
        let at = |u| {
            next_delay(
                limited(RateLimitScope::Minutely, None),
                REFRESH,
                default_retry(),
                MIDDAY_MS,
                u,
            )
        };
        assert_eq!(at(1.0), MINUTE);
        assert_eq!(at(0.0), Duration::from_secs(66));
        assert!(at(0.3) >= MINUTE);
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
    async fn a_minutely_rate_limit_is_retried_after_a_minute() {
        // The refresh loop acts on the provider's classification end to end: a
        // real Open-Meteo minutely refusal must not idle for a whole refresh.
        let minutely = ProviderError::Status {
            base_url: "fake".into(),
            status: 429,
            reason: Some("Minutely API request limit exceeded.".into()),
            retry_after: None,
        };
        let fake = Fake::scripted(vec![Err(minutely), Ok(snapshot(1013.0))]);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));

        until_calls(&fake, 2).await;
        assert_eq!(fake.gaps(), vec![Duration::from_secs(60)]);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_rejected_request_is_not_retried_before_a_refresh() {
        let rejected = ProviderError::Status {
            base_url: "fake".into(),
            status: 400,
            reason: Some("Cannot initialize WeatherVariable".into()),
            retry_after: None,
        };
        let fake = Fake::scripted(vec![Err(rejected), Ok(snapshot(1013.0))]);
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

    // --- enable / disable --------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn disabled_never_fetches() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);
        let running = start_with(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH),
            false,
        );

        tokio::time::sleep(3 * REFRESH).await;
        assert_eq!(fake.call_count(), 0);
        assert_eq!(running.reported.borrow().state, ServiceState::Disabled);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn enabling_with_nothing_pending_fetches_at_once() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);
        let running = start_with(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH),
            false,
        );
        tokio::time::sleep(REFRESH).await;

        let enabled_at = Instant::now();
        running.desired.send(true).unwrap();
        until_calls(&fake, 1).await;
        assert_eq!(fake.calls.lock().unwrap()[0].0, enabled_at);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn re_enabling_never_fetches_before_the_pending_deadline() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0)), Ok(snapshot(1012.0))]);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));
        until_calls(&fake, 1).await;

        tokio::time::sleep(10 * MINUTE).await;
        running.desired.send(false).unwrap();
        tokio::time::sleep(10 * MINUTE).await;
        running.desired.send(true).unwrap();

        until_calls(&fake, 2).await;
        // Toggling bought no early fetch: the second one is still a refresh
        // after the first.
        assert_eq!(fake.gaps(), vec![REFRESH]);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_deadline_that_passed_while_disabled_fires_on_enable() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0)), Ok(snapshot(1012.0))]);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));
        until_calls(&fake, 1).await;

        running.desired.send(false).unwrap();
        tokio::time::sleep(2 * REFRESH).await;
        assert_eq!(fake.call_count(), 1);

        let enabled_at = Instant::now();
        running.desired.send(true).unwrap();
        until_calls(&fake, 2).await;
        assert_eq!(fake.calls.lock().unwrap()[1].0, enabled_at);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn disabling_cancels_an_in_flight_fetch() {
        let fake = Fake::slow(vec![Ok(snapshot(1013.0))], 10 * MINUTE);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));
        until_calls(&fake, 1).await;

        running.desired.send(false).unwrap();
        settle().await;
        assert_eq!(running.reported.borrow().state, ServiceState::Disabled);

        // Long past when the fetch would have finished: nothing was published.
        tokio::time::sleep(30 * MINUTE).await;
        assert_eq!(*running.snapshots.borrow(), None);
        assert_eq!(fake.call_count(), 1);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_command_channel_keeps_the_loop_running() {
        // Refresher::new's own channel: the sender is already gone.
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0)), Ok(snapshot(1012.0))]);
        let (snap_tx, _snapshots) = watch::channel(None);
        let (reported_tx, _reported) = watch::channel(ReportedState::default());
        let (_shutdown, shutdown_rx) = watch::channel(false);
        let refresher =
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH).with_jitter(no_jitter);
        let task = tokio::spawn(refresher.run(snap_tx, reported_tx, shutdown_rx));

        until_calls(&fake, 2).await;
        task.abort();
    }

    // --- reported state -----------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn after_a_success_it_reports_idle_until_the_next_fetch() {
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);
        let running = start(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH).with_clock(|| MIDDAY_MS),
        );
        until_calls(&fake, 1).await;
        settle().await;

        let report = running.reported.borrow().clone();
        assert_eq!(report.state, ServiceState::Idle);
        assert_eq!(report.last_success_ms, Some(MIDDAY_MS));
        assert_eq!(
            report.next_fetch_ms,
            Some(MIDDAY_MS + REFRESH.as_millis() as i64)
        );
        assert_eq!(report.snapshot_valid_time_ms, Some(0));
        assert_eq!(report.last_error, None);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn after_a_failure_it_reports_retrying_with_the_reason() {
        let fake = Fake::scripted(vec![Err(http_error())]);
        let running = start(Refresher::new(fake.clone(), grid(), vec![250], REFRESH));
        until_calls(&fake, 1).await;
        settle().await;

        let report = running.reported.borrow().clone();
        assert_eq!(report.state, ServiceState::Retrying);
        assert_eq!(report.consecutive_failures, 1);
        assert!(report.last_error.unwrap().contains("connection refused"));
        running.task.abort();
    }

    #[test]
    fn each_outcome_has_a_waiting_state() {
        assert_eq!(waiting_state(Outcome::Fetched), ServiceState::Idle);
        assert_eq!(waiting_state(transient(1)), ServiceState::Retrying);
        assert_eq!(
            waiting_state(limited(RateLimitScope::Daily, None)),
            ServiceState::RateLimited
        );
        assert_eq!(
            waiting_state(Outcome::Failed {
                failures: 1,
                class: ErrorClass::Rejected
            }),
            ServiceState::Rejected
        );
    }

    // --- not-before across restarts ----------------------------------------

    fn daily_limit() -> ProviderError {
        ProviderError::Status {
            base_url: "fake".into(),
            status: 429,
            reason: Some("Daily API request limit exceeded.".into()),
            retry_after: None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limit_deadline_is_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let (store, _) = StateStore::open(Some(path.clone()));
        let fake = Fake::scripted(vec![Err(daily_limit())]);
        let running = start(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH)
                .with_clock(|| MIDDAY_MS)
                .with_state_store(Arc::new(store)),
        );
        until_calls(&fake, 1).await;
        settle().await;

        let expected = MIDDAY_MS + DAILY_RECHECK.as_millis() as i64;
        let saved = crate::state_file::load(&path).unwrap().unwrap();
        assert_eq!(saved.not_before_ms, Some(expected));
        let report = running.reported.borrow().clone();
        assert_eq!(report.state, ServiceState::RateLimited);
        assert_eq!(report.rate_limit, Some(RateLimitScope::Daily));
        assert_eq!(report.next_fetch_ms, Some(expected));
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_persisted_not_before_is_honoured_after_a_restart() {
        let store = Arc::new(StateStore::in_memory());
        let two_hours = 2 * REFRESH;
        store
            .update(|s| s.not_before_ms = Some(MIDDAY_MS + two_hours.as_millis() as i64))
            .unwrap();
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);

        let started = Instant::now();
        let running = start(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH)
                .with_clock(|| MIDDAY_MS)
                .with_state_store(store),
        );
        settle().await;
        assert_eq!(running.reported.borrow().state, ServiceState::RateLimited);

        tokio::time::sleep(REFRESH).await;
        assert_eq!(
            fake.call_count(),
            0,
            "asked again inside the rate-limit window"
        );
        until_calls(&fake, 1).await;
        assert_eq!(fake.calls.lock().unwrap()[0].0 - started, two_hours);
        running.task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_success_clears_the_persisted_not_before() {
        let store = Arc::new(StateStore::in_memory());
        // Already past: due now.
        store
            .update(|s| s.not_before_ms = Some(MIDDAY_MS - 1))
            .unwrap();
        let fake = Fake::scripted(vec![Ok(snapshot(1013.0))]);
        let running = start(
            Refresher::new(fake.clone(), grid(), vec![250], REFRESH)
                .with_clock(|| MIDDAY_MS)
                .with_state_store(store.clone()),
        );
        until_calls(&fake, 1).await;
        settle().await;

        assert_eq!(store.get().not_before_ms, None);
        running.task.abort();
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
