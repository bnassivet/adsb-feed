//! The poller: asks OpenSky for the watched union, within the budget.
//!
//! One cycle is one `/states/all` call for every watched aircraft together,
//! plus one per area. The next cycle is scheduled from what the cycle cost and
//! what is left ([`budget::next_interval`]); nothing is polled while nothing is
//! watched.
//!
//! When the union *grows* -- a new aircraft selected, an area drawn -- the
//! next cycle is brought forward so the new target shows up promptly, but
//! never sooner than `min_interval` after the last one, and never inside a
//! rate-limit deadline. A union that shrinks waits for its schedule: there is
//! nothing new to show.
//!
//! The poller is the single writer of the status: it republishes on every
//! change it sees, including the control API's.

use crate::budget;
use crate::control::Control;
use crate::credits::Bucket;
use crate::provider::{OpenSkyProvider, ProviderError};
use crate::states::{Match, MatchedState, OpenSkyState, STATES_VERSION, StatesMessage};
use crate::status::{OpenSkyStatus, STATUS_VERSION, ServiceState};
use crate::watch::WatchUnion;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tracing::{info, warn};

/// Wait after a 429 that did not say how long.
pub const DEFAULT_RATE_LIMIT_WAIT: Duration = Duration::from_secs(3_600);

/// First retry after a transient failure; doubles up to [`MAX_RETRY`].
pub const FIRST_RETRY: Duration = Duration::from_secs(30);
pub const MAX_RETRY: Duration = Duration::from_secs(600);

/// What the poller reports, beside what [`Control`] holds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reported {
    pub state: Option<ServiceState>,
    pub consecutive_failures: u32,
    pub rate_limited_until_ms: Option<i64>,
    pub last_success_ms: Option<i64>,
    pub last_error: Option<String>,
    pub next_poll_ms: Option<i64>,
    pub interval: Option<Duration>,
    pub cycle_cost: u32,
    /// The credentials were refused: polling stops until re-enabled.
    pub unauthorized: bool,
}

/// The status document for what `control` holds and the poller reports.
pub fn build_status(control: &Control, r: &Reported, now_ms: i64) -> OpenSkyStatus {
    OpenSkyStatus {
        version: STATUS_VERSION,
        enabled: control.enabled(),
        authenticated: control.authenticated(),
        state: r.state.unwrap_or(ServiceState::Idle),
        watch: control.watch_summary(now_ms),
        interval_seconds: r.interval.map(|d| d.as_secs_f64()),
        cycle_cost: r.cycle_cost,
        credits: control.credits_summary(now_ms),
        consecutive_failures: r.consecutive_failures,
        rate_limited_until_ms: r.rate_limited_until_ms,
        last_success_ms: r.last_success_ms,
        last_error: r.last_error.clone(),
        next_poll_ms: r.next_poll_ms,
        updated_at_ms: now_ms,
    }
}

/// What one cycle produced.
#[derive(Debug, Clone, PartialEq)]
pub struct CycleResult {
    /// What was fetched before any failure; `None` if nothing succeeded.
    pub message: Option<StatesMessage>,
    /// The first failure; the cycle stops there, spending nothing more.
    pub error: Option<ProviderError>,
    /// OpenSky's remaining count after the last successful call.
    pub remaining: Option<i64>,
}

/// Adds `states` to `merged` under `tag`. An aircraft fetched twice -- by
/// icao24 and inside an area -- keeps the newer position and both tags.
pub fn merge(merged: &mut BTreeMap<String, MatchedState>, states: Vec<OpenSkyState>, tag: Match) {
    for state in states {
        match merged.get_mut(&state.icao24) {
            Some(existing) => {
                if state.time_position > existing.state.time_position {
                    existing.state = state;
                }
                if !existing.matched.contains(&tag) {
                    existing.matched.push(tag.clone());
                }
            }
            None => {
                merged.insert(
                    state.icao24.clone(),
                    MatchedState {
                        state,
                        matched: vec![tag.clone()],
                    },
                );
            }
        }
    }
}

