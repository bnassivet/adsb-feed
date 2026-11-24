//! Receivers and their location history (SCD2) in DuckDB.
//!
//! The period rules live in [`crate::receiver_history`]. This module only
//! reads a receiver's periods, hands them to those pure functions, and swaps
//! the result in one transaction. Reads go through the plain table names,
//! which in remote mode are views over the daemon's catalog. Writes in remote
//! mode run on the daemon itself (`quack_query_by_name`): through the attached
//! catalog Quack accepts a plain INSERT but no UPDATE, DELETE or ON CONFLICT.

use super::{REMOTE_CATALOG, Storage, StorageHandle};
use crate::error::StorageError;
use crate::receiver_history::{
    ChangeStamp, LocationChange, LocationOrigin, LocationPeriod, ReceiverPosition, ReceiverSummary,
    apply,
};
use duckdb::params;

/// The script that replaces `source_id`'s history with `periods` and
/// registers it, as one transaction, for a daemon reached over Quack.
fn swap_script(source_id: &str, periods: &[LocationPeriod], seen_ms: i64) -> String {
    let id = sql_text(source_id);
    let mut script =
        format!("BEGIN TRANSACTION;\nDELETE FROM receiver_locations WHERE source_id = {id};\n");
    if !periods.is_empty() {
        let rows: Vec<String> = periods
            .iter()
            .map(|p| {
                format!(
                    "({id}, {}, {}, {:?}, {:?}, {}, {}, {}, {})",
                    p.valid_from_ms,
                    sql_opt(p.valid_to_ms),
                    p.position.latitude,
                    p.position.longitude,
                    p.position
                        .altitude_ft
                        .map_or_else(|| "NULL".to_string(), |a| format!("{a:?}")),
                    sql_text(p.origin.as_str()),
                    p.recorded_at_ms,
                    p.note
                        .as_deref()
                        .map_or_else(|| "NULL".to_string(), sql_text),
                )
            })
            .collect();
        script += &format!(
            "INSERT INTO receiver_locations (source_id, {PERIOD_COLUMNS}) VALUES\n  {};\n",
            rows.join(",\n  ")
        );
    }
    script += &format!("{};\nCOMMIT;\n", register_sql(&id, seen_ms));
    script
}

