//! A feed's announcement of where its antenna is.
//!
//! Published retained on [`Config::receiver_announce_topic`] by the MQTT
//! forwarder each time it connects, read by a recorder (and the desktop) that
//! subscribes to [`Config::receiver_announce_filter`]. The receiver's id is
//! the topic's last level, not part of the payload, for the same reason the
//! SBS topic carries it: the broker already routes on it.
//!
//! Small JSON, so a person can read it with `mosquitto_sub -v`, and far below
//! any subscriber's packet limit.

use crate::config::Config;
use serde::{Deserialize, Serialize};

/// The payload of a location announcement.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ReceiverLocationMessage {
    pub latitude: f64,
    pub longitude: f64,
    #[serde(default)]
    pub altitude_ft: Option<f64>,
    /// When the feed started with this position (ms since the epoch): the
    /// earliest the position is known to hold. A recorder that was down
    /// when the receiver moved dates the new period from here, not from
    /// whenever it next reconnects.
    pub since_ms: i64,
}

impl ReceiverLocationMessage {
    /// The announcement for `config`'s receiver, or `None` when it has no
    /// position configured.
    pub fn from_config(config: &Config, since_ms: i64) -> Option<Self> {
        Some(Self {
            latitude: config.receiver_latitude?,
            longitude: config.receiver_longitude?,
            altitude_ft: config.receiver_altitude,
            since_ms,
        })
    }

    pub fn to_json(&self) -> Vec<u8> {
        // A struct of numbers cannot fail to serialise.
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// Parses and checks a received payload: finite coordinates on the globe.
    pub fn parse(payload: &[u8]) -> Result<Self, String> {
        let msg: Self = serde_json::from_slice(payload).map_err(|e| e.to_string())?;
        let on_globe = msg.latitude.is_finite()
            && msg.longitude.is_finite()
            && (-90.0..=90.0).contains(&msg.latitude)
            && (-180.0..=180.0).contains(&msg.longitude)
            && msg.altitude_ft.is_none_or(f64::is_finite);
        if on_globe {
            Ok(msg)
        } else {
            Err(format!(
                "not a position on the globe: {}, {}",
                msg.latitude, msg.longitude
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn located() -> Config {
        Config {
            receiver_latitude: Some(46.7),
            receiver_longitude: Some(-2.3),
            receiver_altitude: Some(20.0),
            ..Config::default()
        }
    }

    #[test]
    fn a_configured_receiver_announces_itself() {
        let msg = ReceiverLocationMessage::from_config(&located(), 1_000).unwrap();
        assert_eq!(
            msg,
            ReceiverLocationMessage {
                latitude: 46.7,
                longitude: -2.3,
                altitude_ft: Some(20.0),
                since_ms: 1_000,
            }
        );
    }

    #[test]
    fn a_receiver_without_a_position_announces_nothing() {
        let half = Config {
            receiver_longitude: None,
            ..located()
        };
        assert_eq!(ReceiverLocationMessage::from_config(&half, 0), None);
        assert_eq!(
            ReceiverLocationMessage::from_config(&Config::default(), 0),
            None
        );
    }

    #[test]
    fn it_round_trips_through_json() {
        let msg = ReceiverLocationMessage::from_config(&located(), 1_000).unwrap();
        assert_eq!(ReceiverLocationMessage::parse(&msg.to_json()), Ok(msg));
    }

    #[test]
    fn the_altitude_is_optional_on_the_wire() {
        let msg = ReceiverLocationMessage::parse(br#"{"latitude":1,"longitude":2,"since_ms":3}"#)
            .unwrap();
        assert_eq!(msg.altitude_ft, None);
    }

    #[test]
    fn garbage_and_impossible_positions_are_refused() {
        assert!(ReceiverLocationMessage::parse(b"not json").is_err());
        assert!(
            ReceiverLocationMessage::parse(br#"{"latitude":95,"longitude":2,"since_ms":3}"#)
                .is_err()
        );
        assert!(
            ReceiverLocationMessage::parse(br#"{"latitude":1,"longitude":-200,"since_ms":3}"#)
                .is_err()
        );
    }
}
