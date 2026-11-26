//! What the control API and the poller share.
//!
//! The command side: the enabled setting, the watch leases and the credit
//! ledger live here. The API writes intent (enable, watch), the poller reads it
//! and is the single writer of the status it reports. A change that matters
//! to the poller -- the setting, or the *content* of the watched union --
//! bumps a generation counter it waits on; renewing a lease with the same
//! request does not, so a client renewing every 20 s never triggers a poll.

use crate::api::{WatchAccepted, WatchRequest};
use crate::budget;
use crate::credits::{self, Bucket, Ledger, LedgerFileError};
use crate::provider::{OpenSkyProvider, ProviderError};
use crate::states::{OpenSkyTrack, TrackMessage};
use crate::status::{CreditsSummary, WatchSummary};
use crate::watch::{WatchError, WatchSet, WatchUnion};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::watch;

/// A clock in epoch milliseconds. Injected so tests run on a paused tokio
/// clock.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The wall clock.
pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    })
}

/// How often, at most, the ledger is written after a spend. A crash loses at
/// most this much of the count, which errs towards a few credits.
pub const LEDGER_SAVE_INTERVAL_MS: i64 = 60_000;

/// Why a track could not be served.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TrackError {
    #[error("'{0}' is not an ICAO 24-bit address")]
    BadIcao(String),
    #[error("tracks need OpenSky credentials; this service is anonymous")]
    Anonymous,
    #[error("the /tracks credit budget for the last 24 h is spent")]
    OverBudget,
    #[error("time {0} is not within the last 30 days; OpenSky keeps no older tracks")]
    OutOfRange(i64),
    #[error(transparent)]
    Provider(#[from] ProviderError),
}

/// Scheduling settings the control side needs to answer a watch request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Budget {
    /// Daily credits per bucket, already capped for anonymous access.
    pub daily_credits: u32,
    pub min_interval: Duration,
}

struct LedgerState {
    ledger: Ledger,
    path: Option<PathBuf>,
    saved_ms: Option<i64>,
}

/// The shared command-side state.
pub struct Control {
    enabled: watch::Sender<bool>,
    generation: watch::Sender<u64>,
    watch: Mutex<WatchSet>,
    ledger: Mutex<LedgerState>,
    budget: Budget,
    provider: Arc<dyn OpenSkyProvider>,
    clock: Clock,
    /// Where fetched tracks go to be published for recorders; none in tests.
    track_sink: Option<tokio::sync::mpsc::Sender<TrackMessage>>,
}

impl Control {
    /// `ledger` is what was loaded from `ledger_path` (or empty).
    pub fn new(
        watch: WatchSet,
        ledger: Ledger,
        ledger_path: Option<PathBuf>,
        budget: Budget,
        provider: Arc<dyn OpenSkyProvider>,
        clock: Clock,
    ) -> Self {
        Self {
            enabled: watch::channel(true).0,
            generation: watch::channel(0).0,
            watch: Mutex::new(watch),
            ledger: Mutex::new(LedgerState {
                ledger,
                path: ledger_path,
                saved_ms: None,
            }),
            budget,
            provider,
            clock,
            track_sink: None,
        }
    }

    /// Publishes every fetched track through `sink`. Never blocks a fetch: a
    /// full queue drops the message (it was served; only its record is lost).
    pub fn with_track_sink(mut self, sink: tokio::sync::mpsc::Sender<TrackMessage>) -> Self {
        self.track_sink = Some(sink);
        self
    }

    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    pub fn budget(&self) -> Budget {
        self.budget
    }

    pub fn authenticated(&self) -> bool {
        self.provider.authenticated()
    }

    pub fn provider(&self) -> Arc<dyn OpenSkyProvider> {
        self.provider.clone()
    }

    fn watch_set(&self) -> MutexGuard<'_, WatchSet> {
        self.watch.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ledger_state(&self) -> MutexGuard<'_, LedgerState> {
        self.ledger.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn bump(&self) {
        self.generation.send_modify(|g| *g = g.wrapping_add(1));
    }