/// A SQL string literal.
fn sql_text(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn sql_opt(value: Option<i64>) -> String {
    value.map_or_else(|| "NULL".to_string(), |v| v.to_string())
}

/// Upserts a receiver, keeping its earliest sighting. `id` is SQL already.
fn register_sql(id: &str, seen_ms: i64) -> String {
    format!(
        "INSERT INTO receivers (source_id, name, first_seen_ms) VALUES ({id}, NULL, {seen_ms}) \
         ON CONFLICT (source_id) DO UPDATE \
         SET first_seen_ms = LEAST(receivers.first_seen_ms, excluded.first_seen_ms)"
    )
}

/// Runs `script` on the attached daemon, where the tables are real.
///
/// Through the attached catalog only a plain INSERT works (UPDATE, DELETE and
/// ON CONFLICT are refused), so writes run server-side instead. A failed
/// script leaves that server session inside its transaction, hence the
/// explicit ROLLBACK.
fn run_on_daemon(storage: &Storage, script: &str) -> Result<(), StorageError> {
    let run = |sql: &str| {
        storage.conn.execute(
            "SELECT * FROM quack_query_by_name(?, ?)",
            params![REMOTE_CATALOG, sql],
        )
    };
    if let Err(e) = run(script) {
        let _ = run("ROLLBACK");
        return Err(e.into());
    }
    Ok(())
}

impl StorageHandle {
    /// Records that `source_id` exists, first seen at `seen_ms`.
    ///
    /// Idempotent; a later call with an earlier time moves `first_seen_ms`
    /// back (an import of older data), never forward.
    pub fn register_receiver_sync(
        &self,
        source_id: &str,
        seen_ms: i64,
    ) -> Result<(), StorageError> {
        let storage = lock(self)?;
        register(&storage, source_id, seen_ms)
    }

    /// Every known receiver, with its current location if one is open.
    pub fn list_receivers_sync(&self) -> Result<Vec<ReceiverSummary>, StorageError> {
        let storage = lock(self)?;
        let mut stmt = storage.conn.prepare(
            "SELECT r.source_id, r.name, r.first_seen_ms,
                    (SELECT COUNT(*) FROM receiver_locations l
                      WHERE l.source_id = r.source_id),
                    c.valid_from_ms, c.valid_to_ms, c.latitude, c.longitude,
                    c.altitude_ft, c.origin, c.recorded_at_ms, c.note
             FROM receivers r
             LEFT JOIN receiver_locations c
               ON c.source_id = r.source_id AND c.valid_to_ms IS NULL
             ORDER BY r.source_id",
        )?;
        let rows = stmt.query_map([], |row| {
            let current = match row.get::<_, Option<i64>>(4)? {
                Some(_) => Some(period_from_row(row, 4)?),
                None => None,
            };
            Ok(ReceiverSummary {
                source_id: row.get(0)?,
                name: row.get(1)?,
                first_seen_ms: row.get(2)?,
                period_count: row.get(3)?,
                current,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// One receiver's location history, oldest first.
    pub fn receiver_locations_sync(
        &self,
        source_id: &str,
    ) -> Result<Vec<LocationPeriod>, StorageError> {
        let storage = lock(self)?;
        read_periods(&storage, source_id)
    }

    /// Where `source_id` was at `ts_ms`, if known.
    pub fn location_at_sync(
        &self,
        source_id: &str,
        ts_ms: i64,
    ) -> Result<Option<LocationPeriod>, StorageError> {
        let storage = lock(self)?;
        let mut stmt = storage.conn.prepare(&format!(
            "SELECT {PERIOD_COLUMNS} FROM receiver_locations
             WHERE source_id = ? AND valid_from_ms <= ?
               AND (valid_to_ms IS NULL OR ? < valid_to_ms)"
        ))?;
        let mut rows = stmt.query_map(params![source_id, ts_ms, ts_ms], |row| {
            period_from_row(row, 0)
        })?;
        Ok(rows.next().transpose()?)
    }

    /// Applies `change` to one receiver's history.
    ///
    /// Returns the new history, or `None` when the change was a no-op (and
    /// nothing was written). A refused change writes nothing.
    pub fn apply_receiver_change_sync(
        &self,
        source_id: &str,
        change: &LocationChange,
        stamp: &ChangeStamp,
    ) -> Result<Option<Vec<LocationPeriod>>, StorageError> {
        let storage = lock(self)?;
        apply_locked(&storage, source_id, change, stamp)
    }

    /// Records that `source_id` is at `position` as of `now_ms`, from its
    /// own configuration at startup.
    ///
    /// A receiver with no history yet whose fixes are already stored gets a
    /// first period stretched back to its oldest fix (origin `backfill`): the
    /// best available guess, and the only one that gives existing data a
    /// location at all. Correct it with a back-dated move if the receiver
    /// was elsewhere then. Otherwise this is a plain observation (origin
    /// `config`), a no-op when the position has not changed.
    pub fn bootstrap_receiver_location_sync(
        &self,
        source_id: &str,
        position: ReceiverPosition,
        now_ms: i64,
    ) -> Result<Option<Vec<LocationPeriod>>, StorageError> {
        let storage = lock(self)?;
        let (change, origin) = if read_periods(&storage, source_id)?.is_empty() {
            let oldest: Option<i64> = storage.conn.query_row(
                "SELECT MIN(timestamp_ms) FROM positions WHERE source_id = ?",
                params![source_id],
                |r| r.get(0),
            )?;
            match oldest {
                Some(at_ms) if at_ms < now_ms => (
                    LocationChange::Observe { position, at_ms },
                    LocationOrigin::Backfill,
                ),
                _ => (
                    LocationChange::Observe {
                        position,
                        at_ms: now_ms,
                    },
                    LocationOrigin::Config,
                ),
            }
        } else {
            (
                LocationChange::Observe {
                    position,
                    at_ms: now_ms,
                },
                LocationOrigin::Config,
            )
        };
        let stamp = ChangeStamp {
            origin,
            recorded_at_ms: now_ms,
            note: None,
        };
        apply_locked(&storage, source_id, &change, &stamp)
    }

    /// Copies receivers and location histories from the attached
    /// `import_db`. Returns the number of periods copied.
    ///
    /// A history is imported only for a receiver this database has none for:
    /// two histories of one receiver could overlap, and the table cannot
    /// refuse that by itself. Receivers merge, keeping the earliest sighting.
    pub(super) fn import_receivers(conn: &duckdb::Connection) -> Result<u64, StorageError> {
        let mut copied = 0;
        if Self::table_exists_in_schema(conn, "receiver_locations")? {
            copied = conn.execute(
                &format!(
                    "INSERT INTO receiver_locations (source_id, {PERIOD_COLUMNS})
                     SELECT il.source_id, {IMPORTED_PERIOD_COLUMNS}
                     FROM import_db.receiver_locations il
                     WHERE NOT EXISTS (
                         SELECT 1 FROM receiver_locations l
                         WHERE l.source_id = il.source_id
                     )"
                ),
                [],
            )? as u64;
        }
        if Self::table_exists_in_schema(conn, "receivers")? {
            conn.execute(
                "INSERT INTO receivers (source_id, name, first_seen_ms)
                 SELECT source_id, name, first_seen_ms FROM import_db.receivers
                 ON CONFLICT (source_id) DO UPDATE
                 SET first_seen_ms = LEAST(receivers.first_seen_ms, excluded.first_seen_ms)",
                [],
            )?;
        }
        Ok(copied)
    }

    // --- Async wrappers ---

    /// Records that `source_id` exists (async via spawn_blocking).
    pub async fn register_receiver(
        &self,
        source_id: String,
        seen_ms: i64,
    ) -> Result<(), StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.register_receiver_sync(&source_id, seen_ms))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Every known receiver (async via spawn_blocking).
    pub async fn list_receivers(&self) -> Result<Vec<ReceiverSummary>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.list_receivers_sync())
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// One receiver's history (async via spawn_blocking).
    pub async fn receiver_locations(
        &self,
        source_id: String,
    ) -> Result<Vec<LocationPeriod>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.receiver_locations_sync(&source_id))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Applies a location change (async via spawn_blocking).
    pub async fn apply_receiver_change(
        &self,
        source_id: String,
        change: LocationChange,
        stamp: ChangeStamp,
    ) -> Result<Option<Vec<LocationPeriod>>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || {
            handle.apply_receiver_change_sync(&source_id, &change, &stamp)
        })
        .await
        .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }
}

/// The columns [`period_from_row`] reads, in its order.
const PERIOD_COLUMNS: &str = "valid_from_ms, valid_to_ms, latitude, longitude, \
                              altitude_ft, origin, recorded_at_ms, note";

/// [`PERIOD_COLUMNS`] qualified with the `il` alias used by an import.
const IMPORTED_PERIOD_COLUMNS: &str = "il.valid_from_ms, il.valid_to_ms, il.latitude, \
                                       il.longitude, il.altitude_ft, il.origin, \
                                       il.recorded_at_ms, il.note";

fn lock(handle: &StorageHandle) -> Result<std::sync::MutexGuard<'_, Storage>, StorageError> {
    handle
        .inner
        .lock()
        .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))
}

