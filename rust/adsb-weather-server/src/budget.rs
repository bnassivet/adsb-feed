//! Open-Meteo call budget.
//!
//! The free tier allows 10,000 calls a day. Two rules make that tighter than it
//! looks: each location in a multi-location request counts as a call, and a
//! request for more than 10 variables counts fractionally more (15 variables =
//! 1.5 calls). A grid refreshed hourly can reach the limit without any single
//! request looking large, so the estimate is computed and logged up front.

use std::time::Duration;

/// Open-Meteo free tier, calls per day.
pub const FREE_DAILY_LIMIT: f64 = 10_000.0;

/// Open-Meteo free tier, calls per minute.
pub const MINUTELY_LIMIT: f64 = 600.0;

/// Open-Meteo free tier, calls per hour.
pub const HOURLY_LIMIT: f64 = 5_000.0;

/// Share of the per-minute limit the pacer spends. The limit is per IP, so the
/// headroom is for anything else behind the same uplink calling the API.
pub const PACE_FRACTION: f64 = 0.8;

/// Above this the service warns: retries and restarts need headroom.
pub const WARN_DAILY_CALLS: f64 = 8_000.0;

/// Surface variables requested per location: MSL pressure, 10 m wind speed and
/// direction.
pub const SURFACE_VARIABLES: usize = 3;

/// Variables requested per pressure level: wind speed and direction.
pub const VARIABLES_PER_LEVEL: usize = 2;

/// How an estimate compares with the free tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetVerdict {
    Ok,
    Warn,
    OverLimit,
}

/// Variables requested per location for `levels` pressure levels.
pub fn variables_per_location(levels: usize) -> usize {
    SURFACE_VARIABLES + VARIABLES_PER_LEVEL * levels
}

/// How many calls one location costs for `variables` variables.
pub fn call_weight(variables: usize) -> f64 {
    (variables as f64 / 10.0).max(1.0)
}

/// Estimated calls per day for a grid refreshed every `refresh_minutes`.
///
/// A zero refresh interval is treated as one minute rather than dividing by
/// zero; config validation rejects it before this is reached.
pub fn estimated_daily_calls(points: usize, variables: usize, refresh_minutes: u32) -> f64 {
    let refreshes_per_day = 1440.0 / refresh_minutes.max(1) as f64;
    points as f64 * call_weight(variables) * refreshes_per_day
}

/// Calls one refresh of the whole grid costs.
pub fn calls_per_refresh(points: usize, variables: usize) -> f64 {
    points as f64 * call_weight(variables)
}

/// How long pacing stretches one refresh that starts with a full bucket:
/// zero while it fits in the per-minute allowance.
pub fn estimated_pacing(calls: f64) -> Duration {
    let bucket = TokenBucket::open_meteo_minutely();
    let excess = (calls - bucket.capacity).max(0.0);
    Duration::from_secs_f64(excess / bucket.per_second)
}

/// A token bucket counted in Open-Meteo calls.
///
/// Pure: the caller supplies a monotonic `now`, so the arithmetic is tested
/// without a clock and the provider decides how to sleep.
#[derive(Debug, Clone)]
pub struct TokenBucket {
    capacity: f64,
    per_second: f64,
    tokens: f64,
    /// When `tokens` was last accounted for. Can be ahead of the caller's
    /// `now` while a reservation is still waiting.
    updated: Duration,
}

impl TokenBucket {
    /// A full bucket of `capacity` calls, refilled at `per_second`.
    pub fn new(capacity: f64, per_second: f64) -> Self {
        Self {
            capacity,
            per_second,
            tokens: capacity,
            updated: Duration::ZERO,
        }
    }

    /// [`PACE_FRACTION`] of Open-Meteo's per-minute limit, refilled evenly.
    pub fn open_meteo_minutely() -> Self {
        let capacity = MINUTELY_LIMIT * PACE_FRACTION;
        Self::new(capacity, capacity / 60.0)
    }

    /// Reserves `cost` calls at `now` and returns how long to wait before
    /// spending them.
    ///
    /// A cost above capacity waits for a full bucket and then overdraws it,
    /// which pushes later reservations back, rather than never being allowed.
    /// Reservations made without waiting queue behind each other.
    pub fn reserve(&mut self, cost: f64, now: Duration) -> Duration {
        if now > self.updated {
            let elapsed = (now - self.updated).as_secs_f64();
            self.tokens = (self.tokens + elapsed * self.per_second).min(self.capacity);
            self.updated = now;
        }
        let needed = cost.min(self.capacity);
        let refill = if self.tokens >= needed {
            Duration::ZERO
        } else {
            Duration::from_secs_f64((needed - self.tokens) / self.per_second)
        };
        let ready_at = self.updated + refill;
        self.tokens += refill.as_secs_f64() * self.per_second - cost;
        self.updated = ready_at;
        ready_at.saturating_sub(now)
    }
}

