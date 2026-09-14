//! Open-Meteo call budget.
//!
//! The free tier allows 10,000 calls a day. Two rules make that tighter than it
//! looks: each location in a multi-location request counts as a call, and a
//! request for more than 10 variables counts fractionally more (15 variables =
//! 1.5 calls). A grid refreshed hourly can reach the limit without any single
//! request looking large, so the estimate is computed and logged up front.

/// Open-Meteo free tier, calls per day.
pub const FREE_DAILY_LIMIT: f64 = 10_000.0;

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
}
