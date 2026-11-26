//! The credit ledger: what this service has spent at OpenSky in the last 24 h.
//!
//! Every successful call is recorded in a 5-minute slot, per bucket (`/states`
//! and `/tracks` are separate allowances at OpenSky). Slots older than 24 h
//! are dropped, so the ledger is a rolling window of at most 288 slots.
//!
//! It is kept on disk ([`save`] / [`load`]): a restart must not reset the
//! count to zero and let the service spend a second day's allowance. The
//! watch list is deliberately *not* kept -- that is the client's -- but what
//! has been spent is a fact about the account.
//!
//! Beside our own count it keeps OpenSky's `X-Rate-Limit-Remaining` from the
//! last reply. The two can differ: another app on the same login spends the
//! same allowance, and OpenSky does not document when its window resets.

use crate::api::{CreditsReport, HourCredits};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Slot width.
pub const SLOT_MS: i64 = 5 * 60_000;
/// The window.
pub const WINDOW_MS: i64 = 24 * 3_600_000;
const HOUR_MS: i64 = 3_600_000;

/// OpenSky's credit buckets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Bucket {
    States,
    Tracks,
}

/// Credits spent in one slot.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotCredits {
    #[serde(default)]
    pub states: u32,
    #[serde(default)]
    pub tracks: u32,
}

impl SlotCredits {
    fn get(&self, bucket: Bucket) -> u32 {
        match bucket {
            Bucket::States => self.states,
            Bucket::Tracks => self.tracks,
        }
    }

    fn get_mut(&mut self, bucket: Bucket) -> &mut u32 {
        match bucket {
            Bucket::States => &mut self.states,
            Bucket::Tracks => &mut self.tracks,
        }
    }
}

/// OpenSky's own count, as last reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remaining {
    pub credits: i64,
    /// When OpenSky said so, epoch ms.
    pub at_ms: i64,
}

/// The ledger.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Ledger {
    /// Slot start, epoch ms → credits spent in it.
    #[serde(default)]
    slots: BTreeMap<i64, SlotCredits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    states_remaining: Option<Remaining>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tracks_remaining: Option<Remaining>,
}

fn slot_of(ms: i64) -> i64 {
    ms.div_euclid(SLOT_MS) * SLOT_MS
}

impl Ledger {
    /// Records `cost` credits spent on `bucket` at `now_ms`.
    pub fn record(&mut self, bucket: Bucket, cost: u32, now_ms: i64) {
        self.prune(now_ms);
        let slot = self.slots.entry(slot_of(now_ms)).or_default();
        let value = slot.get_mut(bucket);
        *value = value.saturating_add(cost);
    }

    /// Notes OpenSky's remaining count for `bucket`.
    pub fn set_remaining(&mut self, bucket: Bucket, credits: Option<i64>, now_ms: i64) {
        let Some(credits) = credits else { return };
        let value = Some(Remaining {
            credits,
            at_ms: now_ms,
        });
        match bucket {
            Bucket::States => self.states_remaining = value,
            Bucket::Tracks => self.tracks_remaining = value,
        }
    }

    /// OpenSky's last count for `bucket`, if it is from the last 24 h.
    pub fn remaining(&self, bucket: Bucket, now_ms: i64) -> Option<i64> {
        let r = match bucket {
            Bucket::States => self.states_remaining,
            Bucket::Tracks => self.tracks_remaining,
        }?;
        (now_ms - r.at_ms < WINDOW_MS).then_some(r.credits)
    }

    /// Drops slots that have left the window.
    pub fn prune(&mut self, now_ms: i64) {
        let oldest = now_ms - WINDOW_MS;
        // A slot is in the window while any of it is: its end is past `oldest`.
        self.slots.retain(|start, _| start + SLOT_MS > oldest);
    }

    fn in_window(&self, now_ms: i64) -> impl Iterator<Item = (&i64, &SlotCredits)> {
        let oldest = now_ms - WINDOW_MS;
        self.slots
            .iter()
            .filter(move |(start, _)| **start + SLOT_MS > oldest && **start <= now_ms)
    }

