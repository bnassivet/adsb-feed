//! What OpenSky returned: its state vectors (`opensky_states`) and the flights
//! fetched from `/tracks` (`opensky_tracks`).
//!
//! Observed tables, written by a recorder (the data server, or an embedded
//! desktop) from the OpenSky service's MQTT topics, and read through views in
//! remote mode. Never mixed into `positions`: coverage, range and statistics
//! stay the receiver's own.

use super::StorageHandle;
use crate::error::StorageError;
use crate::types::{OpenSkyStateRow, OpenSkyTrackRecord};
use duckdb::OptionalExt;

/// A stored track counts as a whole flight once it was fetched this long after
/// its end: OpenSky had stopped hearing the aircraft by then. A track fetched
/// sooner may still have been growing, and is fetched again rather than served.
pub const OPENSKY_TRACK_SETTLED_S: i64 = 1_800;

const STATE_COLUMNS: &str = "icao24, time_position_s, fetched_ms, data_time_s, callsign, \
     latitude, longitude, altitude_ft, ground_speed_kt, track_deg, vertical_rate_fpm, on_ground, matched";

const TRACK_COLUMNS: &str =
    "icao24, callsign, start_time_s, end_time_s, fetched_ms, waypoint_count, path_json";

fn state_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<OpenSkyStateRow> {
    Ok(OpenSkyStateRow {
        icao24: row.get(0)?,
        time_position_s: row.get(1)?,
        fetched_ms: row.get(2)?,
        data_time_s: row.get(3)?,
        callsign: row.get(4)?,
        latitude: row.get(5)?,
        longitude: row.get(6)?,
        altitude_ft: row.get(7)?,
        ground_speed_kt: row.get(8)?,
        track_deg: row.get(9)?,
        vertical_rate_fpm: row.get(10)?,
        on_ground: row.get(11)?,
        matched: row.get(12)?,
    })
}

fn track_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<OpenSkyTrackRecord> {
    Ok(OpenSkyTrackRecord {
        icao24: row.get(0)?,
        callsign: row.get(1)?,
        start_time_s: row.get(2)?,
        end_time_s: row.get(3)?,
        fetched_ms: row.get(4)?,
        waypoint_count: row.get(5)?,
        path_json: row.get(6)?,
    })
}

