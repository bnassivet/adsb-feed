//! Cache for web flight-info lookups (`aircraft_info`, `flight_routes`).
//!
//! Authored tables, not observed ones: rows are written by whoever asked for
//! them, so they stay local in remote mode too. Each row is written whole from
//! one source response, which is why a full-row `INSERT OR REPLACE` is safe
//! here (no partially-updated field to wipe).

use super::StorageHandle;
use crate::error::StorageError;
use crate::types::{AircraftInfo, Airport, FlightRoute};
use duckdb::{OptionalExt, params};

const AIRCRAFT_COLUMNS: &str = "hex_ident, found, icao_type, type_name, manufacturer, \
     registration, owner, owner_country, photo_url, photo_thumb_url, fetched_at_ms";

const ROUTE_COLUMNS: &str = "callsign, found, airline_name, airline_icao, airline_iata, \
     origin_icao, origin_iata, origin_name, origin_city, origin_country, origin_lat, origin_lon, \
     dest_icao, dest_iata, dest_name, dest_city, dest_country, dest_lat, dest_lon, fetched_at_ms";

/// Seven columns starting at `at` -> an airport, `None` when the ICAO is null.
fn airport_from_row(row: &duckdb::Row<'_>, at: usize) -> duckdb::Result<Option<Airport>> {
    let icao: Option<String> = row.get(at)?;
    Ok(match icao {
        None => None,
        Some(icao) => Some(Airport {
            icao,
            iata: row.get(at + 1)?,
            name: row.get(at + 2)?,
            city: row.get(at + 3)?,
            country: row.get(at + 4)?,
            latitude: row.get(at + 5)?,
            longitude: row.get(at + 6)?,
        }),
    })
}

/// Trimmed, upper-cased identifier; `None` when absent or blank. A `None`
/// bound in `= ?` matches nothing, which is what an absent identifier means.
fn norm(id: Option<&str>) -> Option<String> {
    id.map(|v| v.trim().to_uppercase())
        .filter(|v| !v.is_empty())
}