    /// Credits spent on `bucket` in the last 24 h.
    pub fn used_last_24h(&self, bucket: Bucket, now_ms: i64) -> u32 {
        self.in_window(now_ms).map(|(_, c)| c.get(bucket)).sum()
    }

    /// How long until spending `cost` more on `bucket` keeps the window
    /// within `allowance`: zero if it already does, else when enough of the
    /// oldest spending ages out.
    pub fn wait_until_available(
        &self,
        bucket: Bucket,
        cost: u32,
        allowance: f64,
        now_ms: i64,
    ) -> Duration {
        let mut used = f64::from(self.used_last_24h(bucket, now_ms));
        let cost = f64::from(cost);
        if used + cost <= allowance {
            return Duration::ZERO;
        }
        for (start, credits) in self.in_window(now_ms) {
            used -= f64::from(credits.get(bucket));
            if used + cost <= allowance {
                let free_at = start + SLOT_MS + WINDOW_MS;
                return Duration::from_millis((free_at - now_ms).max(0) as u64);
            }
        }
        // Cost alone exceeds the allowance: the whole window must age out.
        Duration::from_millis(WINDOW_MS as u64)
    }

    /// The last 24 clock hours, oldest first; the current hour is last.
    pub fn hourly(&self, now_ms: i64) -> Vec<HourCredits> {
        let current = now_ms.div_euclid(HOUR_MS) * HOUR_MS;
        let mut hours: Vec<HourCredits> = (0..24)
            .rev()
            .map(|i| HourCredits {
                hour_start_ms: current - i * HOUR_MS,
                states: 0,
                tracks: 0,
            })
            .collect();
        let first = hours[0].hour_start_ms;
        for (start, credits) in &self.slots {
            if *start < first || *start > now_ms {
                continue;
            }
            let i = ((start - first) / HOUR_MS) as usize;
            if let Some(h) = hours.get_mut(i) {
                h.states += credits.states;
                h.tracks += credits.tracks;
            }
        }
        hours
    }

    /// The report `GET /v1/credits` serves.
    pub fn report(&self, daily_limit: u32, now_ms: i64) -> CreditsReport {
        CreditsReport {
            daily_limit,
            hours: self.hourly(now_ms),
            generated_ms: now_ms,
            states_remaining: self.remaining(Bucket::States, now_ms),
            tracks_remaining: self.remaining(Bucket::Tracks, now_ms),
        }
    }
}

/// Why the ledger file could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum LedgerFileError {
    #[error("OpenSky credit ledger {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("OpenSky credit ledger {} is unreadable: {source}", path.display())]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// Loads the ledger. A missing file is an empty ledger: a first run has none.
