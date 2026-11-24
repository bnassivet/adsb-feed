//! Point-in-time receiver locations (slowly changing dimension, type 2).
//!
//! A receiver's position is a list of [`LocationPeriod`]s. Each period is the
//! half-open interval `[valid_from_ms, valid_to_ms)`; `valid_to_ms = None`
//! means the period is still current. A fix stamped at `ts` belongs to the
//! period with `valid_from_ms <= ts < valid_to_ms`, which is exactly the range
//! join the storage layer uses.
//!
//! The operations here are pure: they take the current periods of ONE
//! receiver and return the replacement set, or an error. Storage swaps the
//! whole set in one transaction, so the invariants below are checked once,
//! here, and the database never holds a half-applied change:
//!
//! - periods are sorted by `valid_from_ms` and never overlap;
//! - at most one period is open, and only the last one may be;
//! - every period is non-empty (`valid_from_ms < valid_to_ms`).
//!
//! Gaps are allowed: they are times for which the location is unknown.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::geo::haversine_nm;

/// Two positions closer than this are the same position (about 1 m).
///
/// Re-announcing an unchanged position (a retained MQTT message on every
/// reconnect, a recorder restart) must not open a new period, and float
/// round-trips through TOML and JSON must not either.
pub const SAME_POSITION_NM: f64 = 1.0 / 1852.0;

/// Two altitudes closer than this (feet) are the same altitude.
pub const SAME_ALTITUDE_FT: f64 = 1.0;

/// An antenna position.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ReceiverPosition {
    pub latitude: f64,
    pub longitude: f64,
    /// Antenna altitude in feet, when known.
    pub altitude_ft: Option<f64>,
}

impl ReceiverPosition {
    pub fn new(latitude: f64, longitude: f64, altitude_ft: Option<f64>) -> Self {
        Self {
            latitude,
            longitude,
            altitude_ft,
        }
    }

    /// Finite and on the globe.
    pub fn validate(&self) -> Result<(), HistoryError> {
        let lat_ok = self.latitude.is_finite() && (-90.0..=90.0).contains(&self.latitude);
        let lon_ok = self.longitude.is_finite() && (-180.0..=180.0).contains(&self.longitude);
        let alt_ok = self.altitude_ft.is_none_or(f64::is_finite);
        if lat_ok && lon_ok && alt_ok {
            Ok(())
        } else {
            Err(HistoryError::InvalidPosition(*self))
        }
    }

    /// Within [`SAME_POSITION_NM`] horizontally and [`SAME_ALTITUDE_FT`]
    /// vertically. A known altitude never equals an unknown one: learning
    /// the altitude is a change worth recording.
    pub fn same_as(&self, other: &ReceiverPosition) -> bool {
        let horizontal = haversine_nm(
            self.latitude,
            self.longitude,
            other.latitude,
            other.longitude,
        ) < SAME_POSITION_NM;
        let vertical = match (self.altitude_ft, other.altitude_ft) {
            (None, None) => true,
            (Some(a), Some(b)) => (a - b).abs() < SAME_ALTITUDE_FT,
            _ => false,
        };
        horizontal && vertical
    }
}

/// Who or what recorded a period.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocationOrigin {
    /// The recorder's own `[receiver]` configuration, at startup.
    Config,
    /// A feed's retained announcement on the bus.
    Mqtt,
    /// `adsb-data-server receiver ...`.
    Cli,
    /// The desktop's location-history editor.
    Desktop,
    /// The first period of a receiver that had data before it had a
    /// location, stretched back to its oldest stored fix.
    Backfill,
}

impl LocationOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Mqtt => "mqtt",
            Self::Cli => "cli",
            Self::Desktop => "desktop",
            Self::Backfill => "backfill",
        }
    }

    /// The inverse of [`as_str`](Self::as_str). Unknown text (a newer writer)
    /// reads as `Cli` rather than failing the whole history.
    pub fn parse(text: &str) -> Self {
        match text {
            "config" => Self::Config,
            "mqtt" => Self::Mqtt,
            "desktop" => Self::Desktop,
            "backfill" => Self::Backfill,
            _ => Self::Cli,
        }
    }
}