/// Reads [`PERIOD_COLUMNS`] starting at column `at`.
fn period_from_row(row: &duckdb::Row<'_>, at: usize) -> duckdb::Result<LocationPeriod> {
    Ok(LocationPeriod {
        valid_from_ms: row.get(at)?,
        valid_to_ms: row.get(at + 1)?,
        position: ReceiverPosition {
            latitude: row.get(at + 2)?,
            longitude: row.get(at + 3)?,
            altitude_ft: row.get(at + 4)?,
        },
        origin: LocationOrigin::parse(&row.get::<_, String>(at + 5)?),
        recorded_at_ms: row.get(at + 6)?,
        note: row.get(at + 7)?,
    })
}

/// Applies `change` to one receiver's history, holding the storage lock.
fn apply_locked(
    storage: &Storage,
    source_id: &str,
    change: &LocationChange,
    stamp: &ChangeStamp,
) -> Result<Option<Vec<LocationPeriod>>, StorageError> {
    let current = read_periods(storage, source_id)?;
    let Some(next) = apply(&current, change, stamp)? else {
        return Ok(None);
    };

    // Swap the whole history: the pure layer has already checked it.
    let seen = next
        .first()
        .map_or(stamp.recorded_at_ms, |p| p.valid_from_ms);
    if storage.is_remote {
        run_on_daemon(storage, &swap_script(source_id, &next, seen))?;
        return Ok(Some(next));
    }
    storage.conn.execute_batch("BEGIN TRANSACTION")?;
    let written = replace_periods(storage, source_id, &next)
        .and_then(|()| register(storage, source_id, seen));
    match written {
        Ok(()) => storage.conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = storage.conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }
    Ok(Some(next))
}

