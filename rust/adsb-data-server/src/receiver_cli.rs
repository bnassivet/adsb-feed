//! `adsb-data-server receiver ...`: read and edit receivers' location history.
//!
//! Kept free of clap so the desktop, which builds this crate without its CLI,
//! never pulls it in; the binary maps its arguments onto [`ReceiverCommand`].

use adsb_data_engine::{
    ChangeStamp, LocationChange, LocationOrigin, LocationPeriod, ReceiverSummary, StorageHandle,
};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};

/// One `receiver` subcommand, with the receiver already resolved.
#[derive(Debug, Clone, PartialEq)]
pub enum ReceiverCommand {
    /// Every known receiver and its current location.
    List,
    /// One receiver's history, oldest first.
    History { receiver: String },
    /// Apply a change to one receiver's history.
    Change {
        receiver: String,
        change: LocationChange,
        note: Option<String>,
    },
}

/// Runs `command` and returns what to print.
pub fn run(
    storage: &StorageHandle,
    command: &ReceiverCommand,
    now_ms: i64,
) -> anyhow::Result<String> {
    match command {
        ReceiverCommand::List => Ok(format_receivers(&storage.list_receivers_sync()?)),
        ReceiverCommand::History { receiver } => Ok(format_history(
            receiver,
            &storage.receiver_locations_sync(receiver)?,
        )),
        ReceiverCommand::Change {
            receiver,
            change,
            note,
        } => {
            let stamp = ChangeStamp {
                origin: LocationOrigin::Cli,
                recorded_at_ms: now_ms,
                note: note.clone(),
            };
            match storage.apply_receiver_change_sync(receiver, change, &stamp)? {
                Some(history) => Ok(format_history(receiver, &history)),
                None => Ok(format!(
                    "{receiver}: unchanged (the history already says so)\n"
                )),
            }
        }
    }
}

/// Parses an instant: `now`, epoch milliseconds, an RFC 3339 timestamp, or a
/// date (`2026-10-01`, midnight UTC).
pub fn parse_instant(text: &str, now_ms: i64) -> anyhow::Result<i64> {
    let text = text.trim();
    if text.eq_ignore_ascii_case("now") {
        return Ok(now_ms);
    }
    if let Ok(ms) = text.parse::<i64>() {
        return Ok(ms);
    }
    if let Ok(t) = DateTime::parse_from_rfc3339(text) {
        return Ok(t.timestamp_millis());
    }
    if let Ok(day) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Ok(day
            .and_hms_opt(0, 0, 0)
            .unwrap_or_default()
            .and_utc()
            .timestamp_millis());
    }
    anyhow::bail!(
        "'{text}' is not an instant: use now, epoch milliseconds, \
         2026-10-01 or 2026-10-01T12:00:00Z"
    )
}

/// `2026-10-01T12:00:00.000Z`: millisecond precision, so a printed
/// `valid_from` can be pasted back into `correct --from` exactly.
pub fn format_instant(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| ms.to_string())
}

/// The history as a table, oldest first.
pub fn format_history(receiver: &str, periods: &[LocationPeriod]) -> String {
    if periods.is_empty() {
        return format!(
            "{receiver}: no location history. Start one with \
             `receiver move --receiver {receiver} --lat .. --lon .. --at ..`\n"
        );
    }
    let mut out = format!("{receiver}: {} location period(s)\n", periods.len());
    for p in periods {
        let to = p
            .valid_to_ms
            .map_or_else(|| "(current)".to_string(), format_instant);
        out += &format!(
            "  {} -> {:<24}  {:>10.6} {:>11.6} {:>8}  {:<8}{}\n",
            format_instant(p.valid_from_ms),
            to,
            p.position.latitude,
            p.position.longitude,
            p.position
                .altitude_ft
                .map_or_else(|| "-".to_string(), |a| format!("{a:.0} ft")),
            p.origin.as_str(),
            p.note
                .as_deref()
                .map(|n| format!("  {n}"))
                .unwrap_or_default(),
        );
    }
    out
}