impl StorageHandle {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, super::Storage>, StorageError> {
        self.inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))
    }

    /// Cached airframe details for `hex_ident`, or `None` if never looked up.
    pub fn get_aircraft_info_sync(
        &self,
        hex_ident: &str,
    ) -> Result<Option<AircraftInfo>, StorageError> {
        let storage = self.lock()?;
        let row = storage
            .conn
            .query_row(
                &format!("SELECT {AIRCRAFT_COLUMNS} FROM aircraft_info WHERE hex_ident = ?"),
                params![hex_ident],
                |row| {
                    Ok(AircraftInfo {
                        hex_ident: row.get(0)?,
                        found: row.get(1)?,
                        icao_type: row.get(2)?,
                        type_name: row.get(3)?,
                        manufacturer: row.get(4)?,
                        registration: row.get(5)?,
                        owner: row.get(6)?,
                        owner_country: row.get(7)?,
                        photo_url: row.get(8)?,
                        photo_thumb_url: row.get(9)?,
                        fetched_at_ms: row.get(10)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Insert or replace the cached airframe details for one hex.
    pub fn upsert_aircraft_info_sync(&self, info: &AircraftInfo) -> Result<(), StorageError> {
        let storage = self.lock()?;
        storage.conn.execute(
            &format!(
                "INSERT OR REPLACE INTO aircraft_info ({AIRCRAFT_COLUMNS}) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ),
            params![
                info.hex_ident,
                info.found,
                info.icao_type,
                info.type_name,
                info.manufacturer,
                info.registration,
                info.owner,
                info.owner_country,
                info.photo_url,
                info.photo_thumb_url,
                info.fetched_at_ms,
            ],
        )?;
        Ok(())
    }

    /// Cached route for `callsign`, or `None` if never looked up.
    pub fn get_flight_route_sync(
        &self,
        callsign: &str,
    ) -> Result<Option<FlightRoute>, StorageError> {
        let storage = self.lock()?;
        let row = storage
            .conn
            .query_row(
                &format!("SELECT {ROUTE_COLUMNS} FROM flight_routes WHERE callsign = ?"),
                params![callsign],
                |row| {
                    Ok(FlightRoute {
                        callsign: row.get(0)?,
                        found: row.get(1)?,
                        airline_name: row.get(2)?,
                        airline_icao: row.get(3)?,
                        airline_iata: row.get(4)?,
                        origin: airport_from_row(row, 5)?,
                        destination: airport_from_row(row, 12)?,
                        fetched_at_ms: row.get(19)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Insert or replace the cached route for one callsign.
    pub fn upsert_flight_route_sync(&self, route: &FlightRoute) -> Result<(), StorageError> {
        let storage = self.lock()?;
        let o = route.origin.as_ref();
        let d = route.destination.as_ref();
        storage.conn.execute(
            &format!(
                "INSERT OR REPLACE INTO flight_routes ({ROUTE_COLUMNS}) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ),
            params![
                route.callsign,
                route.found,
                route.airline_name,
                route.airline_icao,
                route.airline_iata,
                o.map(|a| &a.icao),
                o.and_then(|a| a.iata.as_ref()),
                o.and_then(|a| a.name.as_ref()),
                o.and_then(|a| a.city.as_ref()),
                o.and_then(|a| a.country.as_ref()),
                o.and_then(|a| a.latitude),
                o.and_then(|a| a.longitude),
                d.map(|a| &a.icao),
                d.and_then(|a| a.iata.as_ref()),
                d.and_then(|a| a.name.as_ref()),
                d.and_then(|a| a.city.as_ref()),
                d.and_then(|a| a.country.as_ref()),
                d.and_then(|a| a.latitude),
                d.and_then(|a| a.longitude),
                route.fetched_at_ms,
            ],
        )?;
        Ok(())
    }

    /// The most recently seen `(hex, callsign)` pair in recorded flights that
    /// matches `hex` or `callsign` (case-insensitive, trimmed). Lets a caller
    /// that knows only one of the two identifiers look up the other.
    pub fn latest_flight_identity_sync(
        &self,
        hex_ident: Option<&str>,
        callsign: Option<&str>,
    ) -> Result<Option<(String, Option<String>)>, StorageError> {
        let hex = norm(hex_ident);
        let callsign = norm(callsign);
        if hex.is_none() && callsign.is_none() {
            return Ok(None);
        }
        let storage = self.lock()?;
        let row = storage
            .conn
            .query_row(
                "SELECT upper(trim(hex_ident)), nullif(upper(trim(callsign)), '') FROM flights \
                 WHERE upper(trim(hex_ident)) = ? OR upper(trim(callsign)) = ? \
                 ORDER BY last_seen_ms DESC LIMIT 1",
                params![hex, callsign],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(row)
    }

    /// Whether `hex` or `callsign` belongs to a saved simulation scenario.
    /// Simulated identities must never be sent to a web service.
    pub fn is_scenario_aircraft_sync(
        &self,
        hex_ident: Option<&str>,
        callsign: Option<&str>,
    ) -> Result<bool, StorageError> {
        let hex = norm(hex_ident);
        let callsign = norm(callsign);
        if hex.is_none() && callsign.is_none() {
            return Ok(false);
        }
        let storage = self.lock()?;
        let count: i64 = storage.conn.query_row(
            "SELECT count(*) FROM scenario_tracks \
             WHERE upper(trim(hex_ident)) = ? OR upper(trim(callsign)) = ?",
            params![hex, callsign],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::StorageConfig;

    fn storage() -> StorageHandle {
        StorageHandle::open(StorageConfig::default()).unwrap()
    }

    fn airport(icao: &str) -> Airport {
        Airport {
            icao: icao.into(),
            iata: Some("CDG".into()),
            name: Some("Paris Charles de Gaulle".into()),
            city: Some("Paris".into()),
            country: Some("France".into()),
            latitude: Some(49.0128),
            longitude: Some(2.55),
        }
    }

    fn info(hex: &str) -> AircraftInfo {
        AircraftInfo {
            hex_ident: hex.into(),
            found: true,
            icao_type: Some("A320".into()),
            type_name: Some("A320 214".into()),
            manufacturer: Some("Airbus".into()),
            registration: Some("F-HEPA".into()),
            owner: Some("Air France".into()),
            owner_country: Some("France".into()),
            photo_url: Some("https://example.test/p.jpg".into()),
            photo_thumb_url: Some("https://example.test/t.jpg".into()),
            fetched_at_ms: 1_000,
        }
    }

    fn route(cs: &str) -> FlightRoute {
        FlightRoute {
            callsign: cs.into(),
            found: true,
            airline_name: Some("Air France".into()),
            airline_icao: Some("AFR".into()),
            airline_iata: Some("AF".into()),
            origin: Some(airport("LFPG")),
            destination: Some(airport("KJFK")),
            fetched_at_ms: 2_000,
        }
    }

    #[test]
    fn aircraft_info_missing_is_none() {
        assert_eq!(storage().get_aircraft_info_sync("ABCDEF").unwrap(), None);
    }

    #[test]
    fn aircraft_info_round_trips() {
        let s = storage();
        s.upsert_aircraft_info_sync(&info("39BDA4")).unwrap();
        assert_eq!(
            s.get_aircraft_info_sync("39BDA4").unwrap(),
            Some(info("39BDA4"))
        );
    }

    #[test]
    fn aircraft_info_upsert_replaces() {
        let s = storage();
        s.upsert_aircraft_info_sync(&info("39BDA4")).unwrap();
        let mut newer = info("39BDA4");
        newer.registration = Some("F-HEPB".into());
        newer.fetched_at_ms = 5_000;
        s.upsert_aircraft_info_sync(&newer).unwrap();
        assert_eq!(s.get_aircraft_info_sync("39BDA4").unwrap(), Some(newer));
    }

    #[test]
    fn negative_aircraft_row_round_trips() {
        let s = storage();
        let unknown = AircraftInfo {
            hex_ident: "000001".into(),
            found: false,
            icao_type: None,
            type_name: None,
            manufacturer: None,
            registration: None,
            owner: None,
            owner_country: None,
            photo_url: None,
            photo_thumb_url: None,
            fetched_at_ms: 9,
        };
        s.upsert_aircraft_info_sync(&unknown).unwrap();
        assert_eq!(s.get_aircraft_info_sync("000001").unwrap(), Some(unknown));
    }

    #[test]
    fn flight_route_round_trips_with_airports() {
        let s = storage();
        s.upsert_flight_route_sync(&route("AFR006")).unwrap();
        assert_eq!(
            s.get_flight_route_sync("AFR006").unwrap(),
            Some(route("AFR006"))
        );
        assert_eq!(s.get_flight_route_sync("AFR007").unwrap(), None);
    }

    #[test]
    fn flight_route_without_destination_round_trips() {
        let s = storage();
        let mut r = route("AFR006");
        r.destination = None;
        r.found = false;
        s.upsert_flight_route_sync(&r).unwrap();
        s.upsert_flight_route_sync(&r).unwrap();
        assert_eq!(s.get_flight_route_sync("AFR006").unwrap(), Some(r));
    }

    fn add_flight(s: &StorageHandle, id: &str, hex: &str, cs: Option<&str>, last: i64) {
        s.lock()
            .unwrap()
            .conn
            .execute(
                "INSERT INTO flights (flight_id, hex_ident, flight_num, callsign, \
                 first_seen_ms, last_seen_ms) VALUES (?, ?, 1, ?, 0, ?)",
                params![id, hex, cs, last],
            )
            .unwrap();
    }

    #[test]
    fn identity_resolves_callsign_from_hex_latest_first() {
        let s = storage();
        add_flight(&s, "a", "39BDA4", Some("AFR001"), 10);
        add_flight(&s, "b", "39BDA4", Some("AFR777"), 20);
        assert_eq!(
            s.latest_flight_identity_sync(Some("39bda4"), None).unwrap(),
            Some(("39BDA4".into(), Some("AFR777".into())))
        );
    }

    #[test]
    fn identity_resolves_hex_from_callsign_ignoring_padding() {
        let s = storage();
        add_flight(&s, "a", "39BDA4", Some("AFR777  "), 10);
        assert_eq!(
            s.latest_flight_identity_sync(None, Some(" afr777"))
                .unwrap(),
            Some(("39BDA4".into(), Some("AFR777".into())))
        );
        assert_eq!(
            s.latest_flight_identity_sync(None, Some("DLH1")).unwrap(),
            None
        );
        assert_eq!(s.latest_flight_identity_sync(None, None).unwrap(), None);
    }

    #[test]
    fn scenario_aircraft_matched_by_hex_or_callsign() {
        let s = storage();
        s.lock()
            .unwrap()
            .conn
            .execute(
                "INSERT INTO scenario_tracks (id, scenario_id, hex_ident, callsign, category, \
                 waypoints_json, created_at_ms, updated_at_ms) \
                 VALUES ('t', 'sc', 'F00001', 'SIM01', 'airliner', '[]', 0, 0)",
                [],
            )
            .unwrap();
        assert!(s.is_scenario_aircraft_sync(Some("f00001"), None).unwrap());
        assert!(s.is_scenario_aircraft_sync(None, Some("sim01 ")).unwrap());
        assert!(
            !s.is_scenario_aircraft_sync(Some("39BDA4"), Some("AFR1"))
                .unwrap()
        );
        assert!(!s.is_scenario_aircraft_sync(None, None).unwrap());
    }
}