    /// Wakes on every change the poller must react to.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.generation.subscribe()
    }

    // --- enabled ------------------------------------------------------------

    pub fn enabled(&self) -> bool {
        *self.enabled.borrow()
    }

    /// Sets the desired state. In memory only. Idempotent.
    pub fn set_enabled(&self, enabled: bool) {
        if self.enabled.send_if_modified(|current| {
            let changed = *current != enabled;
            *current = enabled;
            changed
        }) {
            self.bump();
        }
    }

    // --- watch --------------------------------------------------------------

    /// Replaces `client`'s request and renews its lease.
    pub fn put_watch(
        &self,
        client: &str,
        request: &WatchRequest,
    ) -> Result<WatchAccepted, WatchError> {
        let now = self.now();
        let (counts, union, lease_ms) = {
            let mut set = self.watch_set();
            let before = set.union(now);
            let counts = set.put(client, request, now)?;
            let after = set.union(now);
            if same_targets(&before, &after) {
                (counts, after, set.lease_ms())
            } else {
                drop(set);
                self.bump();
                let set = self.watch_set();
                (counts, set.union(now), set.lease_ms())
            }
        };
        Ok(WatchAccepted {
            icao24: counts.0,
            areas: counts.1,
            lease_seconds: (lease_ms / 1_000) as u64,
            interval_seconds: self.planned_interval(&union).map(|d| d.as_secs_f64()),
        })
    }

    /// Drops `client`'s request.
    pub fn remove_watch(&self, client: &str) -> bool {
        let removed = self.watch_set().remove(client);
        if removed {
            self.bump();
        }
        removed
    }

    /// Drops lapsed leases; true if any lapsed.
    pub fn expire(&self, now_ms: i64) -> bool {
        self.watch_set().expire(now_ms)
    }

    pub fn union(&self, now_ms: i64) -> WatchUnion {
        self.watch_set().union(now_ms)
    }

    pub fn next_expiry(&self) -> Option<i64> {
        self.watch_set().next_expiry()
    }

    pub fn watch_summary(&self, now_ms: i64) -> WatchSummary {
        let u = self.union(now_ms);
        WatchSummary {
            icao24: u.icao24.len(),
            areas: u.areas.len(),
            clients: u.clients,
        }
    }

    /// The steady interval for `union`; `None` when there is nothing to poll.
    pub fn planned_interval(&self, union: &WatchUnion) -> Option<Duration> {
        let cost = budget::cycle_cost(union.icao24.len(), &union.areas);
        (cost > 0).then(|| {
            budget::steady_interval(cost, self.budget.daily_credits, self.budget.min_interval)
        })
    }

    // --- credits ------------------------------------------------------------

    /// Records a spend and OpenSky's remaining count, and saves the ledger if
    /// it has not been saved for a while.
    pub fn record(&self, bucket: Bucket, cost: u32, remaining: Option<i64>, now_ms: i64) {
        let mut state = self.ledger_state();
        state.ledger.record(bucket, cost, now_ms);
        state.ledger.set_remaining(bucket, remaining, now_ms);
        let due = state
            .saved_ms
            .is_none_or(|t| now_ms - t >= LEDGER_SAVE_INTERVAL_MS);
        if due {
            let _ = save_now(&mut state, now_ms);
        }
    }

    /// Writes the ledger now (at shutdown).
    pub fn flush(&self) -> Result<(), LedgerFileError> {
        let now = self.now();
        save_now(&mut self.ledger_state(), now)
    }

    pub fn used_last_24h(&self, bucket: Bucket, now_ms: i64) -> u32 {
        self.ledger_state().ledger.used_last_24h(bucket, now_ms)
    }

    pub fn remaining(&self, bucket: Bucket, now_ms: i64) -> Option<i64> {
        self.ledger_state().ledger.remaining(bucket, now_ms)
    }

    pub fn wait_until_available(&self, bucket: Bucket, cost: u32, now_ms: i64) -> Duration {
        self.ledger_state().ledger.wait_until_available(
            bucket,
            cost,
            budget::allowance(self.budget.daily_credits),
            now_ms,
        )
    }

    pub fn credits_summary(&self, now_ms: i64) -> CreditsSummary {
        let state = self.ledger_state();
        CreditsSummary {
            daily_limit: self.budget.daily_credits,
            states_used_24h: state.ledger.used_last_24h(Bucket::States, now_ms),
            tracks_used_24h: state.ledger.used_last_24h(Bucket::Tracks, now_ms),
            states_remaining: state.ledger.remaining(Bucket::States, now_ms),
            tracks_remaining: state.ledger.remaining(Bucket::Tracks, now_ms),
        }
    }

    pub fn credits_report(&self, now_ms: i64) -> crate::api::CreditsReport {
        self.ledger_state()
            .ledger
            .report(self.budget.daily_credits, now_ms)
    }

    // --- tracks -------------------------------------------------------------

    /// The aircraft's live track, charged to the `/tracks` bucket.
    pub async fn track(&self, icao24: &str) -> Result<OpenSkyTrack, TrackError> {
        self.track_at(icao24, None).await
    }

    /// The flight the aircraft was on at `time_s` (epoch seconds), or its live
    /// flight for `None`. Charged to the `/tracks` bucket: the estimate from
    /// [`budget::track_cost`] guards the budget, and what OpenSky's remaining
    /// count says it cost is what gets recorded.
    pub async fn track_at(
        &self,
        icao24: &str,
        time_s: Option<i64>,
    ) -> Result<OpenSkyTrack, TrackError> {
        let icao = crate::watch::normalise_icao(icao24)
            .map_err(|_| TrackError::BadIcao(icao24.to_string()))?;
        let now = self.now();
        if let Some(t) = time_s {
            let t_ms = t.saturating_mul(1_000);
            // A minute of slack for the client's clock.
            if t_ms > now + 60_000 || now - t_ms > budget::TRACK_HISTORY_MS {
                return Err(TrackError::OutOfRange(t));
            }
        }
        if !self.authenticated() {
            return Err(TrackError::Anonymous);
        }
        let estimate = budget::track_cost(time_s, now);
        if !self
            .wait_until_available(Bucket::Tracks, estimate, now)
            .is_zero()
        {
            return Err(TrackError::OverBudget);
        }
        let before = self.remaining(Bucket::Tracks, now);
        let reply = self.provider.track(&icao, time_s).await?;
        let cost = budget::observed_cost(before, reply.remaining, estimate);
        self.record(Bucket::Tracks, cost, reply.remaining, self.now());
        // The ledger moved: let the status catch up.
        self.bump();
        if let Some(sink) = &self.track_sink
            && sink
                .try_send(TrackMessage::new(self.now(), reply.value.clone()))
                .is_err()
        {
            tracing::warn!("OpenSky track for {icao} not published: the publisher is behind");
        }
        Ok(reply.value)
    }
}