/// One row of a receiver's location history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocationPeriod {
    pub valid_from_ms: i64,
    /// Exclusive end; `None` while current.
    pub valid_to_ms: Option<i64>,
    pub position: ReceiverPosition,
    pub origin: LocationOrigin,
    /// When this row was last written (not when it became valid).
    pub recorded_at_ms: i64,
    pub note: Option<String>,
}

impl LocationPeriod {
    /// Whether `ts` falls inside `[valid_from_ms, valid_to_ms)`.
    pub fn contains(&self, ts: i64) -> bool {
        ts >= self.valid_from_ms && self.valid_to_ms.is_none_or(|to| ts < to)
    }
}

/// A receiver known to the database, with where it is now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiverSummary {
    pub source_id: String,
    pub name: Option<String>,
    pub first_seen_ms: i64,
    /// The open period, if the receiver's current location is known.
    pub current: Option<LocationPeriod>,
    /// How many periods its history holds.
    pub period_count: i64,
}

/// Provenance stamped on whatever a change writes.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeStamp {
    pub origin: LocationOrigin,
    pub recorded_at_ms: i64,
    pub note: Option<String>,
}

/// A requested change to one receiver's history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocationChange {
    /// The receiver is at `position` from `at_ms` onwards (see [`observe`]).
    Observe {
        position: ReceiverPosition,
        at_ms: i64,
    },
    /// The receiver moved to `position` at `at_ms`, possibly in the past
    /// (see [`move_at`]).
    Move {
        position: ReceiverPosition,
        at_ms: i64,
    },
    /// The period starting at `valid_from_ms` was really at `position`
    /// (see [`correct`]).
    Correct {
        valid_from_ms: i64,
        position: ReceiverPosition,
    },
    /// The period starting at `valid_from_ms` never happened (see [`remove`]).
    Remove { valid_from_ms: i64 },
}

/// Why a change was refused.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum HistoryError {
    #[error("invalid receiver position {0:?}")]
    InvalidPosition(ReceiverPosition),
    #[error("no location period starts at {0}")]
    NoSuchPeriod(i64),
    #[error("a location period already starts at {0}; correct it instead")]
    PeriodStartsAt(i64),
    #[error(
        "observation at {at_ms} predates the current period, which starts at {current_from_ms}"
    )]
    StaleObservation { at_ms: i64, current_from_ms: i64 },
    #[error("location periods overlap or are out of order at {0}")]
    Inconsistent(i64),
}

/// Applies `change` to `periods` (see the individual functions).
///
/// `Ok(None)` means the change is a no-op and nothing needs writing.
pub fn apply(
    periods: &[LocationPeriod],
    change: &LocationChange,
    stamp: &ChangeStamp,
) -> Result<Option<Vec<LocationPeriod>>, HistoryError> {
    let out = match change {
        LocationChange::Observe { position, at_ms } => observe(periods, *position, *at_ms, stamp)?,
        LocationChange::Move { position, at_ms } => move_at(periods, *position, *at_ms, stamp)?,
        LocationChange::Correct {
            valid_from_ms,
            position,
        } => correct(periods, *valid_from_ms, *position, stamp)?,
        LocationChange::Remove { valid_from_ms } => remove(periods, *valid_from_ms)?,
    };
    if let Some(out) = &out {
        validate(out)?;
    }
    Ok(out)
}

/// Checks the module invariants.
pub fn validate(periods: &[LocationPeriod]) -> Result<(), HistoryError> {
    let mut previous: Option<&LocationPeriod> = None;
    for p in periods {
        if p.valid_to_ms.is_some_and(|to| to <= p.valid_from_ms) {
            return Err(HistoryError::Inconsistent(p.valid_from_ms));
        }
        if let Some(prev) = previous {
            match prev.valid_to_ms {
                Some(to) if p.valid_from_ms >= to => {}
                _ => return Err(HistoryError::Inconsistent(p.valid_from_ms)),
            }
        }
        previous = Some(p);
    }
    Ok(())
}

