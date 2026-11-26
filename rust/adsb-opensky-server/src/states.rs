//! OpenSky state vectors and tracks, and the message this service publishes.
//!
//! OpenSky answers `/states/all` with each aircraft as a **positional array**
//! of 18 values, most of them nullable. That shape is decoded here, once, into
//! [`OpenSkyState`]; nothing downstream sees an index.
//!
//! The parser is per field and lenient: a value of the wrong type becomes
//! `None` rather than failing the row, and a row without a usable icao24 is
//! dropped rather than failing the response. One odd aircraft must not blank
//! the whole poll.
//!
//! No service dependencies: the desktop decodes [`StatesMessage`] with this.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// [`StatesMessage`] schema version. Bump on any incompatible change.
pub const STATES_VERSION: u32 = 1;

/// Metres to feet.
const FT_PER_M: f64 = 3.280_839_9;
/// Metres per second to knots.
const KT_PER_MS: f64 = 1.943_844_5;
/// Metres per second to feet per minute.
const FPM_PER_MS: f64 = 196.850_39;

/// How OpenSky obtained a position (`position_source`, index 16).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum PositionSource {
    AdsB,
    Asterix,
    Mlat,
    Flarm,
    Unknown,
}

impl PositionSource {
    fn from_code(code: Option<i64>) -> Option<Self> {
        Some(match code? {
            0 => Self::AdsB,
            1 => Self::Asterix,
            2 => Self::Mlat,
            3 => Self::Flarm,
            _ => Self::Unknown,
        })
    }
}

/// One aircraft as OpenSky reports it, in the units the rest of the stack uses
/// (feet, knots, feet per minute), so the desktop compares it with local
/// tracks without converting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct OpenSkyState {
    /// Lowercase hex, as OpenSky sends it.
    pub icao24: String,
    /// Trimmed; OpenSky pads it to 8 characters.
    #[serde(default)]
    pub callsign: Option<String>,
    #[serde(default)]
    pub origin_country: Option<String>,
    /// Epoch seconds of the last position update.
    #[serde(default)]
    pub time_position: Option<i64>,
    /// Epoch seconds of the last message of any kind.
    #[serde(default)]
    pub last_contact: Option<i64>,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    /// Barometric altitude, feet.
    #[serde(default)]
    pub altitude_ft: Option<f64>,
    /// Geometric altitude, feet.
    #[serde(default)]
    pub geo_altitude_ft: Option<f64>,
    pub on_ground: bool,
    /// Ground speed, knots.
    #[serde(default)]
    pub ground_speed_kt: Option<f64>,
    /// True track, degrees clockwise from north.
    #[serde(default)]
    pub track_deg: Option<f64>,
    /// Feet per minute.
    #[serde(default)]
    pub vertical_rate_fpm: Option<f64>,
    #[serde(default)]
    pub squawk: Option<String>,
    #[serde(default)]
    pub position_source: Option<PositionSource>,
}

impl OpenSkyState {
    /// Whether the state carries a usable position.
    pub fn has_position(&self) -> bool {
        self.latitude.is_some() && self.longitude.is_some()
    }
}

/// Why an OpenSky response was rejected.
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("malformed OpenSky JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unexpected OpenSky response: {0}")]
    Shape(&'static str),
}

fn number(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|f| f.is_finite())
}