impl StorageHandle {
    fn opensky_lock(&self) -> Result<std::sync::MutexGuard<'_, super::Storage>, StorageError> {
        self.inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))
    }

    /// Stores `rows`, skipping any `(icao24, time_position_s)` already stored
    /// or repeated in the batch. Returns how many were new.
    pub fn insert_opensky_states_sync(
        &self,
        rows: &[OpenSkyStateRow],
    ) -> Result<usize, StorageError> {
        if rows.is_empty() {
            return Ok(0);
        }
        let mut storage = self.opensky_lock()?;
        let tx = storage.conn.transaction()?;
        let mut inserted = 0;
        {
            // The anti-join sees the rows inserted earlier in the same
            // transaction, which covers a repeat inside the batch too.
            let mut stmt = tx.prepare(&format!(
                "INSERT INTO opensky_states ({STATE_COLUMNS}) \
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? \
                 WHERE NOT EXISTS (SELECT 1 FROM opensky_states WHERE icao24 = ? AND time_position_s = ?)"
            ))?;
            for r in rows {
                let icao = r.icao24.to_lowercase();
                inserted += stmt.execute(duckdb::params![
                    icao,
                    r.time_position_s,
                    r.fetched_ms,
                    r.data_time_s,
                    r.callsign,
                    r.latitude,
                    r.longitude,
                    r.altitude_ft,
                    r.ground_speed_kt,
                    r.track_deg,
                    r.vertical_rate_fpm,
                    r.on_ground,
                    r.matched,
                    icao,
                    r.time_position_s,
                ])?;
            }
        }
        tx.commit()?;
        Ok(inserted)
    }

    /// `icao24`'s stored states with a position time in `[from_s, to_s]`, oldest first.
    pub fn query_opensky_states_sync(
        &self,
        icao24: &str,
        from_s: i64,
        to_s: i64,
    ) -> Result<Vec<OpenSkyStateRow>, StorageError> {
        let storage = self.opensky_lock()?;
        let mut stmt = storage.conn.prepare(&format!(
            "SELECT {STATE_COLUMNS} FROM opensky_states \
             WHERE icao24 = ? AND time_position_s BETWEEN ? AND ? ORDER BY time_position_s"
        ))?;
        let rows = stmt
            .query_map(
                duckdb::params![icao24.to_lowercase(), from_s, to_s],
                state_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Stores a fetched flight, replacing the stored one with the same start
    /// only when this one is more complete: a later end, or the same end
    /// fetched later. Returns whether anything was written.
    pub fn upsert_opensky_track_sync(
        &self,
        track: &OpenSkyTrackRecord,
    ) -> Result<bool, StorageError> {
        let storage = self.opensky_lock()?;
        let icao = track.icao24.to_lowercase();
        let stored: Option<(i64, i64)> = storage
            .conn
            .query_row(
                "SELECT end_time_s, fetched_ms FROM opensky_tracks \
                 WHERE icao24 = ? AND start_time_s = ?",
                duckdb::params![icao, track.start_time_s],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some(stored) = stored
            && (track.end_time_s, track.fetched_ms) <= stored
        {
            return Ok(false);
        }
        storage.conn.execute(
            &format!("INSERT OR REPLACE INTO opensky_tracks ({TRACK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)"),
            duckdb::params![
                icao,
                track.callsign,
                track.start_time_s,
                track.end_time_s,
                track.fetched_ms,
                track.waypoint_count,
                track.path_json,
            ],
        )?;
        Ok(true)
    }

    /// The settled stored flight of `icao24` that was in the air at `time_s`
    /// (see [`OPENSKY_TRACK_SETTLED_S`]).
    pub fn find_opensky_track_sync(
        &self,
        icao24: &str,
        time_s: i64,
    ) -> Result<Option<OpenSkyTrackRecord>, StorageError> {
        let storage = self.opensky_lock()?;
        let found = storage
            .conn
            .query_row(
                &format!(
                    "SELECT {TRACK_COLUMNS} FROM opensky_tracks \
                     WHERE icao24 = ? AND start_time_s <= ? AND end_time_s >= ? \
                       AND fetched_ms >= (end_time_s + ?) * 1000 \
                     ORDER BY end_time_s - start_time_s DESC LIMIT 1"
                ),
                duckdb::params![
                    icao24.to_lowercase(),
                    time_s,
                    time_s,
                    OPENSKY_TRACK_SETTLED_S
                ],
                track_from_row,
            )
            .optional()?;
        Ok(found)
    }

    /// Stores states (async via spawn_blocking).
    pub async fn insert_opensky_states(
        &self,
        rows: Vec<OpenSkyStateRow>,
    ) -> Result<usize, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.insert_opensky_states_sync(&rows))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Stores a fetched flight (async via spawn_blocking).
    pub async fn upsert_opensky_track(
        &self,
        track: OpenSkyTrackRecord,
    ) -> Result<bool, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.upsert_opensky_track_sync(&track))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Finds a settled stored flight (async via spawn_blocking).
    pub async fn find_opensky_track(
        &self,
        icao24: String,
        time_s: i64,
    ) -> Result<Option<OpenSkyTrackRecord>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.find_opensky_track_sync(&icao24, time_s))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::StorageConfig;

    fn storage() -> StorageHandle {
        StorageHandle::open(StorageConfig::default()).unwrap()
    }

    fn state(icao: &str, t: i64) -> OpenSkyStateRow {
        OpenSkyStateRow {
            icao24: icao.into(),
            time_position_s: t,
            fetched_ms: t * 1_000 + 500,
            data_time_s: t,
            callsign: Some("DLH9LF".into()),
            latitude: 47.0,
            longitude: -2.0,
            altitude_ft: Some(35_000.0),
            ground_speed_kt: Some(450.0),
            track_deg: Some(270.0),
            vertical_rate_fpm: None,
            on_ground: Some(false),
            matched: "icao24".into(),
        }
    }

    fn track(start: i64, end: i64, fetched_s: i64) -> OpenSkyTrackRecord {
        OpenSkyTrackRecord {
            icao24: "3c6444".into(),
            callsign: Some("DLH9LF".into()),
            start_time_s: start,
            end_time_s: end,
            fetched_ms: fetched_s * 1_000,
            waypoint_count: 2,
            path_json: format!("[{{\"time\":{start}}},{{\"time\":{end}}}]"),
        }
    }

    #[test]
    fn a_frozen_position_repeated_across_polls_is_stored_once() {
        let s = storage();
        assert_eq!(
            s.insert_opensky_states_sync(&[state("3c6444", 100), state("3c6444", 100)])
                .unwrap(),
            1
        );
        // The next poll repeats it, beside a new one.
        assert_eq!(
            s.insert_opensky_states_sync(&[state("3c6444", 100), state("3c6444", 110)])
                .unwrap(),
            1
        );
        let rows = s.query_opensky_states_sync("3C6444", 0, 1_000).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.time_position_s).collect::<Vec<_>>(),
            vec![100, 110]
        );
        assert_eq!(rows[0], state("3c6444", 100));
    }

    #[test]
    fn a_track_is_replaced_only_by_a_more_complete_one() {
        let s = storage();
        // Fetched mid-flight: ends when fetched.
        assert!(
            s.upsert_opensky_track_sync(&track(1_000, 5_000, 5_000))
                .unwrap()
        );
        // The finished flight replaces it.
        assert!(
            s.upsert_opensky_track_sync(&track(1_000, 9_000, 20_000))
                .unwrap()
        );
        // An older, shorter copy arriving late does not.
        assert!(
            !s.upsert_opensky_track_sync(&track(1_000, 5_000, 5_000))
                .unwrap()
        );
        assert_eq!(
            s.find_opensky_track_sync("3c6444", 8_000).unwrap(),
            Some(track(1_000, 9_000, 20_000))
        );
    }

    #[test]
    fn only_a_settled_track_covering_the_time_is_found() {
        let s = storage();
        // Fetched a minute after its end: maybe still flying.
        s.upsert_opensky_track_sync(&track(1_000, 5_000, 5_060))
            .unwrap();
        assert_eq!(s.find_opensky_track_sync("3c6444", 3_000).unwrap(), None);
        let settled = track(1_000, 5_000, 5_000 + OPENSKY_TRACK_SETTLED_S);
        s.upsert_opensky_track_sync(&settled).unwrap();
        assert_eq!(
            s.find_opensky_track_sync("3C6444", 3_000).unwrap(),
            Some(settled)
        );
        // Outside the flight, or another aircraft: nothing.
        assert_eq!(s.find_opensky_track_sync("3c6444", 6_000).unwrap(), None);
        assert_eq!(s.find_opensky_track_sync("39de4f", 3_000).unwrap(), None);
    }

    #[test]
    fn retention_prunes_states_but_keeps_the_tracks_paid_for() {
        let s = storage();
        s.insert_opensky_states_sync(&[state("3c6444", 100), state("3c6444", 900)])
            .unwrap();
        s.upsert_opensky_track_sync(&track(100, 200, 100_000))
            .unwrap();
        s.prune_sync(500_000).unwrap();
        let left = s.query_opensky_states_sync("3c6444", 0, 1_000).unwrap();
        assert_eq!(
            left.iter().map(|r| r.time_position_s).collect::<Vec<_>>(),
            vec![900]
        );
        assert!(s.find_opensky_track_sync("3c6444", 150).unwrap().is_some());
    }
}
