//! The weather snapshot: the payload published on the weather topic.
//!
//! One snapshot describes one model hour over one [`GridSpec`]. Every field
//! array is flat and row-major (see [`crate::grid`]), with `None` where the
//! model had no value. Times are epoch milliseconds, the unit the desktop
//! frontend already uses for track timestamps.

use crate::grid::GridSpec;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Payload schema version. Bump on any incompatible change.
pub const SNAPSHOT_VERSION: u32 = 1;

/// Surface fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SurfaceFields {
    /// Mean-sea-level pressure, hPa.
    pub mslp_hpa: Vec<Option<f32>>,
    /// 10 m wind speed, knots.
    pub wind_speed_kt: Vec<Option<f32>>,
    /// 10 m wind direction the wind blows FROM, degrees true.
    pub wind_dir_deg: Vec<Option<f32>>,
}

/// Fields at one pressure level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LevelFields {
    /// Wind speed, knots.
    pub wind_speed_kt: Vec<Option<f32>>,
    /// Direction the wind blows FROM, degrees true.
    pub wind_dir_deg: Vec<Option<f32>>,
}

/// A gridded weather snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeatherSnapshot {
    pub version: u32,
    /// Provider identifier, e.g. `"open-meteo"`.
    pub source: String,
    /// Credit line the licence requires to be displayed.
    pub attribution: String,
    /// Weather model requested, e.g. `"best_match"`.
    pub model: String,
    /// When the service fetched this data, epoch ms.
    pub fetched_at_ms: i64,
    /// The model hour the data is valid for, epoch ms.
    pub valid_time_ms: i64,
    pub grid: GridSpec,
    pub surface: SurfaceFields,
    /// Keyed by pressure level in hPa. Serialised with string keys (`"250"`).
    pub levels: BTreeMap<u16, LevelFields>,
}

/// Why a payload was rejected.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("malformed weather snapshot JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported snapshot version {found} (expected {expected})")]
    Version { found: u32, expected: u32 },
    #[error("field '{field}' has {len} values, grid has {expected} points")]
    Length {
        field: String,
        len: usize,
        expected: usize,
    },
}

impl WeatherSnapshot {
    /// Checks the version and that every field array matches the grid size.
    ///
    /// A payload that parses but has a short array would otherwise index out
    /// of bounds in the consumer, far from where the damage was done.
    pub fn validate(&self) -> Result<(), SnapshotError> {
        if self.version != SNAPSHOT_VERSION {
            return Err(SnapshotError::Version {
                found: self.version,
                expected: SNAPSHOT_VERSION,
            });
        }

        let expected = self.grid.len();
        ensure_len("surface.mslp_hpa", &self.surface.mslp_hpa, expected)?;
        ensure_len(
            "surface.wind_speed_kt",
            &self.surface.wind_speed_kt,
            expected,
        )?;
        ensure_len("surface.wind_dir_deg", &self.surface.wind_dir_deg, expected)?;
        for (level, fields) in &self.levels {
            ensure_len(
                &format!("levels.{level}.wind_speed_kt"),
                &fields.wind_speed_kt,
                expected,
            )?;
            ensure_len(
                &format!("levels.{level}.wind_dir_deg"),
                &fields.wind_dir_deg,
                expected,
            )?;
        }
        Ok(())
    }

    /// Parses and validates a payload.
    pub fn from_json(bytes: &[u8]) -> Result<Self, SnapshotError> {
        let snapshot: Self = serde_json::from_slice(bytes)?;
        snapshot.validate()?;
        Ok(snapshot)
    }
}

fn ensure_len(field: &str, values: &[Option<f32>], expected: usize) -> Result<(), SnapshotError> {
    if values.len() == expected {
        Ok(())
    } else {
        Err(SnapshotError::Length {
            field: field.to_string(),
            len: values.len(),
            expected,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> GridSpec {
        GridSpec {
            lat0: 46.0,
            lon0: -3.0,
            dlat: 1.0,
            dlon: 1.0,
            nlat: 2,
            nlon: 3,
        }
    }

    fn filled(n: usize, v: f32) -> Vec<Option<f32>> {
        vec![Some(v); n]
    }

    fn sample() -> WeatherSnapshot {
        let n = 6;
        let mut levels = BTreeMap::new();
        levels.insert(
            250,
            LevelFields {
                wind_speed_kt: filled(n, 120.0),
                wind_dir_deg: filled(n, 270.0),
            },
        );
        WeatherSnapshot {
            version: SNAPSHOT_VERSION,
            source: "open-meteo".into(),
            attribution: "Weather data by Open-Meteo.com (CC BY 4.0)".into(),
            model: "best_match".into(),
            fetched_at_ms: 1_789_000_000_000,
            valid_time_ms: 1_788_998_400_000,
            grid: grid(),
            surface: SurfaceFields {
                mslp_hpa: filled(n, 1013.2),
                wind_speed_kt: filled(n, 8.0),
                wind_dir_deg: vec![None; n],
            },
            levels,
        }
    }

    #[test]
    fn round_trips_through_json() {
        let snap = sample();
        let json = serde_json::to_vec(&snap).unwrap();
        assert_eq!(WeatherSnapshot::from_json(&json).unwrap(), snap);
    }

    #[test]
    fn levels_serialise_with_string_keys_and_nulls_survive() {
        // The frontend reads levels["250"] and must see a gap as null, not 0.
        let v = serde_json::to_value(sample()).unwrap();
        assert!(v["levels"]["250"]["wind_speed_kt"].is_array());
        assert!(v["surface"]["wind_dir_deg"][0].is_null());
    }

    #[test]
    fn a_valid_snapshot_validates() {
        assert!(sample().validate().is_ok());
    }

    #[test]
    fn a_short_surface_array_is_rejected() {
        let mut snap = sample();
        snap.surface.mslp_hpa.pop();
        match snap.validate() {
            Err(SnapshotError::Length {
                field,
                len,
                expected,
            }) => {
                assert_eq!(field, "surface.mslp_hpa");
                assert_eq!((len, expected), (5, 6));
            }
            other => panic!("expected Length error, got {other:?}"),
        }
    }

    #[test]
    fn a_short_level_array_names_the_level() {
        let mut snap = sample();
        snap.levels.get_mut(&250).unwrap().wind_dir_deg.push(None);
        match snap.validate() {
            Err(SnapshotError::Length { field, .. }) => {
                assert_eq!(field, "levels.250.wind_dir_deg");
            }
            other => panic!("expected Length error, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_version_is_rejected() {
        let mut snap = sample();
        snap.version = SNAPSHOT_VERSION + 1;
        let json = serde_json::to_vec(&snap).unwrap();
        assert!(matches!(
            WeatherSnapshot::from_json(&json),
            Err(SnapshotError::Version { .. })
        ));
    }

    #[test]
    fn garbage_is_a_json_error_not_a_panic() {
        assert!(matches!(
            WeatherSnapshot::from_json(b"MSG,3,1,1,ABC123"),
            Err(SnapshotError::Json(_))
        ));
    }
}
