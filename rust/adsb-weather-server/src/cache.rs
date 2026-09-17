//! Last-good snapshot on disk.
//!
//! The broker runs without persistence and the retained message dies with it,
//! so after a restart of either process the only copy of the last good grid is
//! this file. Loading it lets the service republish immediately instead of
//! leaving the map empty until the next successful fetch, which may be an hour
//! away, or never if the uplink is down.

use crate::snapshot::{SnapshotError, WeatherSnapshot};
use std::path::{Path, PathBuf};

/// Why the cache could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("weather cache I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("weather cache is unreadable: {0}")]
    Snapshot(#[from] SnapshotError),
}

/// Loads the cached snapshot. A missing file is `Ok(None)`: the first run has
/// no cache and that is not an error.
pub fn load(path: &Path) -> Result<Option<WeatherSnapshot>, CacheError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(WeatherSnapshot::from_json(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Writes `snapshot` atomically; see [`write_atomic`].
pub fn save(path: &Path, snapshot: &WeatherSnapshot) -> Result<(), CacheError> {
    let bytes = serde_json::to_vec(snapshot).map_err(SnapshotError::from)?;
    write_atomic(path, &bytes)?;
    Ok(())
}

/// Writes `bytes` to `path` atomically: a temporary file next to the target,
/// then a rename. A crash mid-write leaves the previous file intact rather
/// than a truncated one that fails to parse on the next start.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = temp_path(path);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// The temporary file `save` writes before renaming.
fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::GridSpec;
    use crate::snapshot::{SNAPSHOT_VERSION, SurfaceFields};
    use std::collections::BTreeMap;

    fn snapshot(mslp: f32) -> WeatherSnapshot {
        WeatherSnapshot {
            version: SNAPSHOT_VERSION,
            source: "open-meteo".into(),
            attribution: "test".into(),
            model: "best_match".into(),
            fetched_at_ms: 1,
            valid_time_ms: 2,
            grid: GridSpec {
                lat0: 47.0,
                lon0: -2.0,
                dlat: 1.0,
                dlon: 1.0,
                nlat: 1,
                nlon: 1,
            },
            surface: SurfaceFields {
                mslp_hpa: vec![Some(mslp)],
                wind_speed_kt: vec![None],
                wind_dir_deg: vec![None],
            },
            levels: BTreeMap::new(),
        }
    }

    #[test]
    fn round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weather-cache.json");
        save(&path, &snapshot(1013.0)).unwrap();
        assert_eq!(load(&path).unwrap(), Some(snapshot(1013.0)));
    }

    #[test]
    fn a_missing_file_is_no_cache_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&dir.path().join("absent.json")).unwrap(), None);
    }

    #[test]
    fn a_corrupt_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weather-cache.json");
        std::fs::write(&path, b"{\"version\": 1, \"trunc").unwrap();
        assert!(matches!(load(&path), Err(CacheError::Snapshot(_))));
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        // `.run/` does not exist on a fresh checkout until something makes it.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/run/weather-cache.json");
        save(&path, &snapshot(1000.0)).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn save_overwrites_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weather-cache.json");
        save(&path, &snapshot(1000.0)).unwrap();
        save(&path, &snapshot(990.0)).unwrap();
        assert_eq!(load(&path).unwrap(), Some(snapshot(990.0)));
        assert!(!temp_path(&path).exists());
    }
}