/// Classifies a daily estimate.
pub fn verdict(daily_calls: f64) -> BudgetVerdict {
    if daily_calls > FREE_DAILY_LIMIT {
        BudgetVerdict::OverLimit
    } else if daily_calls > WARN_DAILY_CALLS {
        BudgetVerdict::Warn
    } else {
        BudgetVerdict::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_levels_request_fifteen_variables() {
        assert_eq!(variables_per_location(6), 15);
        assert_eq!(variables_per_location(0), SURFACE_VARIABLES);
    }

    #[test]
    fn up_to_ten_variables_cost_one_call() {
        assert_eq!(call_weight(3), 1.0);
        assert_eq!(call_weight(10), 1.0);
    }

    #[test]
    fn more_than_ten_variables_cost_fractionally_more() {
        // Open-Meteo's own example: 15 variables = 1.5 calls.
        assert_eq!(call_weight(15), 1.5);
        assert_eq!(call_weight(21), 2.1);
    }

    #[test]
    fn default_grid_fits_the_free_tier() {
        // 187 points, 6 levels, hourly: 187 × 1.5 × 24.
        let daily = estimated_daily_calls(187, variables_per_location(6), 60);
        assert!((daily - 6_732.0).abs() < 1e-9, "got {daily}");
        assert_eq!(verdict(daily), BudgetVerdict::Ok);
    }

    #[test]
    fn halving_the_refresh_interval_doubles_the_cost() {
        let hourly = estimated_daily_calls(187, 15, 60);
        let half_hourly = estimated_daily_calls(187, 15, 30);
        assert!((half_hourly - 2.0 * hourly).abs() < 1e-9);
        assert_eq!(verdict(half_hourly), BudgetVerdict::OverLimit);
    }

    #[test]
    fn zero_refresh_does_not_divide_by_zero() {
        assert!(estimated_daily_calls(1, 3, 0).is_finite());
    }

    #[test]
    fn verdict_thresholds() {
        assert_eq!(verdict(WARN_DAILY_CALLS), BudgetVerdict::Ok);
        assert_eq!(verdict(WARN_DAILY_CALLS + 1.0), BudgetVerdict::Warn);
        assert_eq!(verdict(FREE_DAILY_LIMIT), BudgetVerdict::Warn);
        assert_eq!(verdict(FREE_DAILY_LIMIT + 1.0), BudgetVerdict::OverLimit);
    }

    // --- pacing -------------------------------------------------------------

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn a_full_bucket_spends_without_waiting() {
        let mut bucket = TokenBucket::new(10.0, 1.0);
        assert_eq!(bucket.reserve(4.0, S(0)), Duration::ZERO);
        assert_eq!(bucket.reserve(6.0, S(0)), Duration::ZERO);
        assert_eq!(bucket.reserve(1.0, S(0)), S(1));
    }

    #[test]
    fn tokens_refill_over_time() {
        let mut bucket = TokenBucket::new(10.0, 1.0);
        bucket.reserve(10.0, S(0));
        // Two seconds later there are two tokens; five are needed.
        assert_eq!(bucket.reserve(5.0, S(2)), S(3));
    }

    #[test]
    fn a_refill_never_exceeds_capacity() {
        let mut bucket = TokenBucket::new(10.0, 1.0);
        bucket.reserve(10.0, S(0));
        assert_eq!(bucket.reserve(10.0, S(1000)), Duration::ZERO);
        assert_eq!(bucket.reserve(1.0, S(1000)), S(1));
    }

    #[test]
    fn a_cost_above_capacity_waits_for_a_full_bucket_then_overdraws() {
        let mut bucket = TokenBucket::new(10.0, 1.0);
        bucket.reserve(5.0, S(0));
        // Five tokens left; a full bucket is five seconds away.
        assert_eq!(bucket.reserve(15.0, S(0)), S(5));
        // Overdrawn to -5 at t=5: one more token is six seconds after that.
        assert_eq!(bucket.reserve(1.0, S(5)), S(6));
    }

    #[test]
    fn reservations_made_without_waiting_queue_behind_each_other() {
        let mut bucket = TokenBucket::new(1.0, 1.0);
        assert_eq!(bucket.reserve(1.0, S(0)), Duration::ZERO);
        assert_eq!(bucket.reserve(1.0, S(0)), S(1));
        assert_eq!(bucket.reserve(1.0, S(0)), S(2));
    }

    #[test]
    fn the_open_meteo_pacer_spends_80_percent_of_the_minutely_limit() {
        let mut bucket = TokenBucket::open_meteo_minutely();
        assert_eq!(bucket.reserve(480.0, S(0)), Duration::ZERO);
        // 480 calls a minute refill at 8 a second.
        assert_eq!(bucket.reserve(8.0, S(0)), S(1));
    }

    #[test]
    fn the_default_grid_needs_no_pacing() {
        let calls = calls_per_refresh(187, variables_per_location(6));
        assert!((calls - 280.5).abs() < 1e-9, "got {calls}");
        assert_eq!(estimated_pacing(calls), Duration::ZERO);
    }

    #[test]
    fn a_fine_grid_is_spread_over_more_than_a_minute() {
        // 750 points at 0.5 degrees: 1125 calls, 645 over the allowance, at 8/s.
        let calls = calls_per_refresh(750, variables_per_location(6));
        assert_eq!(estimated_pacing(calls), Duration::from_secs_f64(80.625));
    }
}