/// The receiver reports itself at `position` as of `at_ms`.
///
/// - No history: one open period from `at_ms`.
/// - The current period already has this position: no-op (`Ok(None)`).
/// - The current period differs: it is closed at `at_ms` and a new open
///   period starts there. An observation dated at or before the start of the
///   current period cannot close it and is refused as stale, except one dated
///   exactly at its start, which corrects it in place.
/// - The last period is closed: a new open period starts at `at_ms`, which
///   must not fall inside the closed one.
pub fn observe(
    periods: &[LocationPeriod],
    position: ReceiverPosition,
    at_ms: i64,
    stamp: &ChangeStamp,
) -> Result<Option<Vec<LocationPeriod>>, HistoryError> {
    position.validate()?;
    let mut out = periods.to_vec();
    let Some(last) = out.last_mut() else {
        return Ok(Some(vec![new_period(at_ms, None, position, stamp)]));
    };
    match last.valid_to_ms {
        None => {
            if last.position.same_as(&position) {
                return Ok(None);
            }
            if at_ms < last.valid_from_ms {
                return Err(HistoryError::StaleObservation {
                    at_ms,
                    current_from_ms: last.valid_from_ms,
                });
            }
            if at_ms == last.valid_from_ms {
                restamp(last, position, stamp);
                return Ok(Some(out));
            }
            last.valid_to_ms = Some(at_ms);
        }
        Some(to) if at_ms < to => {
            return Err(HistoryError::StaleObservation {
                at_ms,
                current_from_ms: last.valid_from_ms,
            });
        }
        Some(_) => {}
    }
    out.push(new_period(at_ms, None, position, stamp));
    Ok(Some(out))
}

/// The receiver moved to `position` at `at_ms`, which may be in the past.
///
/// - Inside a period: that period ends at `at_ms` and a new one runs from
///   `at_ms` to where the split period used to end. Later periods are kept.
///   Moving to the position it already has is a no-op.
/// - Before the first period, or in a gap: a new period fills the time up to
///   the next period's start (open if there is none).
/// - Exactly at a period's start: refused, that is a [`correct`].
pub fn move_at(
    periods: &[LocationPeriod],
    position: ReceiverPosition,
    at_ms: i64,
    stamp: &ChangeStamp,
) -> Result<Option<Vec<LocationPeriod>>, HistoryError> {
    position.validate()?;
    if periods.iter().any(|p| p.valid_from_ms == at_ms) {
        return Err(HistoryError::PeriodStartsAt(at_ms));
    }
    let mut out = periods.to_vec();
    if let Some(i) = out.iter().position(|p| p.contains(at_ms)) {
        if out[i].position.same_as(&position) {
            return Ok(None);
        }
        let end = out[i].valid_to_ms;
        out[i].valid_to_ms = Some(at_ms);
        out.insert(i + 1, new_period(at_ms, end, position, stamp));
    } else {
        // Before the first period, in a gap, or after a closed history.
        let next = out.iter().position(|p| p.valid_from_ms > at_ms);
        let end = next.map(|i| out[i].valid_from_ms);
        let at = next.unwrap_or(out.len());
        out.insert(at, new_period(at_ms, end, position, stamp));
    }
    validate(&out)?;
    Ok(Some(out))
}

/// The period starting at `valid_from_ms` was at `position` all along.
/// Its interval is unchanged; its position and provenance are replaced.
pub fn correct(
    periods: &[LocationPeriod],
    valid_from_ms: i64,
    position: ReceiverPosition,
    stamp: &ChangeStamp,
) -> Result<Option<Vec<LocationPeriod>>, HistoryError> {
    position.validate()?;
    let mut out = periods.to_vec();
    let period = out
        .iter_mut()
        .find(|p| p.valid_from_ms == valid_from_ms)
        .ok_or(HistoryError::NoSuchPeriod(valid_from_ms))?;
    if period.position.same_as(&position) {
        return Ok(None);
    }
    restamp(period, position, stamp);
    Ok(Some(out))
}