fn integer(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

/// Converted values are rounded to 0.1: finer than any display needs, and it
/// keeps conversion noise (35000.0000532 ft) out of the payload.
fn tenth(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn text(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn is_icao24(s: &str) -> bool {
    s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Decodes one state-vector array. `None` when it has no usable icao24.
pub fn parse_state(row: &Value) -> Option<OpenSkyState> {
    let a = row.as_array()?;
    let icao24 = text(a.first())?.to_ascii_lowercase();
    if !is_icao24(&icao24) {
        return None;
    }
    Some(OpenSkyState {
        icao24,
        callsign: text(a.get(1)),
        origin_country: text(a.get(2)),
        time_position: integer(a.get(3)),
        last_contact: integer(a.get(4)),
        longitude: number(a.get(5)).filter(|v| (-180.0..=180.0).contains(v)),
        latitude: number(a.get(6)).filter(|v| (-90.0..=90.0).contains(v)),
        altitude_ft: number(a.get(7)).map(|m| tenth(m * FT_PER_M)),
        on_ground: a.get(8).and_then(Value::as_bool).unwrap_or(false),
        ground_speed_kt: number(a.get(9)).map(|ms| tenth(ms * KT_PER_MS)),
        track_deg: number(a.get(10)),
        vertical_rate_fpm: number(a.get(11)).map(|ms| tenth(ms * FPM_PER_MS)),
        geo_altitude_ft: number(a.get(13)).map(|m| tenth(m * FT_PER_M)),
        squawk: text(a.get(14)),
        position_source: PositionSource::from_code(integer(a.get(16))),
    })
}

/// A decoded `/states/all` response.
#[derive(Debug, Clone, PartialEq)]
pub struct StatesResponse {
    /// OpenSky's own timestamp for the data, epoch seconds.
    pub time: i64,
    pub states: Vec<OpenSkyState>,
}

/// Decodes a `/states/all` body. `"states": null` -- nothing in the box -- is
/// an empty list, not an error.
pub fn parse_states(bytes: &[u8]) -> Result<StatesResponse, ParseError> {
    let v: Value = serde_json::from_slice(bytes)?;
    let obj = v.as_object().ok_or(ParseError::Shape("not an object"))?;
    let time = integer(obj.get("time")).ok_or(ParseError::Shape("no time"))?;
    let states = match obj.get("states") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(rows)) => rows.iter().filter_map(parse_state).collect(),
        Some(_) => return Err(ParseError::Shape("states is not an array")),
    };
    Ok(StatesResponse { time, states })
}

/// One waypoint of an OpenSky track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct Waypoint {
    /// Epoch seconds.
    pub time: i64,
    pub latitude: f64,
    pub longitude: f64,
    /// Barometric altitude, feet.
    #[serde(default)]
    pub altitude_ft: Option<f64>,
    #[serde(default)]
    pub track_deg: Option<f64>,
    pub on_ground: bool,
}

/// An aircraft's track, from `/tracks/all`: sparse waypoints, not every
/// position (one per turn, altitude step, or 15 minutes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct OpenSkyTrack {
    pub icao24: String,
    #[serde(default)]
    pub callsign: Option<String>,
    /// Epoch seconds.
    pub start_time: i64,
    /// Epoch seconds.
    pub end_time: i64,
    pub path: Vec<Waypoint>,
}

/// Decodes a `/tracks/all` body. Waypoints without a position are skipped.
pub fn parse_track(bytes: &[u8]) -> Result<OpenSkyTrack, ParseError> {
    let v: Value = serde_json::from_slice(bytes)?;
    let obj = v.as_object().ok_or(ParseError::Shape("not an object"))?;
    let icao24 = text(obj.get("icao24"))
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| is_icao24(s))
        .ok_or(ParseError::Shape("no icao24"))?;
    // OpenSky's documentation spells it `calllsign`; accept both.
    let callsign = text(obj.get("callsign")).or_else(|| text(obj.get("calllsign")));
    let path = obj
        .get("path")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|w| {
                    let a = w.as_array()?;
                    Some(Waypoint {
                        time: integer(a.first())?,
                        latitude: number(a.get(1))?,
                        longitude: number(a.get(2))?,
                        altitude_ft: number(a.get(3)).map(|m| tenth(m * FT_PER_M)),
                        track_deg: number(a.get(4)),
                        on_ground: a.get(5).and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(OpenSkyTrack {
        icao24,
        callsign,
        start_time: integer(obj.get("startTime")).unwrap_or(0),
        end_time: integer(obj.get("endTime")).unwrap_or(0),
        path,
    })
}

/// Why a state is in the message: the aircraft was asked for by name, or it
/// is inside a watched area. One state can match several.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Match {
    /// Watched by icao24.
    Aircraft,
    /// Inside the area with this id.
    Area { id: String },
}

/// A state and why it was fetched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct MatchedState {
    pub state: OpenSkyState,
    pub matched: Vec<Match>,
}