/// One cycle: the aircraft first, then each area. Each success is charged to
/// the ledger as it lands.
pub async fn poll_cycle(
    provider: &dyn OpenSkyProvider,
    control: &Control,
    union: &WatchUnion,
) -> CycleResult {
    let mut merged = BTreeMap::new();
    let mut data_time = 0;
    let mut any = false;
    let mut remaining = None;
    let mut error = None;

    if !union.icao24.is_empty() {
        match provider.states_by_icao(&union.icao24).await {
            Ok(reply) => {
                control.record(Bucket::States, 1, reply.remaining, control.now());
                remaining = reply.remaining.or(remaining);
                data_time = data_time.max(reply.value.time);
                any = true;
                // Only what was asked for: OpenSky filters, but trust nothing.
                let wanted: Vec<OpenSkyState> = reply
                    .value
                    .states
                    .into_iter()
                    .filter(|s| union.icao24.contains(&s.icao24))
                    .collect();
                merge(&mut merged, wanted, Match::Aircraft);
            }
            Err(e) => error = Some(e),
        }
    }
    if error.is_none() {
        for area in &union.areas {
            match provider.states_in_area(area).await {
                Ok(reply) => {
                    control.record(
                        Bucket::States,
                        budget::area_cost(area),
                        reply.remaining,
                        control.now(),
                    );
                    remaining = reply.remaining.or(remaining);
                    data_time = data_time.max(reply.value.time);
                    any = true;
                    // "Until the aircraft leave the area": a state outside the
                    // box (OpenSky's edge rounding) is not this area's.
                    let inside: Vec<OpenSkyState> = reply
                        .value
                        .states
                        .into_iter()
                        .filter(|s| match (s.latitude, s.longitude) {
                            (Some(lat), Some(lon)) => area.contains(lat, lon),
                            _ => false,
                        })
                        .collect();
                    merge(
                        &mut merged,
                        inside,
                        Match::Area {
                            id: area.id.clone(),
                        },
                    );
                }
                Err(e) => {
                    error = Some(e);
                    break;
                }
            }
        }
    }

    CycleResult {
        message: any.then(|| StatesMessage {
            version: STATES_VERSION,
            fetched_ms: control.now(),
            data_time,
            states: merged.into_values().collect(),
        }),
        error,
        remaining,
    }
}

/// Back-off after `failures` consecutive transient failures (1-based).
pub fn retry_delay(failures: u32) -> Duration {
    let exp = failures.saturating_sub(1).min(8);
    (FIRST_RETRY * 2u32.pow(exp)).min(MAX_RETRY)
}

/// Whether `now` watches something `before` did not.
pub fn grew(before: &WatchUnion, now: &WatchUnion) -> bool {
    now.icao24.iter().any(|h| !before.icao24.contains(h))
        || now
            .areas
            .iter()
            .any(|a| !before.areas.iter().any(|b| b == a))
}