fn read_periods(storage: &Storage, source_id: &str) -> Result<Vec<LocationPeriod>, StorageError> {
    let mut stmt = storage.conn.prepare(&format!(
        "SELECT {PERIOD_COLUMNS} FROM receiver_locations
         WHERE source_id = ? ORDER BY valid_from_ms"
    ))?;
    let rows = stmt.query_map(params![source_id], |row| period_from_row(row, 0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn replace_periods(
    storage: &Storage,
    source_id: &str,
    periods: &[LocationPeriod],
) -> Result<(), StorageError> {
    storage.conn.execute(
        "DELETE FROM receiver_locations WHERE source_id = ?",
        params![source_id],
    )?;
    let mut insert = storage.conn.prepare(&format!(
        "INSERT INTO receiver_locations (source_id, {PERIOD_COLUMNS}) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))?;
    for p in periods {
        insert.execute(params![
            source_id,
            p.valid_from_ms,
            p.valid_to_ms,
            p.position.latitude,
            p.position.longitude,
            p.position.altitude_ft,
            p.origin.as_str(),
            p.recorded_at_ms,
            p.note,
        ])?;
    }
    Ok(())
}

fn register(storage: &Storage, source_id: &str, seen_ms: i64) -> Result<(), StorageError> {
    let sql = register_sql(&sql_text(source_id), seen_ms);
    if storage.is_remote {
        return run_on_daemon(storage, &sql);
    }
    storage.conn.execute(&sql, [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::receiver_history::HistoryError;
    use crate::types::StorageConfig;

    const HOME: ReceiverPosition = ReceiverPosition {
        latitude: 46.7,
        longitude: -2.3,
        altitude_ft: Some(20.0),
    };
    const AWAY: ReceiverPosition = ReceiverPosition {
        latitude: 47.2,
        longitude: -1.5,
        altitude_ft: None,
    };

    fn open() -> StorageHandle {
        StorageHandle::open(StorageConfig {
            db_path: None,
            source_id: "rx-a".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
            remote: None,
        })
        .unwrap()
    }

    fn stamp(origin: LocationOrigin, at: i64) -> ChangeStamp {
        ChangeStamp {
            origin,
            recorded_at_ms: at,
            note: None,
        }
    }

    fn observe(h: &StorageHandle, id: &str, position: ReceiverPosition, at_ms: i64) {
        h.apply_receiver_change_sync(
            id,
            &LocationChange::Observe { position, at_ms },
            &stamp(LocationOrigin::Config, at_ms),
        )
        .unwrap();
    }

    #[test]
    fn an_empty_database_knows_no_receiver() {
        let h = open();
        assert!(h.list_receivers_sync().unwrap().is_empty());
        assert!(h.receiver_locations_sync("rx-a").unwrap().is_empty());
        assert_eq!(h.location_at_sync("rx-a", 0).unwrap(), None);
    }

    #[test]
    fn an_observation_is_stored_and_read_back() {
        let h = open();
        let out = h
            .apply_receiver_change_sync(
                "rx-a",
                &LocationChange::Observe {
                    position: HOME,
                    at_ms: 1_000,
                },
                &ChangeStamp {
                    origin: LocationOrigin::Config,
                    recorded_at_ms: 1_005,
                    note: Some("first light".into()),
                },
            )
            .unwrap()
            .unwrap();
        let stored = h.receiver_locations_sync("rx-a").unwrap();
        assert_eq!(stored, out);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].position, HOME);
        assert_eq!(stored[0].valid_to_ms, None);
        assert_eq!(stored[0].origin, LocationOrigin::Config);
        assert_eq!(stored[0].recorded_at_ms, 1_005);
        assert_eq!(stored[0].note.as_deref(), Some("first light"));
    }

    #[test]
    fn a_change_registers_the_receiver_with_its_current_location() {
        let h = open();
        observe(&h, "rx-a", HOME, 1_000);
        observe(&h, "rx-a", AWAY, 5_000);
        let receivers = h.list_receivers_sync().unwrap();
        assert_eq!(receivers.len(), 1);
        let rx = &receivers[0];
        assert_eq!(rx.source_id, "rx-a");
        assert_eq!(rx.first_seen_ms, 1_000);
        assert_eq!(rx.period_count, 2);
        assert_eq!(rx.current.as_ref().unwrap().position, AWAY);
    }

    #[test]
    fn location_at_honours_the_half_open_boundaries() {
        let h = open();
        observe(&h, "rx-a", HOME, 1_000);
        observe(&h, "rx-a", AWAY, 5_000);
        assert_eq!(h.location_at_sync("rx-a", 999).unwrap(), None);
        let at = |ts| h.location_at_sync("rx-a", ts).unwrap().unwrap().position;
        assert_eq!(at(1_000), HOME);
        assert_eq!(at(4_999), HOME);
        assert_eq!(at(5_000), AWAY);
        assert_eq!(at(i64::MAX), AWAY);
    }

    #[test]
    fn a_no_op_writes_nothing() {
        let h = open();
        observe(&h, "rx-a", HOME, 1_000);
        let out = h
            .apply_receiver_change_sync(
                "rx-a",
                &LocationChange::Observe {
                    position: HOME,
                    at_ms: 9_000,
                },
                &stamp(LocationOrigin::Mqtt, 9_000),
            )
            .unwrap();
        assert_eq!(out, None);
        let stored = h.receiver_locations_sync("rx-a").unwrap();
        assert_eq!(stored[0].recorded_at_ms, 1_000, "the row was not rewritten");
        assert_eq!(stored[0].origin, LocationOrigin::Config);
    }

    #[test]
    fn a_refused_change_leaves_the_history_untouched() {
        let h = open();
        observe(&h, "rx-a", HOME, 1_000);
        observe(&h, "rx-a", AWAY, 5_000);
        let before = h.receiver_locations_sync("rx-a").unwrap();
        let err = h
            .apply_receiver_change_sync(
                "rx-a",
                &LocationChange::Move {
                    position: HOME,
                    at_ms: 5_000,
                },
                &stamp(LocationOrigin::Cli, 9_000),
            )
            .unwrap_err();
        assert!(
            matches!(
                err,
                StorageError::History(HistoryError::PeriodStartsAt(5_000))
            ),
            "{err:?}"
        );
        assert_eq!(h.receiver_locations_sync("rx-a").unwrap(), before);
    }

    #[test]
    fn receivers_have_separate_histories() {
        let h = open();
        observe(&h, "rx-a", HOME, 1_000);
        observe(&h, "rx-b", AWAY, 2_000);
        h.apply_receiver_change_sync(
            "rx-b",
            &LocationChange::Remove {
                valid_from_ms: 2_000,
            },
            &stamp(LocationOrigin::Cli, 3_000),
        )
        .unwrap();
        assert_eq!(h.receiver_locations_sync("rx-a").unwrap().len(), 1);
        assert!(h.receiver_locations_sync("rx-b").unwrap().is_empty());
        let ids: Vec<_> = h
            .list_receivers_sync()
            .unwrap()
            .into_iter()
            .map(|r| (r.source_id, r.current.is_some()))
            .collect();
        assert_eq!(
            ids,
            vec![("rx-a".to_string(), true), ("rx-b".to_string(), false)],
            "a receiver stays known after its history is emptied"
        );
    }

    #[test]
    fn register_receiver_keeps_the_earliest_sighting() {
        let h = open();
        h.register_receiver_sync("rx-a", 5_000).unwrap();
        h.register_receiver_sync("rx-a", 9_000).unwrap();
        h.register_receiver_sync("rx-a", 2_000).unwrap();
        let rx = h.list_receivers_sync().unwrap();
        assert_eq!(rx.len(), 1);
        assert_eq!(rx[0].first_seen_ms, 2_000);
        assert_eq!(rx[0].current, None);
        assert_eq!(rx[0].period_count, 0);
    }

    #[test]
    fn the_history_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let config = StorageConfig {
            db_path: Some(dir.path().join("rx.db")),
            source_id: "rx-a".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
            remote: None,
        };
        {
            let h = StorageHandle::open(config.clone()).unwrap();
            observe(&h, "rx-a", HOME, 1_000);
        }
        let h = StorageHandle::open(config).unwrap();
        assert_eq!(h.receiver_locations_sync("rx-a").unwrap().len(), 1);
    }

    /// Stores a bare fix for `source_id` at `ts_ms`.
    fn fix(h: &StorageHandle, source_id: &str, ts_ms: i64) {
        let s = h.inner.lock().unwrap();
        s.conn
            .execute(
                "INSERT INTO positions (hex_ident, latitude, longitude, timestamp_ms, source_id)
                 VALUES ('ABC123', 46.8, -2.3, ?, ?)",
                params![ts_ms, source_id],
            )
            .unwrap();
    }

    #[test]
    fn bootstrap_without_data_starts_the_history_now() {
        let h = open();
        let out = h
            .bootstrap_receiver_location_sync("rx-a", HOME, 9_000)
            .unwrap()
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].valid_from_ms, 9_000);
        assert_eq!(out[0].origin, LocationOrigin::Config);
    }

    #[test]
    fn bootstrap_backfills_to_the_oldest_fix_of_that_receiver() {
        let h = open();
        fix(&h, "rx-a", 3_000);
        fix(&h, "rx-a", 4_000);
        fix(&h, "rx-other", 1_000);
        let out = h
            .bootstrap_receiver_location_sync("rx-a", HOME, 9_000)
            .unwrap()
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].valid_from_ms, 3_000,
            "its own oldest fix, not another's"
        );
        assert_eq!(out[0].origin, LocationOrigin::Backfill);
        assert_eq!(out[0].recorded_at_ms, 9_000);
    }

    #[test]
    fn bootstrap_with_an_unchanged_position_writes_nothing() {
        let h = open();
        h.bootstrap_receiver_location_sync("rx-a", HOME, 1_000)
            .unwrap();
        assert_eq!(
            h.bootstrap_receiver_location_sync("rx-a", HOME, 9_000)
                .unwrap(),
            None
        );
    }

    #[test]
    fn bootstrap_after_a_config_edit_opens_a_new_period() {
        let h = open();
        fix(&h, "rx-a", 500);
        h.bootstrap_receiver_location_sync("rx-a", HOME, 1_000)
            .unwrap();
        let out = h
            .bootstrap_receiver_location_sync("rx-a", AWAY, 9_000)
            .unwrap()
            .unwrap();
        let spans: Vec<_> = out
            .iter()
            .map(|p| (p.valid_from_ms, p.valid_to_ms, p.origin))
            .collect();
        assert_eq!(
            spans,
            vec![
                (500, Some(9_000), LocationOrigin::Backfill),
                (9_000, None, LocationOrigin::Config)
            ]
        );
    }

    fn exported(h: &StorageHandle) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.db");
        h.export_database_sync(&path).unwrap();
        (dir, path)
    }

    #[test]
    fn an_export_carries_receivers_and_their_history() {
        let h = open();
        observe(&h, "rx-a", HOME, 1_000);
        observe(&h, "rx-a", AWAY, 5_000);
        let (_dir, path) = exported(&h);
        let copy = duckdb::Connection::open(&path).unwrap();
        let n: i64 = copy
            .query_row("SELECT COUNT(*) FROM receiver_locations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
        let n: i64 = copy
            .query_row("SELECT COUNT(*) FROM receivers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn an_import_brings_the_history_of_a_receiver_this_database_lacks() {
        let source = open();
        observe(&source, "rx-b", HOME, 1_000);
        observe(&source, "rx-b", AWAY, 5_000);
        let (_dir, path) = exported(&source);

        let target = open();
        observe(&target, "rx-a", HOME, 2_000);
        target.import_database_sync(&path).unwrap();

        assert_eq!(target.receiver_locations_sync("rx-b").unwrap().len(), 2);
        assert_eq!(target.receiver_locations_sync("rx-a").unwrap().len(), 1);
        let ids: Vec<_> = target
            .list_receivers_sync()
            .unwrap()
            .into_iter()
            .map(|r| r.source_id)
            .collect();
        assert_eq!(ids, vec!["rx-a", "rx-b"]);
    }

    #[test]
    fn an_import_never_merges_into_an_existing_history() {
        // Two histories of the same receiver could overlap, and nothing in
        // the database would stop it. This database's own history wins.
        let source = open();
        observe(&source, "rx-a", AWAY, 500);
        let (_dir, path) = exported(&source);

        let target = open();
        observe(&target, "rx-a", HOME, 1_000);
        target.import_database_sync(&path).unwrap();
        target.import_database_sync(&path).unwrap();

        let history = target.receiver_locations_sync("rx-a").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].position, HOME);
        let rx = target.list_receivers_sync().unwrap();
        assert_eq!(
            rx[0].first_seen_ms, 500,
            "the earlier sighting still counts"
        );
    }

    #[test]
    fn the_remote_swap_is_one_transaction_with_quoted_literals() {
        let periods = vec![LocationPeriod {
            valid_from_ms: 1_000,
            valid_to_ms: None,
            position: HOME,
            origin: LocationOrigin::Desktop,
            recorded_at_ms: 2_000,
            note: Some("Bob's roof".into()),
        }];
        let script = swap_script("pi-'a", &periods, 1_000);
        assert!(script.starts_with("BEGIN TRANSACTION;"), "{script}");
        assert!(script.trim_end().ends_with("COMMIT;"), "{script}");
        assert!(script.contains("WHERE source_id = 'pi-''a'"), "{script}");
        assert!(script.contains("'Bob''s roof'"), "{script}");
        assert!(script.contains("46.7"), "{script}");
        assert!(script.contains("NULL"), "the open end: {script}");
        assert!(script.contains("ON CONFLICT (source_id)"), "{script}");
    }

    #[test]
    fn an_emptied_history_swaps_to_no_rows() {
        let script = swap_script("pi-a", &[], 5);
        assert!(
            !script.contains("INSERT INTO receiver_locations"),
            "{script}"
        );
        assert!(
            script.contains("DELETE FROM receiver_locations"),
            "{script}"
        );
    }
}