/// What one poll publishes on the states topic.
///
/// Not retained: a position is only worth showing while it is fresh, and a
/// retained one would greet a desktop that starts an hour later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct StatesMessage {
    pub version: u32,
    /// When the poll finished, epoch ms.
    pub fetched_ms: i64,
    /// OpenSky's timestamp for the data, epoch seconds.
    pub data_time: i64,
    pub states: Vec<MatchedState>,
}

impl StatesMessage {
    /// Parses a payload and checks its version.
    pub fn from_json(bytes: &[u8]) -> Result<Self, ParseError> {
        let message: Self = serde_json::from_slice(bytes)?;
        if message.version != STATES_VERSION {
            return Err(ParseError::Shape("unsupported states message version"));
        }
        Ok(message)
    }
}

/// Track message schema version. Bump on any incompatible change.
pub const TRACKS_VERSION: u32 = 1;

/// What the service publishes on the tracks topic after each `/tracks`
/// fetch, so recorders can store it. Not retained: one fetch, one record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackMessage {
    pub version: u32,
    /// When OpenSky answered, epoch ms: a track fetched mid-flight is
    /// incomplete, and this says so.
    pub fetched_ms: i64,
    pub track: OpenSkyTrack,
}

impl TrackMessage {
    pub fn new(fetched_ms: i64, track: OpenSkyTrack) -> Self {
        Self {
            version: TRACKS_VERSION,
            fetched_ms,
            track,
        }
    }

    /// Parses a payload and checks its version.
    pub fn from_json(bytes: &[u8]) -> Result<Self, ParseError> {
        let message: Self = serde_json::from_slice(bytes)?;
        if message.version != TRACKS_VERSION {
            return Err(ParseError::Shape("unsupported track message version"));
        }
        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_track_message_round_trips_and_checks_its_version() {
        let m = TrackMessage::new(
            1_764_000_000_000,
            OpenSkyTrack {
                icao24: "3c6444".into(),
                callsign: Some("DLH9LF".into()),
                start_time: 1_763_990_000,
                end_time: 1_763_999_000,
                path: vec![],
            },
        );
        let bytes = serde_json::to_vec(&m).unwrap();
        assert_eq!(TrackMessage::from_json(&bytes).unwrap(), m);
        let mut other = serde_json::to_value(&m).unwrap();
        other["version"] = json!(TRACKS_VERSION + 1);
        assert!(TrackMessage::from_json(other.to_string().as_bytes()).is_err());
    }

    /// The shape OpenSky documents, with the nulls it really sends.
    const RESPONSE: &str = r#"{
        "time": 1764000000,
        "states": [
            ["3c6444", "DLH9LF  ", "Germany", 1763999995, 1763999999,
             -2.1, 46.9, 10668.0, false, 231.5, 87.2, -5.2,
             null, 10900.0, "1000", false, 0, 1],
            ["39de4f", "", "France", null, 1763999990,
             null, null, null, true, 0.0, null, null,
             null, null, null, false, 0],
            ["nothex", "X", "Nowhere", null, 0, 0, 0, 0, false, 0, 0, 0, null, 0, null, false, 0],
            "not an array"
        ]
    }"#;

    #[test]
    fn a_full_row_is_decoded_into_stack_units() {
        let r = parse_states(RESPONSE.as_bytes()).unwrap();
        assert_eq!(r.time, 1_764_000_000);
        let s = &r.states[0];
        assert_eq!(s.icao24, "3c6444");
        assert_eq!(s.callsign.as_deref(), Some("DLH9LF"));
        assert_eq!(s.latitude, Some(46.9));
        assert_eq!(s.longitude, Some(-2.1));
        assert!((s.altitude_ft.unwrap() - 35_000.0).abs() < 1.0);
        assert!((s.ground_speed_kt.unwrap() - 450.0).abs() < 0.1);
        assert!((s.vertical_rate_fpm.unwrap() + 1023.6).abs() < 0.1);
        assert_eq!(s.squawk.as_deref(), Some("1000"));
        assert_eq!(s.position_source, Some(PositionSource::AdsB));
        assert!(s.has_position());
    }