/// Whether two unions would poll the same things.
fn same_targets(a: &WatchUnion, b: &WatchUnion) -> bool {
    a.icao24 == b.icao24 && a.areas == b.areas
}

fn save_now(state: &mut LedgerState, now_ms: i64) -> Result<(), LedgerFileError> {
    let Some(path) = state.path.clone() else {
        return Ok(());
    };
    state.ledger.prune(now_ms);
    credits::save(&path, &state.ledger)?;
    state.saved_ms = Some(now_ms);
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::api::Area;
    use crate::provider::Reply;
    use crate::states::StatesResponse;
    use crate::watch::WatchLimits;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// A provider that answers nothing; tests of the control side only need
    /// `authenticated` and, once, `track`.
    pub(crate) struct NullProvider {
        pub authenticated: bool,
    }

    #[async_trait::async_trait]
    impl OpenSkyProvider for NullProvider {
        fn authenticated(&self) -> bool {
            self.authenticated
        }
        async fn states_by_icao(
            &self,
            _: &[String],
        ) -> Result<Reply<StatesResponse>, ProviderError> {
            Err(ProviderError::Transient("null".into()))
        }
        async fn states_in_area(&self, _: &Area) -> Result<Reply<StatesResponse>, ProviderError> {
            Err(ProviderError::Transient("null".into()))
        }
        async fn track(
            &self,
            icao24: &str,
            _time: Option<i64>,
        ) -> Result<Reply<OpenSkyTrack>, ProviderError> {
            Ok(Reply {
                value: OpenSkyTrack {
                    icao24: icao24.into(),
                    callsign: None,
                    start_time: 0,
                    end_time: 0,
                    path: vec![],
                },
                remaining: Some(3_996),
            })
        }
    }

    fn control(authenticated: bool, now: Arc<AtomicI64>) -> Control {
        Control::new(
            WatchSet::new(WatchLimits::default(), 60_000),
            Ledger::default(),
            None,
            Budget {
                daily_credits: 4_000,
                min_interval: Duration::from_secs(10),
            },
            Arc::new(NullProvider { authenticated }),
            Arc::new(move || now.load(Ordering::SeqCst)),
        )
    }

    fn req(icao: &[&str]) -> WatchRequest {
        WatchRequest {
            icao24: icao.iter().map(|s| s.to_string()).collect(),
            areas: vec![],
        }
    }

    #[test]
    fn a_watch_is_accepted_with_its_lease_and_planned_interval() {
        let c = control(true, Arc::new(AtomicI64::new(0)));
        let ok = c.put_watch("laptop", &req(&["3c6444"])).unwrap();
        assert_eq!((ok.icao24, ok.areas, ok.lease_seconds), (1, 0, 60));
        assert_eq!(ok.interval_seconds, Some(24.0));
    }

    #[test]
    fn renewing_the_same_watch_does_not_wake_the_poller() {
        let c = control(true, Arc::new(AtomicI64::new(0)));
        let rx = c.subscribe();
        c.put_watch("laptop", &req(&["3c6444"])).unwrap();
        assert!(rx.has_changed().unwrap());
        let mut rx = c.subscribe();
        rx.mark_unchanged();
        c.put_watch("laptop", &req(&["3c6444"])).unwrap();
        assert!(!rx.has_changed().unwrap());
        c.put_watch("laptop", &req(&["3c6444", "39de4f"])).unwrap();
        assert!(rx.has_changed().unwrap());
    }

    #[test]
    fn enabling_twice_wakes_once() {
        let c = control(true, Arc::new(AtomicI64::new(0)));
        let mut rx = c.subscribe();
        rx.mark_unchanged();
        c.set_enabled(true);
        assert!(!rx.has_changed().unwrap());
        c.set_enabled(false);
        assert!(rx.has_changed().unwrap());
        assert!(!c.enabled());
    }

    #[test]
    fn spending_shows_in_the_summary() {
        let now = Arc::new(AtomicI64::new(1_000_000));
        let c = control(true, now.clone());
        c.record(Bucket::States, 2, Some(3_998), 1_000_000);
        let s = c.credits_summary(1_000_001);
        assert_eq!(s.states_used_24h, 2);
        assert_eq!(s.states_remaining, Some(3_998));
        assert_eq!(s.daily_limit, 4_000);
    }

    #[test]
    fn the_ledger_is_saved_when_due() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let now = Arc::new(AtomicI64::new(0));
        let mut c = control(true, now);
        c.ledger = Mutex::new(LedgerState {
            ledger: Ledger::default(),
            path: Some(path.clone()),
            saved_ms: None,
        });
        c.record(Bucket::States, 1, None, 1_000);
        assert_eq!(
            credits::load(&path)
                .unwrap()
                .used_last_24h(Bucket::States, 1_000),
            1
        );
        // Within the save interval: memory moves, the file waits.
        c.record(Bucket::States, 1, None, 2_000);
        assert_eq!(
            credits::load(&path)
                .unwrap()
                .used_last_24h(Bucket::States, 2_000),
            1
        );
        c.flush().unwrap();
        assert_eq!(
            credits::load(&path)
                .unwrap()
                .used_last_24h(Bucket::States, 2_000),
            2
        );
    }

    #[tokio::test]
    async fn a_track_is_charged_to_the_tracks_bucket() {
        let c = control(true, Arc::new(AtomicI64::new(5_000)));
        let t = c.track("3C6444").await.unwrap();
        assert_eq!(t.icao24, "3c6444");
        assert_eq!(c.used_last_24h(Bucket::Tracks, 5_001), 4);
        assert_eq!(c.used_last_24h(Bucket::States, 5_001), 0);
    }

    #[tokio::test]
    async fn an_anonymous_service_serves_no_tracks() {
        let c = control(false, Arc::new(AtomicI64::new(0)));
        assert_eq!(c.track("3c6444").await, Err(TrackError::Anonymous));
        assert!(matches!(c.track("zz").await, Err(TrackError::BadIcao(_))));
    }

    #[tokio::test]
    async fn tracks_stop_when_their_budget_is_spent() {
        let c = control(true, Arc::new(AtomicI64::new(10_000)));
        // 3,600 is the allowance at 4,000 a day.
        c.record(Bucket::Tracks, 3_598, None, 9_000);
        assert_eq!(c.track("3c6444").await, Err(TrackError::OverBudget));
    }

    const DAY_MS: i64 = 86_400_000;

    #[tokio::test]
    async fn a_past_track_is_charged_what_opensky_counted() {
        let now = 40 * DAY_MS;
        let c = control(true, Arc::new(AtomicI64::new(now)));
        // OpenSky said 4,000 left before the call and says 3,996 after it.
        c.record(Bucket::Tracks, 0, Some(4_000), now - 1_000);
        let two_days_ago = (now - 2 * DAY_MS) / 1_000;
        c.track_at("3c6444", Some(two_days_ago)).await.unwrap();
        assert_eq!(c.used_last_24h(Bucket::Tracks, now + 1), 4);
    }

    #[tokio::test]
    async fn without_opensky_counts_a_past_track_is_charged_the_estimate() {
        let now = 40 * DAY_MS;
        let c = control(true, Arc::new(AtomicI64::new(now)));
        let two_days_ago = (now - 2 * DAY_MS) / 1_000;
        c.track_at("3c6444", Some(two_days_ago)).await.unwrap();
        assert_eq!(c.used_last_24h(Bucket::Tracks, now + 1), 30);
    }

    #[tokio::test]
    async fn a_fetched_track_is_handed_to_the_publisher_with_its_fetch_time() {
        let now = 40 * DAY_MS;
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let c = control(true, Arc::new(AtomicI64::new(now))).with_track_sink(tx);
        c.track_at("3c6444", None).await.unwrap();
        let m = rx.try_recv().expect("published");
        assert_eq!(m.fetched_ms, now);
        assert_eq!(m.track.icao24, "3c6444");
    }

    #[tokio::test]
    async fn without_a_sink_a_track_is_still_served() {
        let c = control(true, Arc::new(AtomicI64::new(40 * DAY_MS)));
        assert!(c.track_at("3c6444", None).await.is_ok());
    }

    #[tokio::test]
    async fn a_track_time_must_be_within_the_last_30_days() {
        let now = 40 * DAY_MS;
        let c = control(true, Arc::new(AtomicI64::new(now)));
        let future = now / 1_000 + 3_600;
        let too_old = (now - 31 * DAY_MS) / 1_000;
        assert_eq!(
            c.track_at("3c6444", Some(future)).await,
            Err(TrackError::OutOfRange(future))
        );
        assert_eq!(
            c.track_at("3c6444", Some(too_old)).await,
            Err(TrackError::OutOfRange(too_old))
        );
        assert_eq!(c.used_last_24h(Bucket::Tracks, now + 1), 0);
    }
}
