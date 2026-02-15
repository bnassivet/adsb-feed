//! SBS-1 CSV message parser.
//!
//! Parses 22-field comma-separated SBS-1 (BaseStation) messages
//! into structured `AircraftPosition` values.

use serde::Serialize;

/// Parsed aircraft position from an SBS-1 message.
///
/// Fields are optional because each MSG subtype only populates
/// a subset. The frontend merges multiple updates per hex_ident
/// to build a complete aircraft state.
#[derive(Debug, Clone, Serialize)]
pub struct AircraftPosition {
    pub hex_ident: String,
    pub callsign: Option<String>,
    pub altitude: Option<f64>,
    pub ground_speed: Option<f64>,
    pub track: Option<f64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub vertical_rate: Option<f64>,
    pub squawk: Option<String>,
    pub is_on_ground: Option<bool>,
    pub timestamp: String,
}

/// Parses a raw SBS-1 line into an `AircraftPosition`.
///
/// Returns `None` for non-MSG lines or lines with fewer than 22 fields.
///
/// SBS-1 field layout (0-indexed):
///   0: message_type (MSG)
///   1: transmission_type (1-8)
///   2: session_id
///   3: aircraft_id
///   4: hex_ident
///   5: flight_id
///   6: date_generated
///   7: time_generated
///   8: date_logged
///   9: time_logged
///  10: callsign
///  11: altitude
///  12: ground_speed
///  13: track (heading)
///  14: latitude
///  15: longitude
///  16: vertical_rate
///  17: squawk
///  18: alert
///  19: emergency
///  20: spi
///  21: is_on_ground
pub fn parse_sbs_message(line: &str) -> Option<AircraftPosition> {
    let fields: Vec<&str> = line.split(',').collect();

    if fields.len() < 22 {
        return None;
    }

    // Only process MSG type messages
    if fields[0].trim() != "MSG" {
        return None;
    }

    let hex_ident = fields[4].trim().to_string();
    if hex_ident.is_empty() {
        return None;
    }

    // Build timestamp from date_generated + time_generated
    let timestamp = format!("{} {}", fields[6].trim(), fields[7].trim());

    Some(AircraftPosition {
        hex_ident,
        callsign: non_empty(fields[10]),
        altitude: parse_f64(fields[11]),
        ground_speed: parse_f64(fields[12]),
        track: parse_f64(fields[13]),
        latitude: parse_f64(fields[14]),
        longitude: parse_f64(fields[15]),
        vertical_rate: parse_f64(fields[16]),
        squawk: non_empty(fields[17]),
        is_on_ground: parse_bool(fields[21]),
        timestamp,
    })
}

fn non_empty(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok()
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.trim() {
        "0" | "-1" => Some(false),
        "1" => Some(true),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_msg3_position() {
        let line = "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,120.5,45.5017,-73.5673,,1234,,,,0";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.hex_ident, "A1B2C3");
        assert_eq!(pos.altitude, Some(35000.0));
        assert_eq!(pos.latitude, Some(45.5017));
        assert_eq!(pos.longitude, Some(-73.5673));
        assert_eq!(pos.is_on_ground, Some(false));
    }

    #[test]
    fn test_parse_msg1_callsign() {
        let line =
            "MSG,1,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,AIR123,,,,,,,,,,,";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.callsign, Some("AIR123".to_string()));
        assert_eq!(pos.altitude, None);
    }

    #[test]
    fn test_reject_non_msg() {
        assert!(parse_sbs_message("STA,1,1,1,A1B2C3,1,,,,,,,,,,,,,,,,").is_none());
    }

    #[test]
    fn test_reject_short_line() {
        assert!(parse_sbs_message("MSG,3,1").is_none());
    }

    #[test]
    fn test_parse_msg4_speed() {
        let line = "MSG,4,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,,450.5,275.3,,,,,,,,,0";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.ground_speed, Some(450.5));
        assert_eq!(pos.track, Some(275.3));
    }

    #[test]
    fn test_parse_msg5_squawk() {
        // Fields: 0=MSG,1=5,2=1,3=1,4=hex,5=1,6=date,7=time,8=date,9=time,10=cs,11=alt,12=gs,13=trk,14=lat,15=lon,16=vr,17=sqk,...
        let line = "MSG,5,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,,,,7700,,,,0";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.squawk, Some("7700".to_string()));
    }

    #[test]
    fn test_empty_hex_ident_returns_none() {
        let line = "MSG,3,1,1,,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,45.5,-73.5,,,,,,0";
        assert!(parse_sbs_message(line).is_none());
    }

    #[test]
    fn test_whitespace_in_fields() {
        let line = "MSG,3,1,1, A1B2C3 ,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000, AIR123 , 35000 ,,,,,,,,,, 0 ";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.hex_ident, "A1B2C3");
        assert_eq!(pos.callsign, Some("AIR123".to_string()));
        assert_eq!(pos.altitude, Some(35000.0));
    }

    #[test]
    fn test_is_on_ground_values() {
        // "0" -> false
        let line =
            "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,,,,,,,,,,,0";
        assert_eq!(parse_sbs_message(line).unwrap().is_on_ground, Some(false));

        // "1" -> true
        let line =
            "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,,,,,,,,,,,1";
        assert_eq!(parse_sbs_message(line).unwrap().is_on_ground, Some(true));

        // "-1" -> false
        let line =
            "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,,,,,,,,,,,-1";
        assert_eq!(parse_sbs_message(line).unwrap().is_on_ground, Some(false));

        // "" -> None
        let line = "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,,,,,,,,,,,";
        assert_eq!(parse_sbs_message(line).unwrap().is_on_ground, None);
    }

    #[test]
    fn test_all_optional_fields_empty() {
        let line = "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,,,,,,,,,,,";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.hex_ident, "A1B2C3");
        assert_eq!(pos.callsign, None);
        assert_eq!(pos.altitude, None);
        assert_eq!(pos.ground_speed, None);
        assert_eq!(pos.track, None);
        assert_eq!(pos.latitude, None);
        assert_eq!(pos.longitude, None);
        assert_eq!(pos.vertical_rate, None);
        assert_eq!(pos.squawk, None);
    }

    #[test]
    fn test_negative_altitude() {
        let line =
            "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,-50,,,,,,,,,,,";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.altitude, Some(-50.0));
    }

    #[test]
    fn test_extra_fields_ignored() {
        // 23+ fields — should still parse the first 22
        let line = "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,45.5,-73.5,,,,,,0,extra1,extra2";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.altitude, Some(35000.0));
    }

    #[test]
    fn test_non_numeric_altitude() {
        let line =
            "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,abc,,,,,,,,,,,";
        let pos = parse_sbs_message(line).unwrap();
        assert_eq!(pos.altitude, None);
    }

    #[test]
    fn test_parse_bool_edge_cases() {
        assert_eq!(parse_bool("0"), Some(false));
        assert_eq!(parse_bool("1"), Some(true));
        assert_eq!(parse_bool("-1"), Some(false));
        assert_eq!(parse_bool(""), None);
        assert_eq!(parse_bool("abc"), None);
    }
}