    #[test]
    fn nulls_become_none_and_an_empty_callsign_is_absent() {
        let r = parse_states(RESPONSE.as_bytes()).unwrap();
        let s = &r.states[1];
        assert_eq!(s.icao24, "39de4f");
        assert_eq!(s.callsign, None);
        assert_eq!(s.latitude, None);
        assert!(s.on_ground);
        assert!(!s.has_position());
    }

    #[test]
    fn rows_without_a_valid_icao24_are_dropped_not_fatal() {
        let r = parse_states(RESPONSE.as_bytes()).unwrap();
        assert_eq!(r.states.len(), 2);
    }

    #[test]
    fn null_states_is_an_empty_box() {
        let r = parse_states(br#"{"time": 5, "states": null}"#).unwrap();
        assert!(r.states.is_empty());
    }

    #[test]
    fn a_wrong_typed_field_is_none_not_an_error() {
        let row = json!(["ABCDEF", 7, null, "x", null, "lon", 1.0, null, "yes"]);
        let s = parse_state(&row).unwrap();
        assert_eq!(s.icao24, "abcdef", "lowercased");
        assert_eq!(s.callsign, None);
        assert_eq!(s.longitude, None);
        assert!(!s.on_ground);
    }

    #[test]
    fn an_out_of_range_coordinate_is_dropped() {
        let row = json!(["abcdef", null, null, null, null, 200.0, 95.0]);
        let s = parse_state(&row).unwrap();
        assert!(!s.has_position());
    }

    #[test]
    fn a_body_that_is_not_a_states_response_is_an_error() {
        assert!(parse_states(b"[]").is_err());
        assert!(parse_states(br#"{"states": []}"#).is_err());
        assert!(parse_states(b"<html>").is_err());
    }

    #[test]
    fn a_track_is_decoded_and_positionless_waypoints_skipped() {
        let body = br#"{
            "icao24": "3c6444", "calllsign": "DLH9LF  ",
            "startTime": 1763990000, "endTime": 1764000000,
            "path": [
                [1763990000, 47.1, -1.5, 1000.0, 270.0, false],
                [1763995000, null, -1.6, 9000.0, 271.0, false],
                [1764000000, 46.9, -2.1, 10668.0, 87.2, false]
            ]
        }"#;
        let t = parse_track(body).unwrap();
        assert_eq!(t.icao24, "3c6444");
        assert_eq!(t.callsign.as_deref(), Some("DLH9LF"));
        assert_eq!(t.path.len(), 2);
        assert_eq!(t.path[1].time, 1_764_000_000);
        assert!((t.path[1].altitude_ft.unwrap() - 35_000.0).abs() < 1.0);
    }

    #[test]
    fn a_message_round_trips_with_its_matches() {
        let state = parse_states(RESPONSE.as_bytes()).unwrap().states.remove(0);
        let message = StatesMessage {
            version: STATES_VERSION,
            fetched_ms: 1,
            data_time: 2,
            states: vec![MatchedState {
                state,
                matched: vec![Match::Aircraft, Match::Area { id: "west".into() }],
            }],
        };
        let bytes = serde_json::to_vec(&message).unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["states"][0]["state"]["icao24"], "3c6444");
        assert_eq!(
            v["states"][0]["matched"][1],
            json!({"kind": "area", "id": "west"})
        );
        assert_eq!(StatesMessage::from_json(&bytes).unwrap(), message);
    }

    #[test]
    fn another_message_version_is_rejected() {
        let body = br#"{"version": 2, "fetched_ms": 0, "data_time": 0, "states": []}"#;
        assert!(StatesMessage::from_json(body).is_err());
    }
}