/// Runs until `shutdown` turns true.
pub async fn run(
    control: Arc<Control>,
    states_tx: watch::Sender<Option<StatesMessage>>,
    status_tx: watch::Sender<OpenSkyStatus>,
    mut shutdown: watch::Receiver<bool>,
) {
    let provider = control.provider();
    let mut changes = control.subscribe();
    let min_ms = control.budget().min_interval.as_millis() as i64;
    let mut r = Reported::default();
    let mut polled = WatchUnion::default();
    let mut last_poll_ms: Option<i64> = None;
    let mut next_poll_ms: Option<i64> = None;
    let mut was_enabled = control.enabled();

    loop {
        let now = control.now();
        control.expire(now);
        let union = control.union(now);
        let enabled = control.enabled();
        if enabled && !was_enabled {
            // Re-enabling is how an operator says "try the credentials again".
            r.unauthorized = false;
        }
        was_enabled = enabled;

        let cost = budget::cycle_cost(union.icao24.len(), &union.areas);
        r.cycle_cost = cost;
        let mut wait: Option<i64> = None;

        if !enabled {
            r.state = Some(ServiceState::Disabled);
            r.next_poll_ms = None;
        } else if r.unauthorized {
            r.state = Some(ServiceState::Unauthorized);
            r.next_poll_ms = None;
        } else if union.is_empty() {
            r.state = Some(ServiceState::Idle);
            r.interval = None;
            r.next_poll_ms = None;
            next_poll_ms = None;
            polled = WatchUnion::default();
        } else {
            let earliest = last_poll_ms.map_or(now, |t| (t + min_ms).max(now));
            let mut due = match next_poll_ms {
                None => earliest,
                Some(t) if grew(&polled, &union) => t.min(earliest),
                Some(t) => t,
            };
            // The ledger: our own count of the last 24 h.
            let ledger_wait = control.wait_until_available(Bucket::States, cost, now);
            due = due.max(now + ledger_wait.as_millis() as i64);
            if let Some(until) = r.rate_limited_until_ms {
                due = due.max(until);
            }
            next_poll_ms = Some(due);
            r.next_poll_ms = Some(due);

            if now >= due {
                r.state = Some(ServiceState::Polling);
                status_tx.send_replace(build_status(&control, &r, now));
                let result = poll_cycle(provider.as_ref(), &control, &union).await;
                let after = control.now();
                last_poll_ms = Some(now);
                polled = union.clone();
                apply(&mut r, &control, &result, cost, after);
                if let Some(message) = result.message {
                    states_tx.send_replace(Some(message));
                }
                next_poll_ms = r.next_poll_ms;
                status_tx.send_replace(build_status(&control, &r, after));
                continue;
            }
            if r.state == Some(ServiceState::Idle)
                || r.state == Some(ServiceState::Disabled)
                || r.state.is_none()
            {
                r.state = Some(ServiceState::Waiting);
            }
            r.interval = control.planned_interval(&union);
            wait = Some(due - now);
        }

        status_tx.send_replace(build_status(&control, &r, now));

        // Also wake when a lease lapses, to stop polling and say so.
        let expiry = control.next_expiry().map(|t| (t - now).max(0));
        let sleep_ms = match (wait, expiry) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let sleep = async {
            match sleep_ms {
                Some(ms) => tokio::time::sleep(Duration::from_millis(ms.max(1) as u64)).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    if let Err(e) = control.flush() {
                        warn!("{e}");
                    }
                    return;
                }
            }
            changed = changes.changed() => {
                if changed.is_err() {
                    return;
                }
            }
            _ = sleep => {}
        }
    }
}

