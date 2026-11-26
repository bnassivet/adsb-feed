//! The OpenSky credit budget, and the poll interval it allows.
//!
//! OpenSky charges `/states/all` in credits from a daily allowance: 400
//! anonymous, 4,000 for a registered user, 8,000 for an active feeder. A query
//! by icao24 costs 1 credit however many aircraft it names; a box costs 1 to 4
//! by its area. A fixed 10 s poll of one small box is 8,640 credits a day,
//! twice a registered user's allowance, so the interval is computed from the
//! cost of one cycle rather than configured.
//!
//! Pure: callers pass what they know (cycle cost, credits used in the last
//! 24 h, OpenSky's own remaining count) and get back how long to wait.

use crate::api::Area;
use std::time::Duration;

/// Daily `/states` credits without an account.
pub const ANONYMOUS_DAILY_CREDITS: u32 = 400;

/// Daily credits of a registered OpenSky user.
pub const DEFAULT_DAILY_CREDITS: u32 = 4_000;

/// Daily credits of an active feeder (a receiver feeding OpenSky with at least
/// 30% uptime over the last month). OpenSky's replies say what is left, never
/// which allowance the account has, so this is configured (`feeder`).
pub const FEEDER_DAILY_CREDITS: u32 = 8_000;

/// Share of the daily allowance the scheduler plans to spend. The rest is
/// headroom for backfills on the same account, restarts and clock skew.
pub const SPEND_FRACTION: f64 = 0.9;

/// OpenSky's time resolution for authenticated users: asking more often
/// returns the same data.
pub const AUTHENTICATED_RESOLUTION: Duration = Duration::from_secs(5);

/// The same for anonymous users.
pub const ANONYMOUS_RESOLUTION: Duration = Duration::from_secs(10);

/// What a `/tracks/all` call costs for a live flight.
pub const LIVE_TRACK_COST: u32 = 4;

/// What a `/tracks/all` call is charged when its flight is more than a day
/// old. OpenSky's table (4 live or under 24 h, 30 for one or two day
/// partitions) is ambiguous for a single past flight, so this is the
/// conservative reading; [`observed_cost`] corrects it when OpenSky counted.
pub const PAST_TRACK_COST: u32 = 30;

/// The most a single `/tracks` call can plausibly cost. A larger drop in
/// OpenSky's remaining count is a reset or another app, not this call.
pub const MAX_TRACK_COST: u32 = 960;

/// How far back OpenSky keeps flight tracks.
pub const TRACK_HISTORY_MS: i64 = 30 * 86_400_000;

/// The estimated cost of a `/tracks/all` call: live (`None`) or a flight
/// within the last day costs [`LIVE_TRACK_COST`], an older one
/// [`PAST_TRACK_COST`].
pub fn track_cost(time_s: Option<i64>, now_ms: i64) -> u32 {
    match time_s {
        Some(t) if now_ms - t * 1_000 > 86_400_000 => PAST_TRACK_COST,
        _ => LIVE_TRACK_COST,
    }
}

/// What a call cost, from OpenSky's remaining count before and after it,
/// falling back to `estimate` when either is unknown or the difference is not
/// a plausible single charge.
pub fn observed_cost(before: Option<i64>, after: Option<i64>, estimate: u32) -> u32 {
    match (before, after) {
        (Some(b), Some(a)) if b >= a && b - a <= i64::from(MAX_TRACK_COST) => (b - a) as u32,
        _ => estimate,
    }
}

/// What OpenSky charges for a `/states/all` query over `area`.
pub fn area_cost(area: &Area) -> u32 {
    match area.square_degrees() {
        sq if sq <= 25.0 => 1,
        sq if sq <= 100.0 => 2,
        sq if sq <= 400.0 => 3,
        _ => 4,
    }
}

/// What one poll cycle costs: one call for all the aircraft together, plus
/// one per area.
pub fn cycle_cost(aircraft: usize, areas: &[Area]) -> u32 {
    u32::from(aircraft > 0) + areas.iter().map(area_cost).sum::<u32>()
}

/// What the budget allows the scheduler to spend in 24 h.
pub fn allowance(daily_credits: u32) -> f64 {
    f64::from(daily_credits) * SPEND_FRACTION
}

/// The steady interval between cycles: the allowance spread evenly over a
/// day, never faster than `min_interval`.
pub fn steady_interval(cycle_cost: u32, daily_credits: u32, min_interval: Duration) -> Duration {
    if cycle_cost == 0 {
        return min_interval;
    }
    let per_day = allowance(daily_credits).max(1.0);
    let secs = f64::from(cycle_cost) * 86_400.0 / per_day;
    Duration::from_secs_f64(secs).max(min_interval)
}

/// Credits per day a cycle every `interval` spends.
pub fn daily_spend(cycle_cost: u32, interval: Duration) -> f64 {
    let secs = interval.as_secs_f64().max(1.0);
    f64::from(cycle_cost) * 86_400.0 / secs
}

