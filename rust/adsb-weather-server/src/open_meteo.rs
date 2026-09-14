//! Open-Meteo request building and response decoding.
//!
//! Everything here is pure: URLs in, bytes out, no I/O. The HTTP call lives
//! in the provider so these rules can be tested against a recorded response.
//!
//! Three facts about the API shape this module:
//! - Pressure-level variables exist only under `hourly=`, never `current=`, so
//!   a short hourly window is requested and the hour nearest "now" is picked.
//! - Several locations in one request come back as a JSON **array**, one
//!   object per location in request order; a single location is a bare object.
//! - A rejected request is `{"error": true, "reason": "..."}` with HTTP 400.

use crate::grid::GridSpec;
use crate::snapshot::{LevelFields, SNAPSHOT_VERSION, SurfaceFields, WeatherSnapshot};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};

/// Provider identifier stamped on every snapshot.
pub const SOURCE: &str = "open-meteo";

/// Credit line required by the data licence (CC BY 4.0).
pub const ATTRIBUTION: &str = "Weather data by Open-Meteo.com (CC BY 4.0)";

/// Public forecast endpoint.
pub const DEFAULT_BASE_URL: &str = "https://api.open-meteo.com/v1/forecast";

/// Locations per request. Keeps URLs well under common length limits; the
/// daily budget is the same however the grid is split.
pub const MAX_LOCATIONS_PER_REQUEST: usize = 50;