pub fn load(path: &Path) -> Result<Ledger, LedgerFileError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Ledger::default()),
        Err(source) => {
            return Err(LedgerFileError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    serde_json::from_slice(&bytes).map_err(|source| LedgerFileError::Json {
        path: path.to_path_buf(),
        source,
    })
}

/// Writes the ledger atomically: a temporary file, then a rename, so a crash
/// mid-write leaves the previous file rather than a truncated one.
pub fn save(path: &Path, ledger: &Ledger) -> Result<(), LedgerFileError> {
    let io = |source| LedgerFileError::Io {
        path: path.to_path_buf(),
        source,
    };
    let bytes = serde_json::to_vec(ledger).map_err(|source| LedgerFileError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_764_000_000_000; // a whole hour, UTC
    const MIN: i64 = 60_000;

    #[test]
    fn spending_is_counted_per_bucket() {
        let mut l = Ledger::default();
        l.record(Bucket::States, 1, T0);
        l.record(Bucket::States, 2, T0 + MIN);
        l.record(Bucket::Tracks, 4, T0 + 2 * MIN);
        assert_eq!(l.used_last_24h(Bucket::States, T0 + 3 * MIN), 3);
        assert_eq!(l.used_last_24h(Bucket::Tracks, T0 + 3 * MIN), 4);
    }

    #[test]
    fn spending_ages_out_after_24_hours() {
        let mut l = Ledger::default();
        l.record(Bucket::States, 5, T0);
        assert_eq!(l.used_last_24h(Bucket::States, T0 + WINDOW_MS - MIN), 5);
        assert_eq!(l.used_last_24h(Bucket::States, T0 + WINDOW_MS + SLOT_MS), 0);
    }

    #[test]
    fn the_ledger_stays_bounded() {
        let mut l = Ledger::default();
        for i in 0..(3 * 288) {
            l.record(Bucket::States, 1, T0 + i * SLOT_MS);
        }
        assert!(l.slots.len() <= 289, "{} slots", l.slots.len());
    }

    #[test]
    fn hourly_has_24_hours_ending_with_the_current_one() {
        let mut l = Ledger::default();
        let now = T0 + 23 * 3_600_000 + 30 * MIN;
        l.record(Bucket::States, 2, T0 + 10 * MIN); // first hour of the window
        l.record(Bucket::States, 1, now - MIN); // current hour
        l.record(Bucket::Tracks, 4, now - MIN);
        let h = l.hourly(now);
        assert_eq!(h.len(), 24);
        assert_eq!(h[0].hour_start_ms, T0);
        assert_eq!(h[0].states, 2);
        assert_eq!(h[23].hour_start_ms, T0 + 23 * 3_600_000);
        assert_eq!((h[23].states, h[23].tracks), (1, 4));
        assert_eq!(h.iter().map(|x| x.states).sum::<u32>(), 3);
    }

    #[test]
    fn no_wait_while_within_the_allowance() {
        let mut l = Ledger::default();
        l.record(Bucket::States, 10, T0);
        assert_eq!(
            l.wait_until_available(Bucket::States, 1, 100.0, T0),
            Duration::ZERO
        );
    }

    #[test]
    fn over_the_allowance_wait_for_the_oldest_slot_to_age_out() {
        let mut l = Ledger::default();
        l.record(Bucket::States, 60, T0);
        l.record(Bucket::States, 40, T0 + 60 * MIN);
        let now = T0 + 2 * 3_600_000;
        // 100 used, allowance 100: the first slot (60) must go, which happens
        // when its end leaves the window.
        let wait = l.wait_until_available(Bucket::States, 1, 100.0, now);
        let expected = T0 + SLOT_MS + WINDOW_MS - now;
        assert_eq!(wait, Duration::from_millis(expected as u64));
    }

    #[test]
    fn opensky_s_count_is_kept_for_a_day() {
        let mut l = Ledger::default();
        l.set_remaining(Bucket::States, Some(3_500), T0);
        l.set_remaining(Bucket::States, None, T0 + MIN); // no header: keep the last
        assert_eq!(l.remaining(Bucket::States, T0 + MIN), Some(3_500));
        assert_eq!(l.remaining(Bucket::Tracks, T0), None);
        assert_eq!(l.remaining(Bucket::States, T0 + WINDOW_MS), None);
    }

    #[test]
    fn the_report_carries_opensky_s_remaining_count() {
        let mut l = Ledger::default();
        let r = l.report(8_000, T0);
        assert_eq!((r.states_remaining, r.tracks_remaining), (None, None));
        l.set_remaining(Bucket::States, Some(7_412), T0);
        l.set_remaining(Bucket::Tracks, Some(396), T0);
        let r = l.report(8_000, T0 + MIN);
        assert_eq!(r.daily_limit, 8_000);
        assert_eq!(r.states_remaining, Some(7_412));
        assert_eq!(r.tracks_remaining, Some(396));
    }

    #[test]
    fn the_ledger_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/opensky-state.json");
        let mut l = Ledger::default();
        l.record(Bucket::States, 7, T0);
        l.set_remaining(Bucket::States, Some(3_993), T0);
        save(&path, &l).unwrap();
        let back = load(&path).unwrap();
        assert_eq!(back, l);
        assert_eq!(back.used_last_24h(Bucket::States, T0 + MIN), 7);
    }

    #[test]
    fn a_missing_file_is_an_empty_ledger_and_a_corrupt_one_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            load(&dir.path().join("none.json")).unwrap(),
            Ledger::default()
        );
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{ nope").unwrap();
        assert!(matches!(load(&bad), Err(LedgerFileError::Json { .. })));
    }
}
