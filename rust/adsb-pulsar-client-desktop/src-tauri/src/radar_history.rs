//! The last hour of rain radar, for the animation.
//!
//! Météo-France only serves the current 5-minute mosaic (the "paquet" product
//! covers 15 minutes and needs another subscription), so the hour is built up
//! here: every mosaic the radar layer downloads is also written to disk
//! (~2.6 MB each, ~31 MB for an hour). Frames therefore exist only for the
//! times the layer was on, and survive a restart.
//!
//! Rendered PNGs (~400 KB) are kept in memory per box, at most an hour of them
//! (`RenderCache::insert` enforces it); the decoded fields (24 MB each) are
//! not kept, so a frame is decoded once, when first rendered.
//!
//! Disk retention: `save` deletes frames over an hour older than the newest
//! (never the one it wrote); `prune`, run on every radar request, also deletes
//! a session whose newest frame is over an hour old.

use crate::metar::Bbox;
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// How far back the animation goes from its newest frame.
pub const HISTORY_MINUTES: i64 = 60;

const PREFIX: &str = "lame_d_eau-";
const SUFFIX: &str = ".h5";
const STAMP: &str = "%Y%m%dT%H%MZ";

pub fn file_name(validity: DateTime<Utc>) -> String {
    format!("{PREFIX}{}{SUFFIX}", validity.format(STAMP))
}

pub fn parse_file_name(name: &str) -> Option<DateTime<Utc>> {
    let stamp = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    NaiveDateTime::parse_from_str(stamp, STAMP)
        .ok()
        .map(|n| n.and_utc())
}

/// The frames to animate: within `HISTORY_MINUTES` of the newest one, oldest
/// first. Nothing when even the newest is over an hour old: yesterday's rain
/// must not play as "the last hour".
pub fn select(mut validities: Vec<DateTime<Utc>>, now: DateTime<Utc>) -> Vec<DateTime<Utc>> {
    validities.sort();
    validities.dedup();
    let Some(&newest) = validities.last() else {
        return vec![];
    };
    if now - newest > Duration::minutes(HISTORY_MINUTES) {
        return vec![];
    }
    let from = newest - Duration::minutes(HISTORY_MINUTES);
    validities.retain(|v| *v > from);
    validities
}

/// The frames on disk, by time, ignoring anything that is not one.
pub fn on_disk(dir: &Path) -> Vec<(DateTime<Utc>, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut frames: Vec<_> = entries
        .flatten()
        .filter_map(|e| {
            let v = parse_file_name(e.file_name().to_str()?)?;
            Some((v, e.path()))
        })
        .collect();
    frames.sort_by_key(|(v, _)| *v);
    frames
}

/// Is `v` within the hour that ends at `newest`?
fn in_hour_of(newest: DateTime<Utc>, v: DateTime<Utc>) -> bool {
    v > newest - Duration::minutes(HISTORY_MINUTES)
}

/// The frames to animate, with their files. Deletes an old session first.
pub fn frames(dir: &Path, now: DateTime<Utc>) -> Vec<(DateTime<Utc>, PathBuf)> {
    prune(dir, now);
    on_disk(dir)
}