/// Every receiver with its current location, or why it has none.
pub fn format_receivers(receivers: &[ReceiverSummary]) -> String {
    if receivers.is_empty() {
        return "No receivers recorded yet.\n".to_string();
    }
    let mut out = String::new();
    for r in receivers {
        let location = match &r.current {
            Some(p) => format!(
                "{:.6} {:.6} since {}",
                p.position.latitude,
                p.position.longitude,
                format_instant(p.valid_from_ms)
            ),
            None => "location unknown".to_string(),
        };
        out += &format!(
            "{:<24} {location}  ({} period(s))\n",
            r.source_id, r.period_count
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_data_engine::{ReceiverPosition, StorageConfig};

    const NOW: i64 = 1_790_000_000_000;

    fn storage() -> StorageHandle {
        StorageHandle::open(StorageConfig {
            db_path: None,
            source_id: "rx".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
            remote: None,
        })
        .unwrap()
    }

    fn at(lat: f64, at_ms: i64) -> LocationChange {
        LocationChange::Move {
            position: ReceiverPosition::new(lat, -2.3, None),
            at_ms,
        }
    }

    #[test]
    fn instants_parse_in_every_accepted_form() {
        assert_eq!(parse_instant("now", NOW).unwrap(), NOW);
        assert_eq!(
            parse_instant("1700000000000", NOW).unwrap(),
            1_700_000_000_000
        );
        assert_eq!(
            parse_instant("2026-10-01T12:00:00Z", NOW).unwrap(),
            1_790_856_000_000
        );
        assert_eq!(
            parse_instant("2026-10-01T14:00:00+02:00", NOW).unwrap(),
            1_790_856_000_000
        );
        assert_eq!(parse_instant("2026-10-01", NOW).unwrap(), 1_790_812_800_000);
        assert!(parse_instant("last tuesday", NOW).is_err());
    }

    #[test]
    fn a_formatted_instant_parses_back_to_the_same_millisecond() {
        let ms = 1_790_856_000_123;
        assert_eq!(format_instant(ms), "2026-10-01T12:00:00.123Z");
        assert_eq!(parse_instant(&format_instant(ms), NOW).unwrap(), ms);
    }

    #[test]
    fn a_change_is_stamped_as_coming_from_the_cli_with_its_note() {
        let s = storage();
        let out = run(
            &s,
            &ReceiverCommand::Change {
                receiver: "pi-a".into(),
                change: at(46.7, 1_000),
                note: Some("antenna on the roof".into()),
            },
            NOW,
        )
        .unwrap();
        assert!(out.contains("pi-a"), "{out}");
        let history = s.receiver_locations_sync("pi-a").unwrap();
        assert_eq!(history[0].origin, LocationOrigin::Cli);
        assert_eq!(history[0].recorded_at_ms, NOW);
        assert_eq!(history[0].note.as_deref(), Some("antenna on the roof"));
    }

    #[test]
    fn a_no_op_change_says_so() {
        let s = storage();
        let cmd = ReceiverCommand::Change {
            receiver: "pi-a".into(),
            change: LocationChange::Observe {
                position: ReceiverPosition::new(46.7, -2.3, None),
                at_ms: 1_000,
            },
            note: None,
        };
        run(&s, &cmd, NOW).unwrap();
        let out = run(&s, &cmd, NOW).unwrap();
        assert!(out.contains("unchanged"), "{out}");
    }

    #[test]
    fn a_refused_change_is_an_error_naming_the_rule() {
        let s = storage();
        let err = run(
            &s,
            &ReceiverCommand::Change {
                receiver: "pi-a".into(),
                change: LocationChange::Remove { valid_from_ms: 5 },
                note: None,
            },
            NOW,
        )
        .unwrap_err();
        let shown = format!("{err:#}");
        assert_eq!(
            shown.matches("no location period starts at 5").count(),
            1,
            "said once, not once per error layer: {shown}"
        );
    }

    #[test]
    fn history_prints_each_period_with_pasteable_starts() {
        let s = storage();
        for change in [at(46.7, 1_790_812_800_000), at(47.2, 1_790_856_000_000)] {
            run(
                &s,
                &ReceiverCommand::Change {
                    receiver: "pi-a".into(),
                    change,
                    note: None,
                },
                NOW,
            )
            .unwrap();
        }
        let out = run(
            &s,
            &ReceiverCommand::History {
                receiver: "pi-a".into(),
            },
            NOW,
        )
        .unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].contains("pi-a"), "{out}");
        assert!(out.contains("2026-10-01T00:00:00.000Z"), "{out}");
        assert!(out.contains("2026-10-01T12:00:00.000Z"), "{out}");
        assert!(out.contains("46.700000"), "{out}");
        assert!(out.contains("(current)"), "{out}");
        assert!(out.contains("cli"), "{out}");
    }

    #[test]
    fn an_empty_history_says_how_to_start_one() {
        let out = format_history("pi-a", &[]);
        assert!(out.contains("no location history"), "{out}");
        assert!(out.contains("receiver move"), "{out}");
    }

    #[test]
    fn list_shows_receivers_with_and_without_a_location() {
        let s = storage();
        s.register_receiver_sync("pi-quiet", 0).unwrap();
        run(
            &s,
            &ReceiverCommand::Change {
                receiver: "pi-a".into(),
                change: at(46.7, 1_000),
                note: None,
            },
            NOW,
        )
        .unwrap();
        let out = run(&s, &ReceiverCommand::List, NOW).unwrap();
        assert!(out.contains("pi-a") && out.contains("46.700000"), "{out}");
        assert!(out.contains("pi-quiet") && out.contains("unknown"), "{out}");
    }
}