/// The period starting at `valid_from_ms` is deleted.
///
/// A previous period that ended exactly where it started absorbs its span
/// (the move it recorded never happened). Otherwise its span becomes a gap:
/// the location there is unknown.
pub fn remove(
    periods: &[LocationPeriod],
    valid_from_ms: i64,
) -> Result<Option<Vec<LocationPeriod>>, HistoryError> {
    let mut out = periods.to_vec();
    let i = out
        .iter()
        .position(|p| p.valid_from_ms == valid_from_ms)
        .ok_or(HistoryError::NoSuchPeriod(valid_from_ms))?;
    let removed = out.remove(i);
    if i > 0 && out[i - 1].valid_to_ms == Some(removed.valid_from_ms) {
        out[i - 1].valid_to_ms = removed.valid_to_ms;
    }
    Ok(Some(out))
}

fn new_period(
    valid_from_ms: i64,
    valid_to_ms: Option<i64>,
    position: ReceiverPosition,
    stamp: &ChangeStamp,
) -> LocationPeriod {
    LocationPeriod {
        valid_from_ms,
        valid_to_ms,
        position,
        origin: stamp.origin,
        recorded_at_ms: stamp.recorded_at_ms,
        note: stamp.note.clone(),
    }
}

/// Replaces a period's position and provenance, keeping its interval.
fn restamp(period: &mut LocationPeriod, position: ReceiverPosition, stamp: &ChangeStamp) {
    period.position = position;
    period.origin = stamp.origin;
    period.recorded_at_ms = stamp.recorded_at_ms;
    period.note = stamp.note.clone();
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: ReceiverPosition = ReceiverPosition {
        latitude: 46.7,
        longitude: -2.3,
        altitude_ft: Some(20.0),
    };
    const AWAY: ReceiverPosition = ReceiverPosition {
        latitude: 47.2,
        longitude: -1.5,
        altitude_ft: Some(100.0),
    };
    const THIRD: ReceiverPosition = ReceiverPosition {
        latitude: 48.0,
        longitude: -1.0,
        altitude_ft: None,
    };

    fn stamp(origin: LocationOrigin) -> ChangeStamp {
        ChangeStamp {
            origin,
            recorded_at_ms: 999,
            note: None,
        }
    }

    fn period(from: i64, to: Option<i64>, position: ReceiverPosition) -> LocationPeriod {
        LocationPeriod {
            valid_from_ms: from,
            valid_to_ms: to,
            position,
            origin: LocationOrigin::Config,
            recorded_at_ms: 0,
            note: None,
        }
    }

    /// `(from, to, latitude)` triples, enough to read a history at a glance.
    fn shape(periods: &[LocationPeriod]) -> Vec<(i64, Option<i64>, f64)> {
        periods
            .iter()
            .map(|p| (p.valid_from_ms, p.valid_to_ms, p.position.latitude))
            .collect()
    }

    // ---- positions --------------------------------------------------------

    #[test]
    fn a_position_off_the_globe_is_invalid() {
        assert!(ReceiverPosition::new(91.0, 0.0, None).validate().is_err());
        assert!(ReceiverPosition::new(0.0, 181.0, None).validate().is_err());
        assert!(
            ReceiverPosition::new(f64::NAN, 0.0, None)
                .validate()
                .is_err()
        );
        assert!(
            ReceiverPosition::new(0.0, 0.0, Some(f64::INFINITY))
                .validate()
                .is_err()
        );
        assert!(HOME.validate().is_ok());
    }

    #[test]
    fn positions_within_a_metre_are_the_same() {
        let nudged = ReceiverPosition::new(HOME.latitude + 0.000_001, HOME.longitude, Some(20.4));
        assert!(HOME.same_as(&nudged));
        let ten_metres = ReceiverPosition::new(HOME.latitude + 0.0001, HOME.longitude, Some(20.0));
        assert!(!HOME.same_as(&ten_metres));
    }

    #[test]
    fn learning_the_altitude_is_a_change() {
        let no_alt = ReceiverPosition::new(HOME.latitude, HOME.longitude, None);
        assert!(!HOME.same_as(&no_alt));
    }

    #[test]
    fn origin_round_trips_and_unknown_text_reads_as_cli() {
        for o in [
            LocationOrigin::Config,
            LocationOrigin::Mqtt,
            LocationOrigin::Cli,
            LocationOrigin::Desktop,
            LocationOrigin::Backfill,
        ] {
            assert_eq!(LocationOrigin::parse(o.as_str()), o);
        }
        assert_eq!(LocationOrigin::parse("future"), LocationOrigin::Cli);
    }

    #[test]
    fn a_period_is_half_open() {
        let p = period(100, Some(200), HOME);
        assert!(!p.contains(99));
        assert!(p.contains(100));
        assert!(p.contains(199));
        assert!(!p.contains(200));
        assert!(period(100, None, HOME).contains(i64::MAX));
    }

    // ---- validate ---------------------------------------------------------

    #[test]
    fn validate_accepts_gaps_and_one_trailing_open_period() {
        let h = [
            period(0, Some(10), HOME),
            period(20, Some(30), AWAY),
            period(30, None, THIRD),
        ];
        assert_eq!(validate(&h), Ok(()));
        assert_eq!(validate(&[]), Ok(()));
    }

    #[test]
    fn validate_rejects_overlap_disorder_empty_and_inner_open_periods() {
        let overlap = [period(0, Some(20), HOME), period(10, None, AWAY)];
        assert_eq!(validate(&overlap), Err(HistoryError::Inconsistent(10)));
        let disorder = [period(10, Some(20), HOME), period(0, Some(5), AWAY)];
        assert_eq!(validate(&disorder), Err(HistoryError::Inconsistent(0)));
        let empty = [period(10, Some(10), HOME)];
        assert_eq!(validate(&empty), Err(HistoryError::Inconsistent(10)));
        let inner_open = [period(0, None, HOME), period(10, None, AWAY)];
        assert_eq!(validate(&inner_open), Err(HistoryError::Inconsistent(10)));
    }

    // ---- observe ----------------------------------------------------------

    #[test]
    fn the_first_observation_opens_the_history() {
        let out = observe(&[], HOME, 100, &stamp(LocationOrigin::Config))
            .unwrap()
            .unwrap();
        assert_eq!(shape(&out), vec![(100, None, HOME.latitude)]);
        assert_eq!(out[0].origin, LocationOrigin::Config);
        assert_eq!(out[0].recorded_at_ms, 999);
    }

    #[test]
    fn observing_the_same_position_again_is_a_no_op() {
        let h = [period(100, None, HOME)];
        assert_eq!(
            observe(&h, HOME, 500, &stamp(LocationOrigin::Mqtt)),
            Ok(None)
        );
    }

    #[test]
    fn observing_a_new_position_closes_the_current_period() {
        let h = [period(100, None, HOME)];
        let out = observe(&h, AWAY, 500, &stamp(LocationOrigin::Mqtt))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![(100, Some(500), HOME.latitude), (500, None, AWAY.latitude)]
        );
        // The closed period keeps its own provenance.
        assert_eq!(out[0].origin, LocationOrigin::Config);
        assert_eq!(out[1].origin, LocationOrigin::Mqtt);
    }

    #[test]
    fn replaying_an_observation_is_idempotent() {
        let h = [period(100, None, HOME)];
        let once = observe(&h, AWAY, 500, &stamp(LocationOrigin::Mqtt))
            .unwrap()
            .unwrap();
        assert_eq!(
            observe(&once, AWAY, 700, &stamp(LocationOrigin::Mqtt)),
            Ok(None)
        );
    }

    #[test]
    fn an_observation_older_than_the_current_period_is_stale() {
        let h = [period(100, None, HOME)];
        assert_eq!(
            observe(&h, AWAY, 50, &stamp(LocationOrigin::Mqtt)),
            Err(HistoryError::StaleObservation {
                at_ms: 50,
                current_from_ms: 100
            })
        );
    }

    #[test]
    fn an_observation_at_the_current_start_corrects_it() {
        let h = [period(0, Some(100), THIRD), period(100, None, HOME)];
        let out = observe(&h, AWAY, 100, &stamp(LocationOrigin::Config))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![(0, Some(100), THIRD.latitude), (100, None, AWAY.latitude)]
        );
    }

    #[test]
    fn an_observation_after_a_closed_history_reopens_it() {
        let h = [period(0, Some(100), HOME)];
        let out = observe(&h, HOME, 300, &stamp(LocationOrigin::Config))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![(0, Some(100), HOME.latitude), (300, None, HOME.latitude)]
        );
        assert_eq!(
            observe(&h, HOME, 50, &stamp(LocationOrigin::Config)),
            Err(HistoryError::StaleObservation {
                at_ms: 50,
                current_from_ms: 0
            })
        );
    }

    #[test]
    fn observe_rejects_an_invalid_position() {
        let bad = ReceiverPosition::new(200.0, 0.0, None);
        assert_eq!(
            observe(&[], bad, 0, &stamp(LocationOrigin::Config)),
            Err(HistoryError::InvalidPosition(bad))
        );
    }

    // ---- move_at ----------------------------------------------------------

    #[test]
    fn a_back_dated_move_splits_the_period_and_keeps_later_ones() {
        let h = [period(0, Some(100), HOME), period(100, None, AWAY)];
        let out = move_at(&h, THIRD, 40, &stamp(LocationOrigin::Cli))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![
                (0, Some(40), HOME.latitude),
                (40, Some(100), THIRD.latitude),
                (100, None, AWAY.latitude)
            ]
        );
        assert_eq!(out[1].origin, LocationOrigin::Cli);
    }

    #[test]
    fn a_move_inside_the_open_period_ends_it() {
        let h = [period(0, None, HOME)];
        let out = move_at(&h, AWAY, 40, &stamp(LocationOrigin::Cli))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![(0, Some(40), HOME.latitude), (40, None, AWAY.latitude)]
        );
    }

    #[test]
    fn a_move_before_the_first_period_fills_up_to_it() {
        let h = [period(100, None, HOME)];
        let out = move_at(&h, AWAY, 10, &stamp(LocationOrigin::Cli))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![(10, Some(100), AWAY.latitude), (100, None, HOME.latitude)]
        );
    }

    #[test]
    fn a_move_into_a_gap_fills_up_to_the_next_period() {
        let h = [period(0, Some(10), HOME), period(50, None, AWAY)];
        let out = move_at(&h, THIRD, 20, &stamp(LocationOrigin::Cli))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![
                (0, Some(10), HOME.latitude),
                (20, Some(50), THIRD.latitude),
                (50, None, AWAY.latitude)
            ]
        );
    }

    #[test]
    fn a_move_after_a_closed_history_is_open_ended() {
        let h = [period(0, Some(10), HOME)];
        let out = move_at(&h, AWAY, 20, &stamp(LocationOrigin::Cli))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![(0, Some(10), HOME.latitude), (20, None, AWAY.latitude)]
        );
    }

    #[test]
    fn a_move_into_an_empty_history_opens_it() {
        let out = move_at(&[], HOME, 20, &stamp(LocationOrigin::Cli))
            .unwrap()
            .unwrap();
        assert_eq!(shape(&out), vec![(20, None, HOME.latitude)]);
    }

    #[test]
    fn a_move_exactly_at_a_boundary_is_refused() {
        let h = [period(0, Some(100), HOME), period(100, None, AWAY)];
        assert_eq!(
            move_at(&h, THIRD, 100, &stamp(LocationOrigin::Cli)),
            Err(HistoryError::PeriodStartsAt(100))
        );
    }

    #[test]
    fn moving_to_the_position_already_held_is_a_no_op() {
        let h = [period(0, None, HOME)];
        assert_eq!(move_at(&h, HOME, 40, &stamp(LocationOrigin::Cli)), Ok(None));
    }

    // ---- correct ----------------------------------------------------------

    #[test]
    fn correct_rewrites_one_period_in_place() {
        let h = [period(0, Some(100), HOME), period(100, None, AWAY)];
        let out = correct(&h, 0, THIRD, &stamp(LocationOrigin::Desktop))
            .unwrap()
            .unwrap();
        assert_eq!(
            shape(&out),
            vec![(0, Some(100), THIRD.latitude), (100, None, AWAY.latitude)]
        );
        assert_eq!(out[0].origin, LocationOrigin::Desktop);
        assert_eq!(out[0].recorded_at_ms, 999);
    }

    #[test]
    fn correct_needs_an_exact_start() {
        let h = [period(0, None, HOME)];
        assert_eq!(
            correct(&h, 5, AWAY, &stamp(LocationOrigin::Cli)),
            Err(HistoryError::NoSuchPeriod(5))
        );
    }

    #[test]
    fn correcting_to_the_same_position_is_a_no_op() {
        let h = [period(0, None, HOME)];
        assert_eq!(correct(&h, 0, HOME, &stamp(LocationOrigin::Cli)), Ok(None));
    }

    // ---- remove -----------------------------------------------------------

    #[test]
    fn removing_a_middle_period_lets_the_previous_absorb_it() {
        let h = [
            period(0, Some(10), HOME),
            period(10, Some(20), AWAY),
            period(20, None, THIRD),
        ];
        let out = remove(&h, 10).unwrap().unwrap();
        assert_eq!(
            shape(&out),
            vec![(0, Some(20), HOME.latitude), (20, None, THIRD.latitude)]
        );
    }

    #[test]
    fn removing_the_last_period_reopens_the_previous() {
        let h = [period(0, Some(10), HOME), period(10, None, AWAY)];
        let out = remove(&h, 10).unwrap().unwrap();
        assert_eq!(shape(&out), vec![(0, None, HOME.latitude)]);
    }

    #[test]
    fn removing_the_first_period_leaves_its_span_unknown() {
        let h = [period(0, Some(10), HOME), period(10, None, AWAY)];
        let out = remove(&h, 0).unwrap().unwrap();
        assert_eq!(shape(&out), vec![(10, None, AWAY.latitude)]);
    }

    #[test]
    fn removing_after_a_gap_does_not_bridge_it() {
        let h = [period(0, Some(10), HOME), period(20, Some(30), AWAY)];
        let out = remove(&h, 20).unwrap().unwrap();
        assert_eq!(shape(&out), vec![(0, Some(10), HOME.latitude)]);
    }

    #[test]
    fn removing_an_unknown_period_is_an_error() {
        assert_eq!(remove(&[], 0), Err(HistoryError::NoSuchPeriod(0)));
    }

    // ---- apply ------------------------------------------------------------

    #[test]
    fn apply_dispatches_and_its_results_always_validate() {
        let h = vec![period(0, None, HOME)];
        let s = stamp(LocationOrigin::Cli);
        let changes = [
            LocationChange::Observe {
                position: AWAY,
                at_ms: 100,
            },
            LocationChange::Move {
                position: THIRD,
                at_ms: 50,
            },
            LocationChange::Correct {
                valid_from_ms: 0,
                position: AWAY,
            },
            LocationChange::Remove { valid_from_ms: 0 },
        ];
        for change in &changes {
            let out = apply(&h, change, &s).unwrap().unwrap();
            assert_eq!(validate(&out), Ok(()), "{change:?}");
        }
    }

    #[test]
    fn a_change_round_trips_through_json() {
        let change = LocationChange::Move {
            position: HOME,
            at_ms: 42,
        };
        let json = serde_json::to_string(&change).unwrap();
        assert!(json.contains("\"kind\":\"move\""), "{json}");
        let back: LocationChange = serde_json::from_str(&json).unwrap();
        assert_eq!(back, change);
    }
}