/// Folds a cycle's outcome into the report and schedules the next one.
fn apply(r: &mut Reported, control: &Control, result: &CycleResult, cost: u32, now: i64) {
    if result.message.is_some() {
        r.last_success_ms = Some(now);
    }
    let b = control.budget();
    let interval = budget::next_interval(
        cost,
        b.daily_credits,
        b.min_interval,
        control.used_last_24h(Bucket::States, now),
        control.wait_until_available(Bucket::States, cost, now),
        control.remaining(Bucket::States, now),
    );
    r.interval = Some(interval);
    let ms = |d: Duration| d.as_millis() as i64;
    match &result.error {
        None => {
            if r.consecutive_failures > 0 || r.rate_limited_until_ms.is_some() {
                info!("OpenSky polling recovered");
            }
            r.consecutive_failures = 0;
            r.last_error = None;
            r.rate_limited_until_ms = None;
            r.state = Some(ServiceState::Waiting);
            r.next_poll_ms = Some(now + ms(interval));
        }
        Some(ProviderError::RateLimited { retry_after }) => {
            let wait = retry_after.unwrap_or(DEFAULT_RATE_LIMIT_WAIT).max(interval);
            warn!(
                "OpenSky rate limit reached; next poll in {} s",
                wait.as_secs()
            );
            r.rate_limited_until_ms = Some(now + ms(wait));
            r.last_error = result.error.as_ref().map(ToString::to_string);
            r.state = Some(ServiceState::RateLimited);
            r.next_poll_ms = r.rate_limited_until_ms;
        }
        Some(ProviderError::Unauthorized(m)) => {
            warn!(
                "OpenSky refused the credentials ({m}); polling stopped. Fix client_id / \
                 client_secret and restart, or disable and re-enable to retry"
            );
            r.unauthorized = true;
            r.last_error = Some(m.clone());
            r.state = Some(ServiceState::Unauthorized);
            r.next_poll_ms = None;
        }
        Some(e) => {
            r.consecutive_failures += 1;
            let wait = retry_delay(r.consecutive_failures).max(interval);
            warn!(
                "OpenSky poll failed ({e}); retry {} in {} s",
                r.consecutive_failures,
                wait.as_secs()
            );
            r.last_error = Some(e.to_string());
            r.state = Some(ServiceState::Retrying);
            r.next_poll_ms = Some(now + ms(wait));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Area, WatchRequest};
    use crate::control::Budget;
    use crate::credits::Ledger;
    use crate::provider::Reply;
    use crate::states::{OpenSkyTrack, StatesResponse};
    use crate::watch::{WatchLimits, WatchSet};
    use std::sync::Mutex;

    fn state(icao: &str, t: i64, lat: f64, lon: f64) -> OpenSkyState {
        OpenSkyState {
            icao24: icao.into(),
            callsign: None,
            origin_country: None,
            time_position: Some(t),
            last_contact: Some(t),
            latitude: Some(lat),
            longitude: Some(lon),
            altitude_ft: Some(30_000.0),
            geo_altitude_ft: None,
            on_ground: false,
            ground_speed_kt: Some(400.0),
            track_deg: Some(90.0),
            vertical_rate_fpm: None,
            squawk: None,
            position_source: None,
        }
    }

    /// A scripted provider: returns `next` for every call and counts calls.
    struct Fake {
        calls: Mutex<Vec<String>>,
        next: Mutex<Result<Vec<OpenSkyState>, ProviderError>>,
        remaining: Option<i64>,
    }

    impl Fake {
        fn ok(states: Vec<OpenSkyState>) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(vec![]),
                next: Mutex::new(Ok(states)),
                remaining: None,
            })
        }
        fn failing(e: ProviderError) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(vec![]),
                next: Mutex::new(Err(e)),
                remaining: None,
            })
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn reply(&self, call: String) -> Result<Reply<StatesResponse>, ProviderError> {
            self.calls.lock().unwrap().push(call);
            self.next.lock().unwrap().clone().map(|states| Reply {
                value: StatesResponse { time: 100, states },
                remaining: self.remaining,
            })
        }
    }

    #[async_trait::async_trait]
    impl OpenSkyProvider for Fake {
        fn authenticated(&self) -> bool {
            true
        }
        async fn states_by_icao(
            &self,
            icao: &[String],
        ) -> Result<Reply<StatesResponse>, ProviderError> {
            self.reply(format!("icao:{}", icao.join(",")))
        }
        async fn states_in_area(
            &self,
            area: &Area,
        ) -> Result<Reply<StatesResponse>, ProviderError> {
            self.reply(format!("area:{}", area.id))
        }
        async fn track(
            &self,
            _: &str,
            _: Option<i64>,
        ) -> Result<Reply<OpenSkyTrack>, ProviderError> {
            Err(ProviderError::NotFound)
        }
    }

    const EPOCH: i64 = 1_764_000_000_000;

    fn control(provider: Arc<Fake>) -> Arc<Control> {
        let start = tokio::time::Instant::now();
        Arc::new(Control::new(
            WatchSet::new(WatchLimits::default(), 60_000),
            Ledger::default(),
            None,
            Budget {
                daily_credits: 4_000,
                min_interval: Duration::from_secs(10),
            },
            provider,
            Arc::new(move || EPOCH + start.elapsed().as_millis() as i64),
        ))
    }

    fn area(id: &str) -> Area {
        Area {
            id: id.into(),
            north: 48.0,
            south: 46.0,
            east: 0.0,
            west: -3.0,
        }
    }

    struct Running {
        states: watch::Receiver<Option<StatesMessage>>,
        status: watch::Receiver<OpenSkyStatus>,
        _shutdown: watch::Sender<bool>,
    }

    fn start(control: Arc<Control>) -> Running {
        let (states_tx, states) = watch::channel(None);
        let (status_tx, status) = watch::channel(OpenSkyStatus::initial(true, true, 4_000, EPOCH));
        let (shutdown_tx, shutdown) = watch::channel(false);
        tokio::spawn(run(control, states_tx, status_tx, shutdown));
        Running {
            states,
            status,
            _shutdown: shutdown_tx,
        }
    }

    /// Lets spawned tasks run, then moves the paused clock.
    async fn advance(secs: u64) {
        for _ in 0..secs {
            tokio::time::advance(Duration::from_secs(1)).await;
            tokio::task::yield_now().await;
        }
        tokio::task::yield_now().await;
    }

    fn watch(icao: &[&str], areas: Vec<Area>) -> WatchRequest {
        WatchRequest {
            icao24: icao.iter().map(|s| s.to_string()).collect(),
            areas,
        }
    }

    #[test]
    fn an_aircraft_seen_twice_keeps_the_newer_position_and_both_tags() {
        let mut m = BTreeMap::new();
        merge(
            &mut m,
            vec![state("3c6444", 10, 47.0, -1.0)],
            Match::Aircraft,
        );
        merge(
            &mut m,
            vec![
                state("3c6444", 12, 47.1, -1.1),
                state("39de4f", 5, 46.5, -2.0),
            ],
            Match::Area { id: "w".into() },
        );
        assert_eq!(m.len(), 2);
        let s = &m["3c6444"];
        assert_eq!(s.state.time_position, Some(12));
        assert_eq!(
            s.matched,
            vec![Match::Aircraft, Match::Area { id: "w".into() }]
        );
    }

    #[test]
    fn retries_back_off_to_ten_minutes() {
        assert_eq!(retry_delay(1), Duration::from_secs(30));
        assert_eq!(retry_delay(2), Duration::from_secs(60));
        assert_eq!(retry_delay(10), MAX_RETRY);
    }

    #[test]
    fn growth_is_a_new_target_not_a_removed_one() {
        let a = WatchUnion {
            icao24: vec!["000001".into()],
            areas: vec![],
            clients: 1,
        };
        let b = WatchUnion {
            icao24: vec!["000001".into(), "000002".into()],
            areas: vec![],
            clients: 1,
        };
        assert!(grew(&a, &b));
        assert!(!grew(&b, &a));
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_watched_costs_nothing() {
        let fake = Fake::ok(vec![]);
        let c = control(fake.clone());
        let r = start(c);
        advance(600).await;
        assert!(fake.calls().is_empty());
        assert_eq!(r.status.borrow().state, ServiceState::Idle);
    }

    #[tokio::test(start_paused = true)]
    async fn a_watched_aircraft_is_polled_at_once_then_on_the_budget_interval() {
        let fake = Fake::ok(vec![state("3c6444", 100, 47.0, -1.0)]);
        let c = control(fake.clone());
        let r = start(c.clone());
        tokio::task::yield_now().await;
        c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        // Renew within the lease, as the desktop does.
        for _ in 0..5 {
            advance(20).await;
            c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        }
        // 0..100 s at one poll every 24 s: t = 0, 24, 48, 72, 96.
        assert_eq!(fake.calls().len(), 5, "{:?}", fake.calls());
        let msg = r.states.borrow().clone().unwrap();
        assert_eq!(msg.states[0].state.icao24, "3c6444");
        let status = r.status.borrow().clone();
        assert_eq!(status.credits.states_used_24h, 5);
        assert_eq!(status.interval_seconds, Some(24.0));
        assert_eq!(status.state, ServiceState::Waiting);
    }

    #[tokio::test(start_paused = true)]
    async fn polling_stops_when_the_lease_lapses() {
        let fake = Fake::ok(vec![]);
        let c = control(fake.clone());
        let r = start(c.clone());
        tokio::task::yield_now().await;
        c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        advance(600).await;
        // t = 0, 24, 48 before the 60 s lease lapses; nothing after.
        assert_eq!(fake.calls().len(), 3);
        assert_eq!(r.status.borrow().state, ServiceState::Idle);
    }

    #[tokio::test(start_paused = true)]
    async fn a_new_target_is_polled_after_the_minimum_interval_not_the_full_one() {
        let fake = Fake::ok(vec![]);
        let c = control(fake.clone());
        let _r = start(c.clone());
        tokio::task::yield_now().await;
        c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        advance(3).await;
        c.put_watch("laptop", &watch(&["3c6444"], vec![area("w")]))
            .unwrap();
        advance(6).await;
        assert_eq!(fake.calls().len(), 1, "not before 10 s");
        advance(2).await;
        assert_eq!(fake.calls(), ["icao:3c6444", "icao:3c6444", "area:w"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limit_waits_for_its_deadline() {
        let fake = Fake::failing(ProviderError::RateLimited {
            retry_after: Some(Duration::from_secs(300)),
        });
        let c = control(fake.clone());
        let r = start(c.clone());
        tokio::task::yield_now().await;
        c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        for _ in 0..14 {
            advance(20).await;
            c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        }
        assert_eq!(fake.calls().len(), 1, "no poll inside the 300 s deadline");
        let status = r.status.borrow().clone();
        assert_eq!(status.state, ServiceState::RateLimited);
        // 300 s after the poll, which ran within the first second.
        let until = status.rate_limited_until_ms.unwrap() - EPOCH;
        assert!((300_000..=301_000).contains(&until), "{until}");
        assert_eq!(status.credits.states_used_24h, 0, "a 429 costs nothing");
    }

    #[tokio::test(start_paused = true)]
    async fn refused_credentials_stop_polling() {
        let fake = Fake::failing(ProviderError::Unauthorized("HTTP 401".into()));
        let c = control(fake.clone());
        let r = start(c.clone());
        tokio::task::yield_now().await;
        c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        for _ in 0..5 {
            advance(20).await;
            c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        }
        assert_eq!(fake.calls().len(), 1);
        assert_eq!(r.status.borrow().state, ServiceState::Unauthorized);
    }

    #[tokio::test(start_paused = true)]
    async fn disabling_pauses_polling() {
        let fake = Fake::ok(vec![]);
        let c = control(fake.clone());
        let r = start(c.clone());
        c.set_enabled(false);
        tokio::task::yield_now().await;
        c.put_watch("laptop", &watch(&["3c6444"], vec![])).unwrap();
        advance(50).await;
        assert!(fake.calls().is_empty());
        assert_eq!(r.status.borrow().state, ServiceState::Disabled);
        c.set_enabled(true);
        advance(1).await;
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn area_states_outside_the_box_are_dropped() {
        let fake = Fake::ok(vec![
            state("3c6444", 100, 47.0, -1.0),
            state("39de4f", 100, 49.0, -1.0),
        ]);
        let c = control(fake.clone());
        let r = start(c.clone());
        tokio::task::yield_now().await;
        c.put_watch("laptop", &watch(&[], vec![area("w")])).unwrap();
        advance(1).await;
        let msg = r.states.borrow().clone().unwrap();
        let ids: Vec<&str> = msg.states.iter().map(|s| s.state.icao24.as_str()).collect();
        assert_eq!(ids, ["3c6444"]);
        assert_eq!(msg.states[0].matched, vec![Match::Area { id: "w".into() }]);
    }
}