/// Deletes every frame `select` would not animate at `now`: frames that left
/// the hour, and a whole session once its newest frame is over an hour old.
/// Called on every radar request, so turning the radar on cleans up.
pub fn prune(dir: &Path, now: DateTime<Utc>) {
    let all = on_disk(dir);
    let keep = select(all.iter().map(|(v, _)| *v).collect(), now);
    for (v, p) in all {
        if !keep.contains(&v) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Keeps a downloaded mosaic, then deletes the frames more than an hour older
/// than the newest one; never the file just written. Written to a temporary
/// name and renamed, so a reader never sees half a file.
pub fn save(dir: &Path, validity: DateTime<Utc>, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("radar history {}: {e}", dir.display()))?;
    let path = dir.join(file_name(validity));
    let tmp = path.with_extension("h5.tmp");
    std::fs::write(&tmp, bytes)
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("radar history {}: {e}", path.display()))?;
    let all = on_disk(dir);
    let newest = all.last().map_or(validity, |(v, _)| *v);
    for (v, p) in all {
        if v != validity && !in_hour_of(newest, v) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/// Rendered frames for one box. A new box (the receiver moved) starts over.
pub struct RenderCache<T> {
    bbox: Option<Bbox>,
    images: BTreeMap<DateTime<Utc>, T>,
}

impl<T: Clone> Default for RenderCache<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone> RenderCache<T> {
    pub const fn new() -> Self {
        Self {
            bbox: None,
            images: BTreeMap::new(),
        }
    }

    fn for_box(&mut self, bbox: Bbox) {
        if self.bbox != Some(bbox) {
            self.bbox = Some(bbox);
            self.images.clear();
        }
    }

    pub fn get(&mut self, bbox: Bbox, validity: DateTime<Utc>) -> Option<T> {
        self.for_box(bbox);
        self.images.get(&validity).cloned()
    }

    /// Adds a frame, then drops those more than an hour older than the
    /// newest: the cache bounds itself, whichever command fills it.
    pub fn insert(&mut self, bbox: Bbox, validity: DateTime<Utc>, image: T) {
        self.for_box(bbox);
        self.images.insert(validity, image);
        if let Some(&newest) = self.images.keys().next_back() {
            self.images.retain(|v, _| in_hour_of(newest, *v));
        }
    }

    /// Of `wanted`, the frames not rendered yet for this box.
    pub fn missing(&mut self, bbox: Bbox, wanted: &[DateTime<Utc>]) -> Vec<DateTime<Utc>> {
        self.for_box(bbox);
        wanted
            .iter()
            .filter(|v| !self.images.contains_key(v))
            .copied()
            .collect()
    }

    /// Drops the frames older than `oldest`: memory stays at about an hour.
    pub fn forget_before(&mut self, oldest: DateTime<Utc>) {
        self.images.retain(|v, _| *v >= oldest);
    }
}

/// One animation frame; the image is left out when the webview said it has it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarFrame {
    pub valid_time_ms: i64,
    pub png_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarFrames {
    /// [south, west, north, east], the same for every frame.
    pub bounds: [f64; 4],
    /// Oldest first.
    pub frames: Vec<RadarFrame>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 2026-11-19 03:00 UTC plus `m` minutes.
    fn t(m: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 19, 3, 0, 0).unwrap() + Duration::minutes(m)
    }

    const B1: Bbox = Bbox {
        min_lat: 42.0,
        min_lon: -6.0,
        max_lat: 52.0,
        max_lon: 3.0,
    };
    const B2: Bbox = Bbox {
        min_lat: 43.0,
        ..B1
    };

    #[test]
    fn file_names_round_trip_and_sort_by_time() {
        assert_eq!(file_name(t(10)), "lame_d_eau-20261119T0310Z.h5");
        assert_eq!(parse_file_name(&file_name(t(10))), Some(t(10)));
        assert!(file_name(t(-5)) < file_name(t(0)), "names sort like times");
        for other in [
            "lame_d_eau-x.h5",
            "airspace.json",
            "lame_d_eau-20261119T0310Z.h5.tmp",
        ] {
            assert_eq!(parse_file_name(other), None, "{other}");
        }
    }

    #[test]
    fn select_keeps_the_hour_before_the_newest_frame() {
        let all: Vec<_> = (0..=14).map(|i| t(i * 5)).rev().collect();
        let kept = select(all, t(72));
        assert_eq!(kept.len(), 12, "12 five-minute frames make the hour");
        assert_eq!(kept.first(), Some(&t(15)));
        assert_eq!(kept.last(), Some(&t(70)));
    }

    #[test]
    fn select_shows_gaps_as_they_are() {
        assert_eq!(
            select(vec![t(0), t(40), t(45)], t(50)),
            vec![t(0), t(40), t(45)]
        );
    }

    #[test]
    fn select_drops_an_old_session() {
        assert_eq!(
            select(vec![t(0), t(5)], t(5 + 61)),
            Vec::<DateTime<Utc>>::new()
        );
        assert_eq!(select(vec![], t(0)), Vec::<DateTime<Utc>>::new());
    }

    #[test]
    fn save_keeps_the_hour_and_deletes_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("radar");
        for i in 0..14 {
            save(&d, t(i * 5), b"mosaic").unwrap();
        }
        std::fs::write(d.join("notes.txt"), "kept").unwrap();
        let on = on_disk(&d);
        assert_eq!(on.len(), 12);
        assert_eq!(on[0].0, t(10));
        assert_eq!(std::fs::read(&on[0].1).unwrap(), b"mosaic");
        assert!(d.join("notes.txt").exists(), "only frames are deleted");
        assert!(
            std::fs::read_dir(&d)
                .unwrap()
                .flatten()
                .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")),
            "no temporary file left"
        );
    }

    #[test]
    fn frames_lists_the_selected_files() {
        let dir = tempfile::tempdir().unwrap();
        for i in [0, 5, 10] {
            save(dir.path(), t(i), b"x").unwrap();
        }
        let f = frames(dir.path(), t(12));
        assert_eq!(
            f.iter().map(|(v, _)| *v).collect::<Vec<_>>(),
            vec![t(0), t(5), t(10)]
        );
        assert!(frames(dir.path(), t(200)).is_empty());
        assert!(frames(&dir.path().join("missing"), t(0)).is_empty());
    }

    #[test]
    fn render_cache_reuses_frames_for_the_same_box() {
        let mut c = RenderCache::new();
        c.insert(B1, t(0), "a");
        assert_eq!(c.get(B1, t(0)), Some("a"));
        assert_eq!(c.missing(B1, &[t(0), t(5)]), vec![t(5)]);
    }

    #[test]
    fn render_cache_starts_over_for_a_new_box() {
        let mut c = RenderCache::new();
        c.insert(B1, t(0), "a");
        assert_eq!(c.missing(B2, &[t(0)]), vec![t(0)]);
        assert_eq!(c.get(B1, t(0)), None, "the old box's frames are gone");
    }

    #[test]
    fn render_cache_forgets_old_frames() {
        let mut c = RenderCache::new();
        for i in 0..3 {
            c.insert(B1, t(i * 5), i);
        }
        c.forget_before(t(5));
        assert_eq!(c.missing(B1, &[t(0), t(5), t(10)]), vec![t(0)]);
    }

    #[test]
    fn render_cache_holds_at_most_an_hour_whoever_inserts() {
        // get_radar inserts every new image and never asks for frames:
        // the cache must bound itself.
        let mut c = RenderCache::new();
        let all: Vec<_> = (0..20).map(|i| t(i * 5)).collect();
        for v in &all {
            c.insert(B1, *v, ());
        }
        assert_eq!(c.missing(B1, &all), all[..8].to_vec(), "12 frames kept");
        c.insert(B1, t(-60), ());
        assert_eq!(
            c.get(B1, t(-60)),
            None,
            "a frame inserted late but outside the hour is dropped"
        );
    }

    #[test]
    fn save_never_deletes_the_file_it_wrote() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), t(0), b"x").unwrap();
        save(dir.path(), t(-120), b"late").unwrap();
        let on: Vec<_> = on_disk(dir.path()).into_iter().map(|(v, _)| v).collect();
        assert_eq!(
            on,
            vec![t(-120), t(0)],
            "even an image older than the hour stays until the next save"
        );
    }

    #[test]
    fn prune_deletes_an_old_session_and_keeps_a_current_one() {
        let dir = tempfile::tempdir().unwrap();
        for i in [0, 5, 10] {
            save(dir.path(), t(i), b"x").unwrap();
        }
        prune(dir.path(), t(30));
        assert_eq!(on_disk(dir.path()).len(), 3);
        prune(dir.path(), t(10 + 61));
        assert!(on_disk(dir.path()).is_empty());
        prune(&dir.path().join("missing"), t(0));
    }

    #[test]
    fn frames_serialize_for_the_webview() {
        let f = RadarFrames {
            bounds: [1.0, 2.0, 3.0, 4.0],
            frames: vec![RadarFrame {
                valid_time_ms: 5,
                png_base64: None,
            }],
        };
        assert_eq!(
            serde_json::to_value(f).unwrap(),
            serde_json::json!({"bounds": [1.0, 2.0, 3.0, 4.0], "frames": [{"validTimeMs": 5, "pngBase64": null}]})
        );
    }
}