/// Why a response could not be turned into a snapshot.
#[derive(Debug, thiserror::Error)]
pub enum OpenMeteoError {
    #[error("Open-Meteo rejected the request: {0}")]
    Api(String),
    #[error("malformed Open-Meteo response: {0}")]
    Json(#[from] serde_json::Error),
    #[error("expected {expected} locations in the response, got {got}")]
    LocationCount { got: usize, expected: usize },
    #[error("Open-Meteo response carries no hourly timestamps")]
    NoTimes,
}

/// One location's decoded response.
#[derive(Debug, Clone, Deserialize)]
pub struct LocationResponse {
    pub hourly: Hourly,
}

/// Hourly series for one location. `time` is epoch **seconds**
/// (`timeformat=unixtime`); every other key is a variable.
#[derive(Debug, Clone, Deserialize)]
pub struct Hourly {
    pub time: Vec<i64>,
    #[serde(flatten)]
    pub series: HashMap<String, Vec<Option<f32>>>,
}

/// The three shapes a response body can take. The error variant must stay
/// first: untagged enums try variants in order, and an error body matched
/// against `One` would report a missing `hourly` instead of the real reason.
#[derive(Deserialize)]
#[serde(untagged)]
enum Body {
    Error { reason: String },
    Many(Vec<LocationResponse>),
    One(LocationResponse),
}

/// Hourly variable names for the surface plus `levels`, in a stable order.
pub fn hourly_variables(levels: &[u16]) -> Vec<String> {
    let mut vars = vec![
        "pressure_msl".to_string(),
        "wind_speed_10m".to_string(),
        "wind_direction_10m".to_string(),
    ];
    for level in levels {
        vars.push(format!("wind_speed_{level}hPa"));
        vars.push(format!("wind_direction_{level}hPa"));
    }
    vars
}

/// Builds one URL per chunk of at most `chunk` points.
pub fn build_urls(
    base_url: &str,
    model: &str,
    levels: &[u16],
    points: &[(f64, f64)],
    chunk: usize,
) -> Vec<String> {
    let hourly = hourly_variables(levels).join(",");
    points
        .chunks(chunk.max(1))
        .map(|chunk| {
            let lats = join_coords(chunk.iter().map(|p| p.0));
            let lons = join_coords(chunk.iter().map(|p| p.1));
            // cell_selection=nearest: the default (`land`) moves a point over
            // the sea to the nearest land cell, which is wrong for winds aloft.
            format!(
                "{base_url}?latitude={lats}&longitude={lons}&hourly={hourly}\
                 &past_hours=1&forecast_hours=2&wind_speed_unit=kn&timezone=GMT\
                 &timeformat=unixtime&cell_selection=nearest&models={model}"
            )
        })
        .collect()
}

fn join_coords(values: impl Iterator<Item = f64>) -> String {
    values.map(|v| v.to_string()).collect::<Vec<_>>().join(",")
}

/// Decodes a response body into per-location series, in request order.
pub fn parse_body(bytes: &[u8]) -> Result<Vec<LocationResponse>, OpenMeteoError> {
    match serde_json::from_slice::<Body>(bytes)? {
        Body::Error { reason } => Err(OpenMeteoError::Api(reason)),
        Body::Many(locations) => Ok(locations),
        Body::One(location) => Ok(vec![location]),
    }
}

/// Index of the timestamp (epoch seconds) nearest `now_ms`.
///
/// Ties go to the earlier hour: `min_by_key` returns the first minimum.
pub fn select_hour(times: &[i64], now_ms: i64) -> Option<usize> {
    times
        .iter()
        .enumerate()
        .min_by_key(|(_, t)| t.saturating_mul(1000).abs_diff(now_ms))
        .map(|(i, _)| i)
}

/// The value of `variable` at `valid_time_s` for one location.
fn value_at(location: &LocationResponse, variable: &str, valid_time_s: i64) -> Option<f32> {
    let idx = location
        .hourly
        .time
        .iter()
        .position(|&t| t == valid_time_s)?;
    location
        .hourly
        .series
        .get(variable)?
        .get(idx)
        .copied()
        .flatten()
}

/// Assembles a snapshot from per-location responses in grid (row-major) order.
///
/// The valid hour is chosen once, from the first location, and looked up by
/// value in every other one. A location missing that hour, or a variable the
/// model does not provide, yields `None` for those points rather than failing
/// the whole grid: a partial field is still worth drawing.
pub fn assemble_snapshot(
    grid: GridSpec,
    levels: &[u16],
    model: &str,
    locations: &[LocationResponse],
    now_ms: i64,
    fetched_at_ms: i64,
) -> Result<WeatherSnapshot, OpenMeteoError> {
    let expected = grid.len();
    if locations.len() != expected {
        return Err(OpenMeteoError::LocationCount {
            got: locations.len(),
            expected,
        });
    }

    let first = locations.first().ok_or(OpenMeteoError::NoTimes)?;
    let hour = select_hour(&first.hourly.time, now_ms).ok_or(OpenMeteoError::NoTimes)?;
    let valid_time_s = first.hourly.time[hour];

    // Matched by timestamp, not by index: a location whose series is offset
    // must become a gap, never a value from a different hour.
    let column = |variable: &str| -> Vec<Option<f32>> {
        locations
            .iter()
            .map(|location| value_at(location, variable, valid_time_s))
            .collect()
    };

    let surface = SurfaceFields {
        mslp_hpa: column("pressure_msl"),
        wind_speed_kt: column("wind_speed_10m"),
        wind_dir_deg: column("wind_direction_10m"),
    };
    let level_fields: BTreeMap<u16, LevelFields> = levels
        .iter()
        .map(|&level| {
            let fields = LevelFields {
                wind_speed_kt: column(&format!("wind_speed_{level}hPa")),
                wind_dir_deg: column(&format!("wind_direction_{level}hPa")),
            };
            (level, fields)
        })
        .collect();

    Ok(WeatherSnapshot {
        version: SNAPSHOT_VERSION,
        source: SOURCE.to_string(),
        attribution: ATTRIBUTION.to_string(),
        model: model.to_string(),
        fetched_at_ms,
        valid_time_ms: valid_time_s * 1000,
        grid,
        surface,
        levels: level_fields,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("fixtures/open_meteo_two_points.json");
    /// Second hour of the fixture, plus ten minutes.
    const NOW_MS: i64 = (1_789_412_400 + 600) * 1000;

    fn two_point_grid() -> GridSpec {
        GridSpec {
            lat0: 47.0,
            lon0: -3.0,
            dlat: 1.0,
            dlon: 1.0,
            nlat: 1,
            nlon: 2,
        }
    }

    fn fixture_snapshot() -> WeatherSnapshot {
        let locations = parse_body(FIXTURE.as_bytes()).unwrap();
        assemble_snapshot(
            two_point_grid(),
            &[250],
            "best_match",
            &locations,
            NOW_MS,
            42,
        )
        .unwrap()
    }

    #[test]
    fn variables_are_surface_then_each_level() {
        assert_eq!(
            hourly_variables(&[850, 250]),
            vec![
                "pressure_msl",
                "wind_speed_10m",
                "wind_direction_10m",
                "wind_speed_850hPa",
                "wind_direction_850hPa",
                "wind_speed_250hPa",
                "wind_direction_250hPa",
            ]
        );
        assert_eq!(hourly_variables(&[]).len(), 3);
    }

    #[test]
    fn url_carries_coordinates_variables_and_fixed_parameters() {
        let urls = build_urls(
            DEFAULT_BASE_URL,
            "best_match",
            &[250],
            &[(47.0, -2.0), (48.5, -3.0)],
            MAX_LOCATIONS_PER_REQUEST,
        );
        assert_eq!(urls.len(), 1);
        let url = &urls[0];
        assert!(url.starts_with("https://api.open-meteo.com/v1/forecast?"));
        assert!(url.contains("latitude=47,48.5"), "{url}");
        assert!(url.contains("longitude=-2,-3"), "{url}");
        assert!(url.contains(
            "hourly=pressure_msl,wind_speed_10m,wind_direction_10m,wind_speed_250hPa,wind_direction_250hPa"
        ));
        for fixed in [
            "past_hours=1",
            "forecast_hours=2",
            "wind_speed_unit=kn",
            "timezone=GMT",
            "timeformat=unixtime",
            "models=best_match",
            // Over the sea the default (`land`) moves the point ashore.
            "cell_selection=nearest",
        ] {
            assert!(url.contains(fixed), "missing {fixed} in {url}");
        }
    }

    #[test]
    fn points_are_split_into_chunks_in_order() {
        let points: Vec<(f64, f64)> = (0..120).map(|i| (i as f64, 0.0)).collect();
        let urls = build_urls(DEFAULT_BASE_URL, "best_match", &[], &points, 50);
        assert_eq!(urls.len(), 3);
        assert!(urls[0].contains("latitude=0,1,2,"));
        assert!(urls[1].contains("latitude=50,51,"));
        assert!(urls[2].contains("latitude=100,"));
        assert!(urls[2].contains(",119&"));
    }

    #[test]
    fn parses_a_multi_location_array() {
        let locations = parse_body(FIXTURE.as_bytes()).unwrap();
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[0].hourly.time.len(), 3);
        // Directions arrive as integers and must still decode.
        assert_eq!(
            locations[1].hourly.series["wind_direction_250hPa"][1],
            Some(239.0)
        );
    }

    #[test]
    fn parses_a_single_location_object() {
        let one = r#"{"hourly":{"time":[1789412400],"pressure_msl":[1012.0]}}"#;
        let locations = parse_body(one.as_bytes()).unwrap();
        assert_eq!(locations.len(), 1);
    }

    #[test]
    fn an_error_body_surfaces_the_reason() {
        let body = r#"{"error":true,"reason":"Cannot initialize WeatherVariable from invalid String value wind_speed_123hPa"}"#;
        match parse_body(body.as_bytes()) {
            Err(OpenMeteoError::Api(reason)) => assert!(reason.contains("wind_speed_123hPa")),
            other => panic!("expected Api error, got {other:?}"),
        }
    }

    #[test]
    fn garbage_is_a_json_error() {
        assert!(matches!(
            parse_body(b"<html>502</html>"),
            Err(OpenMeteoError::Json(_))
        ));
    }

    #[test]
    fn selects_the_nearest_hour() {
        let t0 = 1_789_408_800;
        let times = [t0, t0 + 3600, t0 + 7200];
        assert_eq!(select_hour(&times, (t0 + 3600 + 1000) * 1000), Some(1));
        assert_eq!(select_hour(&times, (t0 + 3600 + 1900) * 1000), Some(2));
        assert_eq!(select_hour(&times, (t0 - 99_999) * 1000), Some(0));
        assert_eq!(select_hour(&[], 0), None);
    }

    #[test]
    fn assembles_values_at_the_selected_hour_in_grid_order() {
        let snap = fixture_snapshot();
        assert_eq!(snap.valid_time_ms, 1_789_412_400_000);
        assert_eq!(snap.surface.mslp_hpa, vec![Some(1021.7), Some(1021.9)]);
        assert_eq!(snap.surface.wind_speed_kt, vec![Some(2.6), Some(5.9)]);
        assert_eq!(snap.surface.wind_dir_deg, vec![Some(279.0), Some(226.0)]);
        let l250 = &snap.levels[&250];
        assert_eq!(l250.wind_speed_kt, vec![Some(33.7), Some(49.7)]);
        assert_eq!(l250.wind_dir_deg, vec![Some(247.0), Some(239.0)]);
    }

    #[test]
    fn assembled_snapshot_is_stamped_and_valid() {
        let snap = fixture_snapshot();
        assert_eq!(snap.version, SNAPSHOT_VERSION);
        assert_eq!(snap.source, SOURCE);
        assert_eq!(snap.attribution, ATTRIBUTION);
        assert_eq!(snap.model, "best_match");
        assert_eq!(snap.fetched_at_ms, 42);
        assert!(snap.validate().is_ok());
    }

    #[test]
    fn a_variable_the_model_lacks_becomes_nulls_not_an_error() {
        let locations = parse_body(FIXTURE.as_bytes()).unwrap();
        let snap = assemble_snapshot(
            two_point_grid(),
            &[250, 200],
            "best_match",
            &locations,
            NOW_MS,
            0,
        )
        .unwrap();
        assert_eq!(snap.levels[&200].wind_speed_kt, vec![None, None]);
        assert!(snap.validate().is_ok());
    }

    #[test]
    fn null_values_stay_null() {
        let body = r#"[
            {"hourly":{"time":[1789412400],"pressure_msl":[null],"wind_speed_10m":[3.0],"wind_direction_10m":[90]}},
            {"hourly":{"time":[1789412400],"pressure_msl":[1010.0],"wind_speed_10m":[null],"wind_direction_10m":[null]}}
        ]"#;
        let locations = parse_body(body.as_bytes()).unwrap();
        let snap =
            assemble_snapshot(two_point_grid(), &[], "best_match", &locations, NOW_MS, 0).unwrap();
        assert_eq!(snap.surface.mslp_hpa, vec![None, Some(1010.0)]);
        assert_eq!(snap.surface.wind_speed_kt, vec![Some(3.0), None]);
    }

    #[test]
    fn a_location_missing_the_valid_hour_yields_nulls_for_that_point() {
        let body = r#"[
            {"hourly":{"time":[1789412400],"pressure_msl":[1011.0],"wind_speed_10m":[3.0],"wind_direction_10m":[90]}},
            {"hourly":{"time":[1789416000],"pressure_msl":[1012.0],"wind_speed_10m":[4.0],"wind_direction_10m":[80]}}
        ]"#;
        let locations = parse_body(body.as_bytes()).unwrap();
        let snap =
            assemble_snapshot(two_point_grid(), &[], "best_match", &locations, NOW_MS, 0).unwrap();
        assert_eq!(snap.surface.mslp_hpa, vec![Some(1011.0), None]);
    }

    #[test]
    fn a_short_response_is_a_location_count_error() {
        let mut locations = parse_body(FIXTURE.as_bytes()).unwrap();
        locations.pop();
        assert!(matches!(
            assemble_snapshot(
                two_point_grid(),
                &[250],
                "best_match",
                &locations,
                NOW_MS,
                0
            ),
            Err(OpenMeteoError::LocationCount {
                got: 1,
                expected: 2
            })
        ));
    }

    #[test]
    fn a_response_without_timestamps_is_an_error() {
        let body = r#"[{"hourly":{"time":[]}},{"hourly":{"time":[]}}]"#;
        let locations = parse_body(body.as_bytes()).unwrap();
        assert!(matches!(
            assemble_snapshot(two_point_grid(), &[], "best_match", &locations, NOW_MS, 0),
            Err(OpenMeteoError::NoTimes)
        ));
    }
}