/// How long to wait before the next cycle.
///
/// - `steady`: from [`steady_interval`].
/// - `used_24h` / `wait_for_ledger`: our own count. Over the allowance, wait
///   until enough of it ages out (the ledger computes when).
/// - `remaining`: OpenSky's `X-Rate-Limit-Remaining` from the last reply. It
///   counts the whole account -- another app on the same login spends it too
///   -- so when it is lower than our own count implies, it wins: the rest is
///   spread over a day.
pub fn next_interval(
    cycle_cost: u32,
    daily_credits: u32,
    min_interval: Duration,
    used_24h: u32,
    wait_for_ledger: Duration,
    remaining: Option<i64>,
) -> Duration {
    let mut interval = steady_interval(cycle_cost, daily_credits, min_interval);
    if f64::from(used_24h + cycle_cost) > allowance(daily_credits) {
        interval = interval.max(wait_for_ledger);
    }
    if let Some(remaining) = remaining {
        if remaining < i64::from(cycle_cost) {
            // Spent, by OpenSky's count. Its window is not documented; an
            // hour is a guess that costs a few failed polls at worst.
            interval = interval.max(Duration::from_secs(3_600));
        } else {
            let spread = f64::from(cycle_cost) * 86_400.0 / remaining as f64;
            interval = interval.max(Duration::from_secs_f64(spread));
        }
    }
    interval
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(sq_side: f64) -> Area {
        Area {
            id: "a".into(),
            north: sq_side,
            south: 0.0,
            east: sq_side,
            west: 0.0,
        }
    }

    const MIN: Duration = Duration::from_secs(10);

    #[test]
    fn area_cost_follows_opensky_s_table() {
        assert_eq!(area_cost(&area(5.0)), 1); // 25 sq°
        assert_eq!(area_cost(&area(5.1)), 2);
        assert_eq!(area_cost(&area(10.0)), 2); // 100
        assert_eq!(area_cost(&area(20.0)), 3); // 400
        assert_eq!(area_cost(&area(21.0)), 4);
    }

    #[test]
    fn all_aircraft_share_one_credit() {
        assert_eq!(cycle_cost(0, &[]), 0);
        assert_eq!(cycle_cost(1, &[]), 1);
        assert_eq!(cycle_cost(20, &[]), 1);
        assert_eq!(cycle_cost(3, &[area(2.0), area(10.0)]), 4);
    }

    #[test]
    fn a_fixed_ten_second_poll_would_overspend_a_registered_user() {
        // The reason this module exists.
        assert!(daily_spend(1, Duration::from_secs(10)) > f64::from(DEFAULT_DAILY_CREDITS));
    }

    #[test]
    fn one_credit_a_cycle_on_4000_credits_polls_every_24_seconds() {
        // 86,400 / 3,600 usable credits.
        assert_eq!(
            steady_interval(1, DEFAULT_DAILY_CREDITS, MIN),
            Duration::from_secs(24)
        );
    }

    #[test]
    fn a_feeder_polls_twice_as_often() {
        assert_eq!(steady_interval(1, 8_000, MIN), Duration::from_secs(12));
    }

    #[test]
    fn the_interval_never_drops_below_the_minimum() {
        assert_eq!(steady_interval(1, 1_000_000, MIN), MIN);
        assert_eq!(steady_interval(0, 4_000, MIN), MIN);
    }

    #[test]
    fn a_costlier_cycle_waits_proportionally_longer() {
        assert_eq!(
            steady_interval(4, DEFAULT_DAILY_CREDITS, MIN),
            Duration::from_secs(96)
        );
    }

    #[test]
    fn the_steady_interval_stays_within_the_allowance() {
        for cost in 1..=9 {
            let interval = steady_interval(cost, DEFAULT_DAILY_CREDITS, MIN);
            assert!(daily_spend(cost, interval) <= allowance(DEFAULT_DAILY_CREDITS) + 1e-6);
        }
    }

    #[test]
    fn over_the_allowance_the_ledger_decides() {
        let wait = Duration::from_secs(900);
        let i = next_interval(1, 4_000, MIN, 3_600, wait, None);
        assert_eq!(i, wait);
        // Under it, the ledger's wait is ignored.
        let i = next_interval(1, 4_000, MIN, 100, wait, None);
        assert_eq!(i, Duration::from_secs(24));
    }

    #[test]
    fn opensky_s_lower_count_stretches_the_interval() {
        // 864 credits left: one a cycle spread over a day is every 100 s.
        let i = next_interval(1, 4_000, MIN, 0, Duration::ZERO, Some(864));
        assert_eq!(i, Duration::from_secs(100));
        // Plenty left: the steady interval stands.
        let i = next_interval(1, 4_000, MIN, 0, Duration::ZERO, Some(3_999));
        assert_eq!(i, Duration::from_secs(24));
    }

    #[test]
    fn nothing_left_waits_an_hour() {
        let i = next_interval(2, 4_000, MIN, 0, Duration::ZERO, Some(1));
        assert_eq!(i, Duration::from_secs(3_600));
    }

    const DAY_MS: i64 = 86_400_000;

    #[test]
    fn a_track_costs_4_live_or_within_a_day_and_30_older() {
        let now = 40 * DAY_MS;
        assert_eq!(track_cost(None, now), 4);
        assert_eq!(track_cost(Some((now - 23 * 3_600_000) / 1_000), now), 4);
        assert_eq!(track_cost(Some((now - 25 * 3_600_000) / 1_000), now), 30);
    }

    #[test]
    fn the_observed_cost_wins_when_opensky_counted_it() {
        assert_eq!(observed_cost(Some(4_000), Some(3_996), 30), 4);
        // Unknown before or after: the estimate.
        assert_eq!(observed_cost(None, Some(3_996), 30), 30);
        assert_eq!(observed_cost(Some(4_000), None, 30), 30);
        // A reset or another app's spend makes the difference meaningless.
        assert_eq!(observed_cost(Some(100), Some(3_990), 30), 30);
        assert_eq!(observed_cost(Some(4_000), Some(2_000), 30), 30);
    }
}
