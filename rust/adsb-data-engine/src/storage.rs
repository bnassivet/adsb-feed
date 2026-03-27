//! DuckDB storage backend for ADS-B position data.
//!
//! Provides a thread-safe `StorageHandle` that wraps a DuckDB connection
//! and exposes insert/query operations. Uses `spawn_blocking` for all
//! DuckDB operations since `duckdb::Connection` is not `Send`.

use crate::error::StorageError;
use crate::sbs_parser::AircraftPosition;
use crate::types::{
    AircraftSummary, BboxQuery, DetectionRangeQuery, DetectionRangeSector, FlightSummary,
    FlightSummaryQuery, HourlyHeatmapCell, HourlyHeatmapQuery, ImportPreview, ImportResult,
    PositionRecord, RawMessageQuery, RawSbsRecord, StorageConfig, StorageStats, TablePreview,
    TimeDistributionBucket, TimeDistributionMetric, TimeDistributionQuery, TrajectoryQuery,
};
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use duckdb::{params, Connection};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tracing::info;

/// Write Arrow RecordBatches to an IPC stream, returning the raw bytes.
fn write_arrow_ipc(batches: impl Iterator<Item = RecordBatch>) -> Result<Vec<u8>, StorageError> {
    let mut buf = Vec::new();
    let mut writer: Option<StreamWriter<&mut Vec<u8>>> = None;

    for batch in batches {
        if writer.is_none() {
            writer = Some(
                StreamWriter::try_new(&mut buf, &batch.schema())
                    .map_err(|e| StorageError::Query(format!("Arrow writer init: {e}")))?,
            );
        }
        writer
            .as_mut()
            .unwrap()
            .write(&batch)
            .map_err(|e| StorageError::Query(format!("Arrow write: {e}")))?;
    }

    if let Some(w) = writer.as_mut() {
        w.finish()
            .map_err(|e| StorageError::Query(format!("Arrow finish: {e}")))?;
    }

    Ok(buf)
}

/// Thread-safe DuckDB handle. Cloneable (Arc internals).
///
/// All public methods are synchronous (`_sync` suffix) at this layer.
/// Async wrappers using `spawn_blocking` are provided as convenience
/// methods without the suffix.
#[derive(Clone)]
pub struct StorageHandle {
    inner: Arc<Mutex<Storage>>,
}

/// Tracks the latest active flight per hex_ident for O(1) gap detection.
struct ActiveFlight {
    flight_id: String,
    flight_num: u32,
    last_seen_ms: i64,
}

struct Storage {
    conn: Connection,
    source_id: String,
    gap_threshold_ms: i64,
    /// In-memory index: hex_ident → latest flight. Rebuilt from DB on open().
    flight_tracker: HashMap<String, ActiveFlight>,
}

const SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS positions (
        hex_ident      TEXT    NOT NULL,
        callsign       TEXT,
        latitude       DOUBLE,
        longitude      DOUBLE,
        altitude       DOUBLE,
        ground_speed   DOUBLE,
        track          DOUBLE,
        vertical_rate  DOUBLE,
        squawk         TEXT,
        is_on_ground   BOOLEAN,
        timestamp_ms   BIGINT  NOT NULL,
        source_id      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_positions_ts ON positions (timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_positions_hex_ts ON positions (hex_ident, timestamp_ms);

    CREATE TABLE IF NOT EXISTS raw_messages (
        hex_ident         TEXT    NOT NULL,
        msg_type          TEXT,
        transmission_type INTEGER,
        timestamp_ms      BIGINT  NOT NULL,
        raw_message       TEXT    NOT NULL,
        source_id         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_raw_msgs_ts ON raw_messages (timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_raw_msgs_hex_ts ON raw_messages (hex_ident, timestamp_ms);

    CREATE TABLE IF NOT EXISTS flights (
        flight_id      TEXT    PRIMARY KEY,
        hex_ident      TEXT    NOT NULL,
        flight_num     INTEGER NOT NULL,
        callsign       TEXT,
        position_count INTEGER NOT NULL DEFAULT 0,
        first_seen_ms  BIGINT  NOT NULL,
        last_seen_ms   BIGINT  NOT NULL,
        min_altitude   DOUBLE,
        max_altitude   DOUBLE
    );

    CREATE INDEX IF NOT EXISTS idx_flights_hex ON flights (hex_ident);
    CREATE INDEX IF NOT EXISTS idx_flights_last_seen ON flights (last_seen_ms);
"#;

impl StorageHandle {
    /// Open or create a DuckDB database.
    ///
    /// If `config.db_path` is `None`, an in-memory database is created (useful for tests).
    /// If a file path is given, parent directories are created automatically.
    pub fn open(config: StorageConfig) -> Result<Self, StorageError> {
        let conn = match &config.db_path {
            Some(path) => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                Connection::open(path)?
            }
            None => Connection::open_in_memory()?,
        };

        conn.execute_batch(SCHEMA_SQL)?;

        info!(
            "Storage opened: {}",
            config
                .db_path
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| ":memory:".to_string())
        );

        let handle = Self {
            inner: Arc::new(Mutex::new(Storage {
                conn,
                source_id: config.source_id,
                gap_threshold_ms: config.gap_threshold_ms,
                flight_tracker: HashMap::new(),
            })),
        };

        // One-time migration: populate flights table from existing positions
        handle.bootstrap_flights_sync()?;
        // Rebuild in-memory tracker from flights table
        handle.rebuild_flight_tracker_sync()?;

        Ok(handle)
    }

    /// One-time migration: populate `flights` table from existing positions using
    /// window functions. Only runs if `flights` is empty and `positions` has data.
    fn bootstrap_flights_sync(&self) -> Result<(), StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let flight_count: i64 =
            storage
                .conn
                .query_row("SELECT COUNT(*) FROM flights", [], |row| row.get(0))?;
        let pos_count: i64 =
            storage
                .conn
                .query_row("SELECT COUNT(*) FROM positions", [], |row| row.get(0))?;

        if flight_count > 0 || pos_count == 0 {
            return Ok(());
        }

        let gap = storage.gap_threshold_ms;
        info!(
            "Bootstrapping flights table from {} existing positions...",
            pos_count
        );

        storage.conn.execute_batch(&format!(
            "INSERT INTO flights (flight_id, hex_ident, flight_num, callsign,
                                  position_count, first_seen_ms, last_seen_ms,
                                  min_altitude, max_altitude)
             WITH ordered AS (
                 SELECT hex_ident, callsign, altitude, timestamp_ms,
                        LAG(timestamp_ms) OVER (PARTITION BY hex_ident ORDER BY timestamp_ms) AS prev_ts
                 FROM positions
             ),
             segmented AS (
                 SELECT *,
                        SUM(CASE WHEN prev_ts IS NULL OR timestamp_ms - prev_ts > {gap} THEN 1 ELSE 0 END)
                            OVER (PARTITION BY hex_ident ORDER BY timestamp_ms) - 1 AS flight_num
                 FROM ordered
             )
             SELECT hex_ident || '_' || CAST(flight_num AS INTEGER),
                    hex_ident, CAST(flight_num AS INTEGER),
                    MAX(callsign), COUNT(*),
                    MIN(timestamp_ms), MAX(timestamp_ms),
                    MIN(altitude), MAX(altitude)
             FROM segmented
             GROUP BY hex_ident, flight_num"
        ))?;

        let bootstrapped: i64 =
            storage
                .conn
                .query_row("SELECT COUNT(*) FROM flights", [], |row| row.get(0))?;
        info!(
            "Bootstrapped {} flights from existing positions",
            bootstrapped
        );

        Ok(())
    }

    /// Rebuild the in-memory flight tracker from the `flights` table.
    /// Loads the latest flight per hex_ident so incremental updates resume correctly.
    fn rebuild_flight_tracker_sync(&self) -> Result<(), StorageError> {
        let mut storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        // Collect results first to avoid borrow conflict with flight_tracker mutation
        let entries: Vec<(String, String, u32, i64)> = {
            let mut stmt = storage.conn.prepare(
                "SELECT f.hex_ident, f.flight_id, f.flight_num, f.last_seen_ms
                 FROM flights f
                 INNER JOIN (
                     SELECT hex_ident, MAX(flight_num) AS max_num
                     FROM flights
                     GROUP BY hex_ident
                 ) latest ON f.hex_ident = latest.hex_ident AND f.flight_num = latest.max_num",
            )?;

            stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)? as u32,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
        };

        storage.flight_tracker.clear();
        for (hex_ident, flight_id, flight_num, last_seen_ms) in entries {
            storage.flight_tracker.insert(
                hex_ident,
                ActiveFlight {
                    flight_id,
                    flight_num,
                    last_seen_ms,
                },
            );
        }

        Ok(())
    }

    /// Batch insert parsed positions (synchronous).
    ///
    /// Converts `AircraftPosition.timestamp` (string) to epoch milliseconds using `tz`.
    /// Positions without lat/lon are still stored (partial updates are valid in SBS-1).
    pub fn insert_batch_sync(
        &self,
        positions: &[AircraftPosition],
        tz: &str,
    ) -> Result<(), StorageError> {
        if positions.is_empty() {
            return Ok(());
        }

        let mut storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        // Phase 1: Insert positions via appender (existing logic)
        // Collect (pos, timestamp_ms) for flight updates in phase 2
        let mut batch_with_ts: Vec<(&AircraftPosition, i64)> = Vec::with_capacity(positions.len());

        {
            let mut appender = storage.conn.appender("positions")?;

            for pos in positions {
                let timestamp_ms = parse_timestamp_to_ms(&pos.timestamp, tz);

                appender.append_row(params![
                    pos.hex_ident,
                    pos.callsign,
                    pos.latitude,
                    pos.longitude,
                    pos.altitude,
                    pos.ground_speed,
                    pos.track,
                    pos.vertical_rate,
                    pos.squawk,
                    pos.is_on_ground,
                    timestamp_ms,
                    storage.source_id,
                ])?;

                batch_with_ts.push((pos, timestamp_ms));
            }

            appender.flush()?;
        }
        // Appender dropped here — conn borrow released

        // Phase 2: Incrementally update flights table
        // Collect new flights (INSERTs) and aggregated updates per flight_id
        struct FlightInsert {
            flight_id: String,
            hex_ident: String,
            flight_num: u32,
            callsign: Option<String>,
            timestamp_ms: i64,
            altitude: Option<f64>,
        }
        struct AggregatedFlightUpdate {
            flight_id: String,
            position_count: u32,
            last_callsign: Option<String>,
            max_timestamp_ms: i64,
            min_altitude: Option<f64>,
            max_altitude: Option<f64>,
        }

        let mut inserts: Vec<FlightInsert> = Vec::new();
        // Aggregate updates per flight_id: O(unique_aircraft) entries instead of O(positions)
        let mut updates: HashMap<String, AggregatedFlightUpdate> = HashMap::new();
        let gap_threshold = storage.gap_threshold_ms;

        for (pos, ts_ms) in &batch_with_ts {
            let hex = &pos.hex_ident;

            match storage.flight_tracker.get(hex.as_str()) {
                Some(active) if (*ts_ms - active.last_seen_ms) <= gap_threshold => {
                    // Extend existing flight — aggregate into HashMap
                    updates
                        .entry(active.flight_id.clone())
                        .and_modify(|agg| {
                            agg.position_count += 1;
                            agg.max_timestamp_ms = agg.max_timestamp_ms.max(*ts_ms);
                            if let Some(alt) = pos.altitude {
                                agg.min_altitude =
                                    Some(agg.min_altitude.map_or(alt, |m: f64| m.min(alt)));
                                agg.max_altitude =
                                    Some(agg.max_altitude.map_or(alt, |m: f64| m.max(alt)));
                            }
                            if pos.callsign.is_some() {
                                agg.last_callsign.clone_from(&pos.callsign);
                            }
                        })
                        .or_insert(AggregatedFlightUpdate {
                            flight_id: active.flight_id.clone(),
                            position_count: 1,
                            last_callsign: pos.callsign.clone(),
                            max_timestamp_ms: *ts_ms,
                            min_altitude: pos.altitude,
                            max_altitude: pos.altitude,
                        });
                    // Update tracker in-place
                    let active_mut = storage.flight_tracker.get_mut(hex.as_str()).unwrap();
                    active_mut.last_seen_ms = *ts_ms;
                }
                _ => {
                    // Gap exceeded or first time seeing this hex → new flight
                    let flight_num = match storage.flight_tracker.get(hex.as_str()) {
                        Some(active) => active.flight_num + 1,
                        None => 0,
                    };
                    let flight_id = format!("{}_{}", hex, flight_num);

                    inserts.push(FlightInsert {
                        flight_id: flight_id.clone(),
                        hex_ident: hex.clone(),
                        flight_num,
                        callsign: pos.callsign.clone(),
                        timestamp_ms: *ts_ms,
                        altitude: pos.altitude,
                    });

                    // Update tracker
                    storage.flight_tracker.insert(
                        hex.clone(),
                        ActiveFlight {
                            flight_id,
                            flight_num,
                            last_seen_ms: *ts_ms,
                        },
                    );
                }
            }
        }

        // Execute INSERTs for new flights
        if !inserts.is_empty() {
            let mut insert_stmt = storage.conn.prepare(
                "INSERT INTO flights (flight_id, hex_ident, flight_num, callsign,
                                      position_count, first_seen_ms, last_seen_ms,
                                      min_altitude, max_altitude)
                 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
            )?;
            for ins in &inserts {
                insert_stmt.execute(params![
                    ins.flight_id,
                    ins.hex_ident,
                    ins.flight_num,
                    ins.callsign,
                    ins.timestamp_ms,
                    ins.timestamp_ms,
                    ins.altitude,
                    ins.altitude,
                ])?;
            }
        }

        // Execute aggregated UPDATEs — one per flight_id instead of one per position
        if !updates.is_empty() {
            let mut update_stmt = storage.conn.prepare(
                "UPDATE flights SET
                    last_seen_ms = GREATEST(last_seen_ms, ?),
                    position_count = position_count + ?,
                    callsign = COALESCE(?, callsign),
                    min_altitude = LEAST(COALESCE(min_altitude, ?), COALESCE(?, min_altitude)),
                    max_altitude = GREATEST(COALESCE(max_altitude, ?), COALESCE(?, max_altitude))
                 WHERE flight_id = ?",
            )?;
            for upd in updates.values() {
                update_stmt.execute(params![
                    upd.max_timestamp_ms,
                    upd.position_count,
                    upd.last_callsign,
                    upd.min_altitude,
                    upd.min_altitude,
                    upd.max_altitude,
                    upd.max_altitude,
                    upd.flight_id,
                ])?;
            }
        }

        Ok(())
    }

    /// Query positions within a bounding box and optional time window (synchronous).
    ///
    /// Results are sorted by (hex_ident, timestamp_ms).
    pub fn query_bbox_sync(&self, query: BboxQuery) -> Result<Vec<PositionRecord>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut sql = String::from(
            "SELECT hex_ident, callsign, latitude, longitude, altitude,
                    ground_speed, track, vertical_rate, squawk, is_on_ground, timestamp_ms
             FROM positions
             WHERE latitude BETWEEN ? AND ?
               AND longitude BETWEEN ? AND ?
               AND latitude IS NOT NULL
               AND longitude IS NOT NULL",
        );

        if query.start_ms.is_some() {
            sql.push_str(" AND timestamp_ms >= ?");
        }
        if query.end_ms.is_some() {
            sql.push_str(" AND timestamp_ms <= ?");
        }

        sql.push_str(" ORDER BY hex_ident, timestamp_ms LIMIT ?");

        let mut stmt = storage.conn.prepare(&sql)?;

        // Build parameter list dynamically
        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = vec![
            Box::new(query.south),
            Box::new(query.north),
            Box::new(query.west),
            Box::new(query.east),
        ];

        if let Some(start) = query.start_ms {
            params_vec.push(Box::new(start));
        }
        if let Some(end) = query.end_ms {
            params_vec.push(Box::new(end));
        }
        params_vec.push(Box::new(query.limit as i64));

        let params_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(PositionRecord {
                    hex_ident: row.get(0)?,
                    callsign: row.get(1)?,
                    latitude: row.get(2)?,
                    longitude: row.get(3)?,
                    altitude: row.get(4)?,
                    ground_speed: row.get(5)?,
                    track: row.get(6)?,
                    vertical_rate: row.get(7)?,
                    squawk: row.get(8)?,
                    is_on_ground: row.get(9)?,
                    timestamp_ms: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// Query positions in a bounding box as Arrow IPC bytes (synchronous).
    pub fn query_bbox_arrow_sync(&self, query: BboxQuery) -> Result<Vec<u8>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut sql = String::from(
            "SELECT hex_ident, callsign, latitude, longitude, altitude,
                    ground_speed, track, vertical_rate, squawk, is_on_ground, timestamp_ms
             FROM positions
             WHERE latitude BETWEEN ? AND ?
               AND longitude BETWEEN ? AND ?
               AND latitude IS NOT NULL
               AND longitude IS NOT NULL",
        );

        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = vec![
            Box::new(query.south),
            Box::new(query.north),
            Box::new(query.west),
            Box::new(query.east),
        ];

        if let Some(start) = query.start_ms {
            sql.push_str(" AND timestamp_ms >= ?");
            params_vec.push(Box::new(start));
        }
        if let Some(end) = query.end_ms {
            sql.push_str(" AND timestamp_ms <= ?");
            params_vec.push(Box::new(end));
        }

        sql.push_str(" ORDER BY hex_ident, timestamp_ms LIMIT ?");
        params_vec.push(Box::new(query.limit as i64));

        let mut stmt = storage.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let arrow_result = stmt.query_arrow(params_refs.as_slice())?;
        write_arrow_ipc(arrow_result)
    }

    /// Get trajectory for a single aircraft (synchronous).
    ///
    /// Returns positions sorted by timestamp_ms.
    pub fn get_trajectory_sync(
        &self,
        query: TrajectoryQuery,
    ) -> Result<Vec<PositionRecord>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut sql = String::from(
            "SELECT hex_ident, callsign, latitude, longitude, altitude,
                    ground_speed, track, vertical_rate, squawk, is_on_ground, timestamp_ms
             FROM positions
             WHERE hex_ident = ?
               AND latitude IS NOT NULL
               AND longitude IS NOT NULL",
        );

        if query.start_ms.is_some() {
            sql.push_str(" AND timestamp_ms >= ?");
        }
        if query.end_ms.is_some() {
            sql.push_str(" AND timestamp_ms <= ?");
        }

        sql.push_str(" ORDER BY timestamp_ms");

        let mut stmt = storage.conn.prepare(&sql)?;

        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = vec![Box::new(query.hex_ident)];

        if let Some(start) = query.start_ms {
            params_vec.push(Box::new(start));
        }
        if let Some(end) = query.end_ms {
            params_vec.push(Box::new(end));
        }

        let params_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(PositionRecord {
                    hex_ident: row.get(0)?,
                    callsign: row.get(1)?,
                    latitude: row.get(2)?,
                    longitude: row.get(3)?,
                    altitude: row.get(4)?,
                    ground_speed: row.get(5)?,
                    track: row.get(6)?,
                    vertical_rate: row.get(7)?,
                    squawk: row.get(8)?,
                    is_on_ground: row.get(9)?,
                    timestamp_ms: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// Batch-fetch trajectories as Arrow IPC bytes (synchronous).
    ///
    /// Acquires the DuckDB Mutex once for all queries. Each query's results
    /// are tagged with a `flight_id` column so the caller can partition them.
    /// Returns Arrow IPC stream format bytes.
    pub fn get_trajectories_batch_arrow_sync(
        &self,
        queries: &[(TrajectoryQuery, String)], // (query, flight_id)
    ) -> Result<Vec<u8>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut buf = Vec::new();
        let mut writer: Option<StreamWriter<&mut Vec<u8>>> = None;
        let mut extended_schema_ref: Option<Arc<arrow::datatypes::Schema>> = None;

        for (query, flight_id) in queries {
            let mut sql = String::from(
                "SELECT hex_ident, callsign, latitude, longitude, altitude,
                        ground_speed, track, vertical_rate, squawk, is_on_ground, timestamp_ms
                 FROM positions
                 WHERE hex_ident = ?
                   AND latitude IS NOT NULL
                   AND longitude IS NOT NULL",
            );

            if query.start_ms.is_some() {
                sql.push_str(" AND timestamp_ms >= ?");
            }
            if query.end_ms.is_some() {
                sql.push_str(" AND timestamp_ms <= ?");
            }
            sql.push_str(" ORDER BY timestamp_ms");

            let mut stmt = storage.conn.prepare(&sql)?;

            let mut params_vec: Vec<Box<dyn duckdb::ToSql>> =
                vec![Box::new(query.hex_ident.clone())];
            if let Some(start) = query.start_ms {
                params_vec.push(Box::new(start));
            }
            if let Some(end) = query.end_ms {
                params_vec.push(Box::new(end));
            }
            let params_refs: Vec<&dyn duckdb::ToSql> =
                params_vec.iter().map(|p| p.as_ref()).collect();

            let arrow_result = stmt.query_arrow(params_refs.as_slice())?;
            let query_schema = arrow_result.get_schema();

            // Build extended schema with flight_id column on first batch
            if writer.is_none() {
                use arrow::datatypes::{DataType, Field, Schema};

                let mut fields = query_schema.fields().to_vec();
                fields.push(Arc::new(Field::new("flight_id", DataType::Utf8, false)));
                let schema = Arc::new(Schema::new(fields));
                extended_schema_ref = Some(schema.clone());

                writer = Some(
                    StreamWriter::try_new(&mut buf, &schema)
                        .map_err(|e| StorageError::Query(format!("Arrow writer init: {e}")))?,
                );
            }

            let w = writer.as_mut().unwrap();
            let schema = extended_schema_ref.as_ref().unwrap();

            for batch in arrow_result {
                use arrow::array::StringArray;
                use arrow::record_batch::RecordBatch;

                // Add flight_id column to this batch
                let flight_id_col = StringArray::from(vec![flight_id.as_str(); batch.num_rows()]);
                let mut columns: Vec<Arc<dyn arrow::array::Array>> = batch.columns().to_vec();
                columns.push(Arc::new(flight_id_col));

                let extended_batch = RecordBatch::try_new(schema.clone(), columns)
                    .map_err(|e| StorageError::Query(format!("Arrow batch extend: {e}")))?;

                w.write(&extended_batch)
                    .map_err(|e| StorageError::Query(format!("Arrow write: {e}")))?;
            }
        }

        if let Some(w) = writer.as_mut() {
            w.finish()
                .map_err(|e| StorageError::Query(format!("Arrow finish: {e}")))?;
        }

        Ok(buf)
    }

    /// Get summary of distinct aircraft in a time window (synchronous).
    pub fn get_aircraft_summary_sync(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<Vec<AircraftSummary>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut sql = String::from(
            "SELECT hex_ident,
                    MAX(callsign) AS callsign,
                    COUNT(*) AS position_count,
                    MIN(timestamp_ms) AS first_seen_ms,
                    MAX(timestamp_ms) AS last_seen_ms,
                    MIN(altitude) AS min_altitude,
                    MAX(altitude) AS max_altitude
             FROM positions",
        );

        let mut conditions = Vec::new();
        if start_ms.is_some() {
            conditions.push("timestamp_ms >= ?");
        }
        if end_ms.is_some() {
            conditions.push("timestamp_ms <= ?");
        }

        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        sql.push_str(" GROUP BY hex_ident ORDER BY last_seen_ms DESC");

        let mut stmt = storage.conn.prepare(&sql)?;

        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        if let Some(start) = start_ms {
            params_vec.push(Box::new(start));
        }
        if let Some(end) = end_ms {
            params_vec.push(Box::new(end));
        }

        let params_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(AircraftSummary {
                    hex_ident: row.get(0)?,
                    callsign: row.get(1)?,
                    position_count: row.get::<_, i64>(2)? as u64,
                    first_seen_ms: row.get(3)?,
                    last_seen_ms: row.get(4)?,
                    min_altitude: row.get(5)?,
                    max_altitude: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// Get flight-segmented summaries (synchronous).
    ///
    /// Reads from the pre-computed `flights` table. Flights are maintained
    /// incrementally by `insert_batch_sync` — this is a simple indexed SELECT.
    pub fn get_flight_summary_sync(
        &self,
        query: &FlightSummaryQuery,
    ) -> Result<Vec<FlightSummary>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut sql = String::from(
            "SELECT hex_ident, flight_num, flight_id, callsign,
                    position_count, first_seen_ms, last_seen_ms,
                    min_altitude, max_altitude
             FROM flights",
        );

        let mut conditions = Vec::new();
        if query.start_ms.is_some() {
            // Include flights that overlap the query window
            conditions.push("last_seen_ms >= ?");
        }
        if query.end_ms.is_some() {
            conditions.push("first_seen_ms <= ?");
        }

        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        sql.push_str(" ORDER BY last_seen_ms DESC");

        let mut stmt = storage.conn.prepare(&sql)?;

        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        if let Some(start) = query.start_ms {
            params_vec.push(Box::new(start));
        }
        if let Some(end) = query.end_ms {
            params_vec.push(Box::new(end));
        }

        let params_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(FlightSummary {
                    hex_ident: row.get(0)?,
                    flight_num: row.get::<_, i32>(1)? as u32,
                    flight_id: row.get(2)?,
                    callsign: row.get(3)?,
                    position_count: row.get::<_, i64>(4)? as u64,
                    first_seen_ms: row.get(5)?,
                    last_seen_ms: row.get(6)?,
                    min_altitude: row.get(7)?,
                    max_altitude: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// Get flight summaries as Arrow IPC bytes (synchronous).
    pub fn get_flight_summary_arrow_sync(
        &self,
        query: &FlightSummaryQuery,
    ) -> Result<Vec<u8>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut sql = String::from(
            "SELECT hex_ident, flight_num, flight_id, callsign,
                    position_count, first_seen_ms, last_seen_ms,
                    min_altitude, max_altitude
             FROM flights",
        );

        let mut conditions = Vec::new();
        if query.start_ms.is_some() {
            conditions.push("last_seen_ms >= ?");
        }
        if query.end_ms.is_some() {
            conditions.push("first_seen_ms <= ?");
        }

        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        sql.push_str(" ORDER BY last_seen_ms DESC");

        let mut stmt = storage.conn.prepare(&sql)?;

        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        if let Some(start) = query.start_ms {
            params_vec.push(Box::new(start));
        }
        if let Some(end) = query.end_ms {
            params_vec.push(Box::new(end));
        }

        let params_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let arrow_result = stmt.query_arrow(params_refs.as_slice())?;
        write_arrow_ipc(arrow_result)
    }

    /// Get storage statistics (synchronous).
    pub fn get_stats_sync(&self) -> Result<StorageStats, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let row_count: i64 =
            storage
                .conn
                .query_row("SELECT COUNT(*) FROM positions", [], |row| row.get(0))?;

        let oldest: Option<i64> =
            storage
                .conn
                .query_row("SELECT MIN(timestamp_ms) FROM positions", [], |row| {
                    row.get(0)
                })?;

        let newest: Option<i64> =
            storage
                .conn
                .query_row("SELECT MAX(timestamp_ms) FROM positions", [], |row| {
                    row.get(0)
                })?;

        let raw_count: i64 =
            storage
                .conn
                .query_row("SELECT COUNT(*) FROM raw_messages", [], |row| row.get(0))?;

        // DuckDB database_size() returns a human-readable string for file-backed DBs.
        // For in-memory DBs it returns '0 bytes'. We approximate with row count * avg row size.
        let positions_size = (row_count as u64).saturating_mul(128);
        let raw_size = (raw_count as u64).saturating_mul(200); // ~200 bytes per raw row estimate

        Ok(StorageStats {
            row_count: row_count as u64,
            db_size_bytes: positions_size + raw_size,
            oldest_timestamp_ms: oldest,
            newest_timestamp_ms: newest,
            raw_message_count: raw_count as u64,
            raw_db_size_bytes: raw_size,
        })
    }

    /// Delete positions older than the given epoch milliseconds (synchronous).
    ///
    /// Returns the number of deleted rows.
    pub fn prune_sync(&self, older_than_ms: i64) -> Result<u64, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let deleted = storage.conn.execute(
            "DELETE FROM positions WHERE timestamp_ms < ?",
            params![older_than_ms],
        )?;

        let raw_deleted = storage.conn.execute(
            "DELETE FROM raw_messages WHERE timestamp_ms < ?",
            params![older_than_ms],
        )?;

        info!(
            "Pruned {deleted} positions and {raw_deleted} raw messages older than {older_than_ms}"
        );
        Ok(deleted as u64)
    }

    /// Get time distribution as bucketed histogram (synchronous).
    ///
    /// Divides the `[start_ms, end_ms]` range into `num_buckets` equal-width buckets
    /// and returns the count per bucket. The `metric` field selects what to count:
    /// - `Positions`: number of position rows
    /// - `Aircraft`: number of distinct aircraft (hex_ident)
    /// - `RawMessages`: number of raw SBS-1 messages
    pub fn get_time_distribution_sync(
        &self,
        query: TimeDistributionQuery,
    ) -> Result<Vec<TimeDistributionBucket>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let range = query.end_ms - query.start_ms;
        let bucket_width = if query.num_buckets == 0 || range <= 0 {
            return Ok(Vec::new());
        } else {
            range / query.num_buckets as i64
        };
        if bucket_width == 0 {
            return Ok(Vec::new());
        }

        let sql = match query.metric {
            TimeDistributionMetric::Positions => {
                "SELECT CAST(timestamp_ms / ? AS BIGINT) * ? AS bucket_ms, COUNT(*) AS count
                 FROM positions
                 WHERE timestamp_ms BETWEEN ? AND ?
                 GROUP BY bucket_ms
                 ORDER BY bucket_ms"
            }
            TimeDistributionMetric::Aircraft => {
                "SELECT CAST(timestamp_ms / ? AS BIGINT) * ? AS bucket_ms, COUNT(DISTINCT hex_ident) AS count
                 FROM positions
                 WHERE timestamp_ms BETWEEN ? AND ?
                 GROUP BY bucket_ms
                 ORDER BY bucket_ms"
            }
            TimeDistributionMetric::RawMessages => {
                "SELECT CAST(timestamp_ms / ? AS BIGINT) * ? AS bucket_ms, COUNT(*) AS count
                 FROM raw_messages
                 WHERE timestamp_ms BETWEEN ? AND ?
                 GROUP BY bucket_ms
                 ORDER BY bucket_ms"
            }
            TimeDistributionMetric::Flights => {
                // bucket_width is safe to embed: computed from query range / num_buckets
                &format!(
                    "SELECT bucket_ms, COUNT(*) AS count
                     FROM (
                         SELECT UNNEST(generate_series(
                             (first_seen_ms // {bw}) * {bw},
                             (last_seen_ms  // {bw}) * {bw},
                             CAST({bw} AS BIGINT)
                         )) AS bucket_ms
                         FROM flights
                         WHERE last_seen_ms >= ? AND first_seen_ms <= ?
                     ) expanded
                     WHERE bucket_ms BETWEEN ? AND ?
                     GROUP BY bucket_ms
                     ORDER BY bucket_ms",
                    bw = bucket_width
                )
            }
        };

        let row_mapper = |row: &duckdb::Row| {
            Ok(TimeDistributionBucket {
                bucket_ms: row.get(0)?,
                count: row.get::<_, i64>(1)? as u64,
            })
        };

        let mut stmt = storage.conn.prepare(sql)?;
        let rows = if matches!(query.metric, TimeDistributionMetric::Flights) {
            stmt.query_map(
                params![query.start_ms, query.end_ms, query.start_ms, query.end_ms],
                row_mapper,
            )?
            .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map(
                params![bucket_width, bucket_width, query.start_ms, query.end_ms],
                row_mapper,
            )?
            .collect::<Result<Vec<_>, _>>()?
        };

        Ok(rows)
    }

    /// Compute detection range by 10° azimuth sectors (synchronous).
    ///
    /// All trig math runs inside DuckDB's vectorized engine. Only ≤36 result
    /// rows cross the Mutex boundary regardless of dataset size.
    /// Always returns exactly 36 sectors (filling missing ones with zero).
    pub fn get_detection_range_sync(
        &self,
        query: DetectionRangeQuery,
    ) -> Result<Vec<DetectionRangeSector>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let sql = r#"
            SELECT sector, MAX(distance_nm) AS max_distance_nm, COUNT(*) AS position_count,
                   MIN(altitude) AS min_altitude, MAX(altitude) AS max_altitude,
                   COUNT(DISTINCT flight_id) AS flight_count
            FROM (
              SELECT
                CAST(FLOOR(DEGREES(ATAN2(
                  SIN(RADIANS(p.longitude - ?)) * COS(RADIANS(p.latitude)),
                  COS(RADIANS(?)) * SIN(RADIANS(p.latitude))
                    - SIN(RADIANS(?)) * COS(RADIANS(p.latitude)) * COS(RADIANS(p.longitude - ?))
                )) + 365) AS INTEGER) % 360 / 10 AS sector,
                2 * 3440.065 * ASIN(SQRT(
                  POWER(SIN(RADIANS((p.latitude - ?) / 2)), 2) +
                  COS(RADIANS(?)) * COS(RADIANS(p.latitude)) * POWER(SIN(RADIANS((p.longitude - ?) / 2)), 2)
                )) AS distance_nm,
                p.altitude,
                f.flight_id
              FROM positions p
              LEFT JOIN flights f ON p.hex_ident = f.hex_ident
                AND p.timestamp_ms BETWEEN f.first_seen_ms AND f.last_seen_ms
              WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
                AND p.timestamp_ms >= ? AND p.timestamp_ms <= ?
            ) sub GROUP BY sector ORDER BY sector
        "#;

        let start_ms = query.start_ms.unwrap_or(0);
        let end_ms = query.end_ms.unwrap_or(i64::MAX);

        let mut stmt = storage.conn.prepare(sql)?;
        let rows = stmt
            .query_map(
                params![
                    query.receiver_lon, // bearing: longitude - ?
                    query.receiver_lat, // bearing: COS(RADIANS(?))
                    query.receiver_lat, // bearing: SIN(RADIANS(?))
                    query.receiver_lon, // bearing: COS(RADIANS(longitude - ?))
                    query.receiver_lat, // haversine: (latitude - ?) / 2
                    query.receiver_lat, // haversine: COS(RADIANS(?))
                    query.receiver_lon, // haversine: (longitude - ?) / 2
                    start_ms,
                    end_ms,
                ],
                |row| {
                    let sector: i32 = row.get(0)?;
                    let max_distance_nm: f64 = row.get(1)?;
                    let position_count: i64 = row.get(2)?;
                    let min_altitude: Option<f64> = row.get(3)?;
                    let max_altitude: Option<f64> = row.get(4)?;
                    let flight_count: i64 = row.get(5)?;
                    Ok((
                        sector,
                        max_distance_nm,
                        position_count,
                        min_altitude,
                        max_altitude,
                        flight_count,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        // Build full 36-sector result, filling missing sectors with zero.
        let mut sectors: Vec<DetectionRangeSector> = (0..36)
            .map(|i| DetectionRangeSector {
                bearing_deg: (i * 10) as u16,
                max_distance_nm: 0.0,
                position_count: 0,
                min_altitude: None,
                max_altitude: None,
                flight_count: 0,
            })
            .collect();

        for (sector_idx, max_dist, count, min_alt, max_alt, fl_count) in rows {
            if (0..36).contains(&sector_idx) {
                let s = &mut sectors[sector_idx as usize];
                s.max_distance_nm = max_dist;
                s.position_count = count as u64;
                s.min_altitude = min_alt;
                s.max_altitude = max_alt;
                s.flight_count = fl_count as u64;
            }
        }

        Ok(sectors)
    }

    /// Get hourly activity heatmap grouped by (date, hour) (synchronous).
    ///
    /// Returns one cell per (day, hour) pair that has data. `day_ms` is the
    /// midnight UTC epoch of each calendar day. The caller is responsible for
    /// zero-filling missing cells on the frontend.
    pub fn get_hourly_heatmap_sync(
        &self,
        query: HourlyHeatmapQuery,
    ) -> Result<Vec<HourlyHeatmapCell>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let sql = r#"
            WITH pos AS (
                SELECT
                    CAST(epoch_ms(CAST(epoch_ms(timestamp_ms) AS DATE)) AS BIGINT) AS day_ms,
                    EXTRACT(HOUR FROM epoch_ms(timestamp_ms)) AS hour,
                    COUNT(DISTINCT hex_ident) AS aircraft_count,
                    COUNT(*) AS message_count
                FROM positions
                WHERE timestamp_ms BETWEEN ? AND ?
                GROUP BY day_ms, hour
            ),
            raw AS (
                SELECT
                    CAST(epoch_ms(CAST(epoch_ms(timestamp_ms) AS DATE)) AS BIGINT) AS day_ms,
                    EXTRACT(HOUR FROM epoch_ms(timestamp_ms)) AS hour,
                    COUNT(*) AS raw_message_count
                FROM raw_messages
                WHERE timestamp_ms BETWEEN ? AND ?
                GROUP BY day_ms, hour
            ),
            fl AS (
                SELECT day_ms, hour, COUNT(*) AS flight_count
                FROM (
                    SELECT
                        CAST(epoch_ms(CAST(epoch_ms(h.hr_ts) AS DATE)) AS BIGINT) AS day_ms,
                        EXTRACT(HOUR FROM epoch_ms(h.hr_ts)) AS hour
                    FROM flights f,
                    LATERAL (
                        SELECT UNNEST(generate_series(
                            (f.first_seen_ms // 3600000) * 3600000,
                            (f.last_seen_ms  // 3600000) * 3600000,
                            CAST(3600000 AS BIGINT)
                        )) AS hr_ts
                    ) h
                    WHERE f.last_seen_ms >= ? AND f.first_seen_ms <= ?
                ) expanded
                GROUP BY day_ms, hour
            ),
            pos_raw AS (
                SELECT
                    COALESCE(pos.day_ms, raw.day_ms) AS day_ms,
                    COALESCE(pos.hour, raw.hour) AS hour,
                    COALESCE(pos.aircraft_count, 0) AS aircraft_count,
                    COALESCE(pos.message_count, 0) AS message_count,
                    COALESCE(raw.raw_message_count, 0) AS raw_message_count
                FROM pos
                FULL OUTER JOIN raw ON pos.day_ms = raw.day_ms AND pos.hour = raw.hour
            )
            SELECT
                COALESCE(pos_raw.day_ms, fl.day_ms) AS day_ms,
                COALESCE(pos_raw.hour, fl.hour) AS hour,
                COALESCE(pos_raw.aircraft_count, 0) AS aircraft_count,
                COALESCE(pos_raw.message_count, 0) AS message_count,
                COALESCE(pos_raw.raw_message_count, 0) AS raw_message_count,
                COALESCE(fl.flight_count, 0) AS flight_count
            FROM pos_raw
            FULL OUTER JOIN fl ON pos_raw.day_ms = fl.day_ms AND pos_raw.hour = fl.hour
            ORDER BY day_ms, hour
        "#;

        let mut stmt = storage.conn.prepare(sql)?;
        let rows = stmt
            .query_map(
                params![query.start_ms, query.end_ms, query.start_ms, query.end_ms, query.start_ms, query.end_ms],
                |row| {
                    Ok(HourlyHeatmapCell {
                        day_ms: row.get(0)?,
                        hour: row.get::<_, i32>(1)? as u8,
                        aircraft_count: row.get::<_, i64>(2)? as u64,
                        message_count: row.get::<_, i64>(3)? as u64,
                        raw_message_count: row.get::<_, i64>(4)? as u64,
                        flight_count: row.get::<_, i64>(5)? as u64,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// Batch insert raw SBS messages (synchronous).
    ///
    /// Converts `RawSbsRecord.timestamp` (string) to epoch milliseconds using `tz`.
    /// The `source_id` is taken from the storage config, not the record.
    pub fn insert_raw_batch_sync(
        &self,
        records: &[RawSbsRecord],
        tz: &str,
    ) -> Result<(), StorageError> {
        if records.is_empty() {
            return Ok(());
        }

        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut appender = storage.conn.appender("raw_messages")?;

        for rec in records {
            let timestamp_ms = parse_timestamp_to_ms(&rec.timestamp, tz);

            appender.append_row(params![
                rec.hex_ident,
                rec.msg_type,
                rec.transmission_type.map(|t| t as i32),
                timestamp_ms,
                rec.raw_message,
                storage.source_id,
            ])?;
        }

        appender.flush()?;
        Ok(())
    }

    /// Query raw messages by hex_ident and time range (synchronous).
    pub fn query_raw_messages_sync(
        &self,
        query: RawMessageQuery,
    ) -> Result<Vec<RawSbsRecord>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let sql = "SELECT hex_ident, msg_type, transmission_type, timestamp_ms,
                          raw_message, source_id
                   FROM raw_messages
                   WHERE hex_ident = ? AND timestamp_ms BETWEEN ? AND ?
                   ORDER BY timestamp_ms
                   LIMIT 10000";

        let mut stmt = storage.conn.prepare(sql)?;
        let rows = stmt
            .query_map(
                params![query.hex_ident, query.start_ms, query.end_ms],
                |row| {
                    let trans_type: Option<i32> = row.get(2)?;
                    Ok(RawSbsRecord {
                        hex_ident: row.get(0)?,
                        msg_type: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        transmission_type: trans_type.map(|t| t as u8),
                        timestamp: String::new(),
                        timestamp_ms: row.get(3)?,
                        raw_message: row.get(4)?,
                        source_id: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    /// Query raw SBS messages as Arrow IPC bytes (synchronous).
    pub fn query_raw_messages_arrow_sync(
        &self,
        query: RawMessageQuery,
    ) -> Result<Vec<u8>, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let sql = "SELECT hex_ident, msg_type, transmission_type, timestamp_ms,
                          raw_message, source_id
                   FROM raw_messages
                   WHERE hex_ident = ? AND timestamp_ms BETWEEN ? AND ?
                   ORDER BY timestamp_ms
                   LIMIT 10000";

        let mut stmt = storage.conn.prepare(sql)?;
        let params: Vec<Box<dyn duckdb::ToSql>> = vec![
            Box::new(query.hex_ident),
            Box::new(query.start_ms),
            Box::new(query.end_ms),
        ];
        let params_refs: Vec<&dyn duckdb::ToSql> = params.iter().map(|p| p.as_ref()).collect();

        let arrow_result = stmt.query_arrow(params_refs.as_slice())?;
        write_arrow_ipc(arrow_result)
    }

    /// Count raw messages, optionally filtered by time range (synchronous).
    pub fn get_raw_message_count_sync(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<u64, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let mut sql = String::from("SELECT COUNT(*) FROM raw_messages");
        let mut conditions = Vec::new();
        if start_ms.is_some() {
            conditions.push("timestamp_ms >= ?");
        }
        if end_ms.is_some() {
            conditions.push("timestamp_ms <= ?");
        }
        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        let mut stmt = storage.conn.prepare(&sql)?;
        let mut params_vec: Vec<Box<dyn duckdb::ToSql>> = Vec::new();
        if let Some(s) = start_ms {
            params_vec.push(Box::new(s));
        }
        if let Some(e) = end_ms {
            params_vec.push(Box::new(e));
        }
        let params_refs: Vec<&dyn duckdb::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

        let count: i64 = stmt.query_row(params_refs.as_slice(), |row| row.get(0))?;
        Ok(count as u64)
    }

    // --- Async wrappers (Step 3) ---

    /// Batch insert parsed positions (async via spawn_blocking).
    pub async fn insert_batch(
        &self,
        positions: Vec<AircraftPosition>,
        tz: String,
    ) -> Result<(), StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.insert_batch_sync(&positions, &tz))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Query positions within a bounding box (async via spawn_blocking).
    pub async fn query_bbox(&self, query: BboxQuery) -> Result<Vec<PositionRecord>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.query_bbox_sync(query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Query positions in a bounding box as Arrow IPC (async via spawn_blocking).
    pub async fn query_bbox_arrow(&self, query: BboxQuery) -> Result<Vec<u8>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.query_bbox_arrow_sync(query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Get trajectory for a single aircraft (async via spawn_blocking).
    pub async fn get_trajectory(
        &self,
        query: TrajectoryQuery,
    ) -> Result<Vec<PositionRecord>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_trajectory_sync(query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Batch-fetch trajectories as Arrow IPC bytes (async via spawn_blocking).
    pub async fn get_trajectories_batch_arrow(
        &self,
        queries: Vec<(TrajectoryQuery, String)>,
    ) -> Result<Vec<u8>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_trajectories_batch_arrow_sync(&queries))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Get aircraft summary (async via spawn_blocking).
    pub async fn get_aircraft_summary(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<Vec<AircraftSummary>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_aircraft_summary_sync(start_ms, end_ms))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Get flight-segmented summaries (async via spawn_blocking).
    pub async fn get_flight_summary(
        &self,
        query: FlightSummaryQuery,
    ) -> Result<Vec<FlightSummary>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_flight_summary_sync(&query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Get flight summaries as Arrow IPC (async via spawn_blocking).
    pub async fn get_flight_summary_arrow(
        &self,
        query: FlightSummaryQuery,
    ) -> Result<Vec<u8>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_flight_summary_arrow_sync(&query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Get storage statistics (async via spawn_blocking).
    pub async fn get_stats(&self) -> Result<StorageStats, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_stats_sync())
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Prune old positions (async via spawn_blocking).
    pub async fn prune(&self, older_than_ms: i64) -> Result<u64, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.prune_sync(older_than_ms))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Get time distribution histogram (async via spawn_blocking).
    pub async fn get_time_distribution(
        &self,
        query: TimeDistributionQuery,
    ) -> Result<Vec<TimeDistributionBucket>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_time_distribution_sync(query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Get detection range by azimuth sector (async via spawn_blocking).
    pub async fn get_detection_range(
        &self,
        query: DetectionRangeQuery,
    ) -> Result<Vec<DetectionRangeSector>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_detection_range_sync(query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Get hourly activity heatmap (async via spawn_blocking).
    pub async fn get_hourly_heatmap(
        &self,
        query: HourlyHeatmapQuery,
    ) -> Result<Vec<HourlyHeatmapCell>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_hourly_heatmap_sync(query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Batch insert raw SBS messages (async via spawn_blocking).
    pub async fn insert_raw_batch(
        &self,
        records: Vec<RawSbsRecord>,
        tz: String,
    ) -> Result<(), StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.insert_raw_batch_sync(&records, &tz))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Count raw messages in a time range (async via spawn_blocking).
    pub async fn get_raw_message_count(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) -> Result<u64, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.get_raw_message_count_sync(start_ms, end_ms))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Query raw messages (async via spawn_blocking).
    pub async fn query_raw_messages(
        &self,
        query: RawMessageQuery,
    ) -> Result<Vec<RawSbsRecord>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.query_raw_messages_sync(query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Query raw SBS messages as Arrow IPC (async via spawn_blocking).
    pub async fn query_raw_messages_arrow(
        &self,
        query: RawMessageQuery,
    ) -> Result<Vec<u8>, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.query_raw_messages_arrow_sync(query))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Flush the WAL to disk (synchronous).
    ///
    /// Forces DuckDB to write all pending changes from the write-ahead log
    /// into the main database file. Call before releasing the connection
    /// so external tools see a consistent state.
    pub fn checkpoint_sync(&self) -> Result<(), StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;
        storage.conn.execute_batch("CHECKPOINT")?;
        Ok(())
    }

    /// Flush the WAL to disk (async via spawn_blocking).
    pub async fn checkpoint(&self) -> Result<(), StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.checkpoint_sync())
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Export the database to a new file at `target_path` (synchronous).
    ///
    /// Uses DuckDB's `ATTACH` + `CREATE TABLE AS` to copy all tables
    /// within the current connection — recording continues uninterrupted.
    /// The target file is overwritten if it already exists.
    pub fn export_database_sync(&self, target_path: &std::path::Path) -> Result<(), StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        // Flush WAL first for a consistent snapshot
        storage.conn.execute_batch("CHECKPOINT")?;

        // Clean overwrite
        if target_path.exists() {
            std::fs::remove_file(target_path)?;
        }
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let path_str = target_path.to_string_lossy().replace('\'', "''");
        storage.conn.execute_batch(&format!(
            "ATTACH '{}' AS export_db;
             CREATE TABLE export_db.positions AS SELECT * FROM positions;
             CREATE TABLE export_db.raw_messages AS SELECT * FROM raw_messages;
             DETACH export_db;",
            path_str
        ))?;

        info!("Database exported to {}", target_path.display());
        Ok(())
    }

    /// Export the database to a new file (async via spawn_blocking).
    pub async fn export_database(
        &self,
        target_path: std::path::PathBuf,
    ) -> Result<(), StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.export_database_sync(&target_path))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Preview an external database file before importing (synchronous).
    ///
    /// ATTACHes the file as `import_db (READ_ONLY)`, queries row counts and
    /// timestamp ranges for each table, then DETACHes. Returns zero-count
    /// `TablePreview` for tables that don't exist in the external file.
    pub fn preview_import_sync(
        &self,
        path: &std::path::Path,
    ) -> Result<ImportPreview, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        let path_str = path.to_string_lossy().replace('\'', "''");
        Self::with_attached_db(&storage.conn, &path_str, |conn| {
            let positions = Self::preview_table(conn, "positions")?;
            let raw_messages = Self::preview_table(conn, "raw_messages")?;
            Ok(ImportPreview {
                positions,
                raw_messages,
            })
        })
    }

    /// Preview an external database (async via spawn_blocking).
    pub async fn preview_import(
        &self,
        path: std::path::PathBuf,
    ) -> Result<ImportPreview, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.preview_import_sync(&path))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    /// Import records from an external database file with deduplication (synchronous).
    ///
    /// ATTACHes the file as `import_db (READ_ONLY)`, CHECKPOINTs the current DB,
    /// then INSERTs rows that don't already exist (anti-join on natural keys).
    /// Returns the count of newly imported rows per table.
    pub fn import_database_sync(
        &self,
        path: &std::path::Path,
    ) -> Result<ImportResult, StorageError> {
        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

        storage.conn.execute_batch("CHECKPOINT")?;

        let path_str = path.to_string_lossy().replace('\'', "''");
        Self::with_attached_db(&storage.conn, &path_str, |conn| {
            let positions_imported = if Self::table_exists_in_schema(conn, "positions")? {
                conn.execute(
                    "INSERT INTO positions
                     SELECT ip.* FROM import_db.positions ip
                     WHERE NOT EXISTS (
                         SELECT 1 FROM positions p
                         WHERE p.hex_ident = ip.hex_ident AND p.timestamp_ms = ip.timestamp_ms
                     )",
                    [],
                )? as u64
            } else {
                0
            };

            let raw_messages_imported = if Self::table_exists_in_schema(conn, "raw_messages")? {
                conn.execute(
                    "INSERT INTO raw_messages
                     SELECT ir.* FROM import_db.raw_messages ir
                     WHERE NOT EXISTS (
                         SELECT 1 FROM raw_messages r
                         WHERE r.hex_ident = ir.hex_ident AND r.timestamp_ms = ir.timestamp_ms
                           AND r.raw_message = ir.raw_message
                     )",
                    [],
                )? as u64
            } else {
                0
            };

            info!(
                "Database imported: {} positions, {} raw messages",
                positions_imported, raw_messages_imported
            );

            Ok(ImportResult {
                positions_imported,
                raw_messages_imported,
            })
        })
    }

    /// Import records from an external database (async via spawn_blocking).
    pub async fn import_database(
        &self,
        path: std::path::PathBuf,
    ) -> Result<ImportResult, StorageError> {
        let handle = self.clone();
        tokio::task::spawn_blocking(move || handle.import_database_sync(&path))
            .await
            .map_err(|e| StorageError::Query(format!("Task join error: {e}")))?
    }

    // --- Private helpers for import ---

    /// ATTACH an external database, run a closure, and always DETACH afterwards.
    fn with_attached_db<T>(
        conn: &Connection,
        path_str: &str,
        f: impl FnOnce(&Connection) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        conn.execute_batch(&format!("ATTACH '{}' AS import_db (READ_ONLY)", path_str))?;
        let result = f(conn);
        let _ = conn.execute_batch("DETACH import_db");
        result
    }

    /// Check if a table exists in the import_db catalog.
    fn table_exists_in_schema(conn: &Connection, table_name: &str) -> Result<bool, StorageError> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM information_schema.tables
             WHERE table_catalog = 'import_db' AND table_name = ?",
            params![table_name],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Preview a single table from import_db (returns zero-count if table doesn't exist).
    fn preview_table(conn: &Connection, table_name: &str) -> Result<TablePreview, StorageError> {
        if !Self::table_exists_in_schema(conn, table_name)? {
            return Ok(TablePreview {
                row_count: 0,
                oldest_timestamp_ms: None,
                newest_timestamp_ms: None,
            });
        }
        let (count, min_ts, max_ts): (i64, Option<i64>, Option<i64>) = conn.query_row(
            &format!(
                "SELECT COUNT(*), MIN(timestamp_ms), MAX(timestamp_ms) FROM import_db.{}",
                table_name
            ),
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(TablePreview {
            row_count: count as u64,
            oldest_timestamp_ms: min_ts,
            newest_timestamp_ms: max_ts,
        })
    }
}

/// Move a database file (and its WAL) to a snapshot path.
///
/// The DuckDB connection **must be closed** before calling this function,
/// otherwise the file may be locked. Parent directories of `snapshot_path`
/// are created automatically.
///
/// If a WAL file (`*.db.wal`) exists alongside `db_path`, it is moved too.
pub fn move_database_to_snapshot(
    db_path: &std::path::Path,
    snapshot_path: &std::path::Path,
) -> Result<(), StorageError> {
    // Create parent dirs for snapshot
    if let Some(parent) = snapshot_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Move main DB file
    std::fs::rename(db_path, snapshot_path)?;

    // Move WAL file if it exists
    let wal_source = db_path.with_extension("db.wal");
    if wal_source.exists() {
        let wal_target = snapshot_path.with_extension("db.wal");
        std::fs::rename(&wal_source, &wal_target)?;
    }

    info!(
        "Database moved to snapshot: {} → {}",
        db_path.display(),
        snapshot_path.display()
    );
    Ok(())
}

/// Parse an SBS-1 timestamp string ("YYYY/MM/DD HH:MM:SS.mmm") to UTC epoch milliseconds.
///
/// `tz` controls how the naive datetime is interpreted:
/// - `"Local"` — machine's local timezone (default; preserves previous behaviour)
/// - `"UTC"`   — explicit UTC
/// - any other string — IANA timezone name (e.g. `"Europe/Paris"`);
///   falls back to local with a warning if unrecognised
///
/// The returned `i64` is always a true UTC epoch millisecond value.
fn parse_timestamp_to_ms(timestamp: &str, tz: &str) -> i64 {
    use std::str::FromStr;

    let naive = chrono::NaiveDateTime::parse_from_str(timestamp, "%Y/%m/%d %H:%M:%S%.3f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(timestamp, "%Y/%m/%d %H:%M:%S"));

    let naive = match naive {
        Ok(dt) => dt,
        Err(_) => return chrono::Utc::now().timestamp_millis(),
    };

    match tz {
        "UTC" => naive.and_utc().timestamp_millis(),
        "Local" => naive
            .and_local_timezone(chrono::Local)
            .single()
            .map(|dt| dt.timestamp_millis())
            .unwrap_or_else(|| naive.and_utc().timestamp_millis()),
        iana => match chrono_tz::Tz::from_str(iana) {
            Ok(resolved) => naive
                .and_local_timezone(resolved)
                .single()
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_else(|| naive.and_utc().timestamp_millis()),
            Err(_) => {
                tracing::warn!("Unknown timezone '{}', falling back to Local", iana);
                naive
                    .and_local_timezone(chrono::Local)
                    .single()
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or_else(|| naive.and_utc().timestamp_millis())
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> StorageConfig {
        StorageConfig {
            db_path: None,
            source_id: "test".to_string(),
            gap_threshold_ms: 3_600_000,
        }
    }

    fn sample_position(
        hex: &str,
        lat: Option<f64>,
        lon: Option<f64>,
        ts: &str,
    ) -> AircraftPosition {
        AircraftPosition {
            hex_ident: hex.to_string(),
            callsign: Some("TEST123".to_string()),
            altitude: Some(35000.0),
            ground_speed: Some(450.0),
            track: Some(90.0),
            latitude: lat,
            longitude: lon,
            vertical_rate: Some(0.0),
            squawk: Some("1200".to_string()),
            is_on_ground: Some(false),
            timestamp: ts.to_string(),
            message_count: 0,
        }
    }

    #[test]
    fn test_open_in_memory() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 0);
    }

    #[test]
    fn test_insert_batch_uses_tz_for_parsing() {
        // Europe/Paris in January = UTC+1.
        // Wall-clock "10:30:00" in Paris = "09:30:00" UTC.
        let handle = StorageHandle::open(test_config()).unwrap();
        let pos = sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000");
        handle.insert_batch_sync(&[pos], "Europe/Paris").unwrap();

        let utc_ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "UTC");
        let expected_ms = utc_ms - 3600 * 1000; // 09:30 UTC = 10:30 Paris

        let storage = handle.inner.lock().unwrap();
        let stored_ms: i64 = storage
            .conn
            .query_row("SELECT timestamp_ms FROM positions LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored_ms, expected_ms);
    }

    #[test]
    fn test_insert_batch_and_count() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("D4E5F6", Some(46.0), Some(-74.0), "2024/01/15 10:30:01.000"),
        ];

        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 2);
    }

    #[test]
    fn test_insert_empty_batch() {
        let handle = StorageHandle::open(test_config()).unwrap();
        handle.insert_batch_sync(&[], "UTC").unwrap();
        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 0);
    }

    #[test]
    fn test_query_bbox_returns_matching() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("D4E5F6", Some(46.0), Some(-74.0), "2024/01/15 10:30:01.000"),
            sample_position("G7H8I9", Some(50.0), Some(-80.0), "2024/01/15 10:30:02.000"), // outside bbox
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let results = handle
            .query_bbox_sync(BboxQuery {
                north: 47.0,
                south: 45.0,
                east: -72.0,
                west: -75.0,
                start_ms: None,
                end_ms: None,
                limit: 100,
            })
            .unwrap();

        assert_eq!(results.len(), 2);
        // Sorted by hex_ident, so A1B2C3 first
        assert_eq!(results[0].hex_ident, "A1B2C3");
        assert_eq!(results[1].hex_ident, "D4E5F6");
    }

    #[test]
    fn test_query_bbox_with_time_window() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("A1B2C3", Some(45.6), Some(-73.6), "2024/01/15 10:31:00.000"),
            sample_position("A1B2C3", Some(45.7), Some(-73.7), "2024/01/15 10:32:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        // Query only the middle timestamp.
        // Use parse_timestamp_to_ms with "UTC" so query bounds match the UTC interpretation
        // used when storing — keeps the test timezone-agnostic.
        let ts_start = parse_timestamp_to_ms("2024/01/15 10:30:30.000", "UTC");
        let ts_end = parse_timestamp_to_ms("2024/01/15 10:31:30.000", "UTC");

        let results = handle
            .query_bbox_sync(BboxQuery {
                north: 47.0,
                south: 45.0,
                east: -72.0,
                west: -75.0,
                start_ms: Some(ts_start),
                end_ms: Some(ts_end),
                limit: 100,
            })
            .unwrap();

        assert_eq!(results.len(), 1);
        assert!((results[0].latitude - 45.6).abs() < 0.001);
    }

    #[test]
    fn test_query_bbox_excludes_null_coords() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("D4E5F6", None, None, "2024/01/15 10:30:01.000"), // no coords
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let results = handle
            .query_bbox_sync(BboxQuery {
                north: 90.0,
                south: -90.0,
                east: 180.0,
                west: -180.0,
                start_ms: None,
                end_ms: None,
                limit: 100,
            })
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].hex_ident, "A1B2C3");
    }

    #[test]
    fn test_get_trajectory_single_aircraft() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("A1B2C3", Some(45.6), Some(-73.6), "2024/01/15 10:31:00.000"),
            sample_position("D4E5F6", Some(46.0), Some(-74.0), "2024/01/15 10:30:00.000"), // different aircraft
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let results = handle
            .get_trajectory_sync(TrajectoryQuery {
                hex_ident: "A1B2C3".to_string(),
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].hex_ident, "A1B2C3");
        assert_eq!(results[1].hex_ident, "A1B2C3");
        // Ordered by timestamp
        assert!(results[0].timestamp_ms < results[1].timestamp_ms);
    }

    #[test]
    fn test_batch_arrow_returns_valid_ipc_stream() {
        use arrow::ipc::reader::StreamReader;

        let handle = StorageHandle::open(test_config()).unwrap();
        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("A1B2C3", Some(45.6), Some(-73.6), "2024/01/15 10:31:00.000"),
            sample_position("D4E5F6", Some(46.0), Some(-74.0), "2024/01/15 10:30:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let queries = vec![
            (
                TrajectoryQuery {
                    hex_ident: "A1B2C3".to_string(),
                    start_ms: None,
                    end_ms: None,
                },
                "A1B2C3_0".to_string(),
            ),
            (
                TrajectoryQuery {
                    hex_ident: "D4E5F6".to_string(),
                    start_ms: None,
                    end_ms: None,
                },
                "D4E5F6_0".to_string(),
            ),
        ];

        let bytes = handle.get_trajectories_batch_arrow_sync(&queries).unwrap();
        assert!(!bytes.is_empty());

        // Verify the IPC stream is valid and contains expected data
        let cursor = std::io::Cursor::new(&bytes);
        let reader = StreamReader::try_new(cursor, None).unwrap();
        let schema = reader.schema();

        // Should have 12 columns (11 from positions + flight_id)
        assert_eq!(schema.fields().len(), 12);
        assert!(schema.field_with_name("flight_id").is_ok());
        assert!(schema.field_with_name("latitude").is_ok());
        assert!(schema.field_with_name("hex_ident").is_ok());

        // Read all batches
        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
        assert_eq!(total_rows, 3); // 2 for A1B2C3 + 1 for D4E5F6
    }

    #[test]
    fn test_batch_arrow_empty_queries_returns_empty() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let bytes = handle.get_trajectories_batch_arrow_sync(&[]).unwrap();
        assert!(bytes.is_empty());
    }

    #[test]
    fn test_flight_summary_arrow_returns_valid_ipc() {
        let handle = StorageHandle::open(test_config()).unwrap();

        // Insert positions and trigger flight segmentation
        let pos1 = sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000");
        let pos2 = sample_position("A1B2C3", Some(45.6), Some(-73.4), "2024/01/15 10:30:00.000");
        let pos3 = sample_position("D4E5F6", Some(40.7), Some(-74.0), "2024/01/15 11:00:00.000");
        handle
            .insert_batch_sync(&[pos1, pos2, pos3], "UTC")
            .unwrap();

        let query = FlightSummaryQuery {
            start_ms: None,
            end_ms: None,
        };
        let bytes = handle.get_flight_summary_arrow_sync(&query).unwrap();
        assert!(!bytes.is_empty());

        use arrow::ipc::reader::StreamReader;
        let reader = StreamReader::try_new(std::io::Cursor::new(&bytes), None).unwrap();
        let schema = reader.schema();
        assert_eq!(schema.fields().len(), 9);
        assert_eq!(schema.field(0).name(), "hex_ident");
        assert_eq!(schema.field(2).name(), "flight_id");

        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
        assert!(total_rows >= 2); // At least 2 flights (A1B2C3 + D4E5F6)
    }

    #[test]
    fn test_query_bbox_arrow_returns_valid_ipc() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let pos1 = sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000");
        let pos2 = sample_position("A1B2C3", Some(45.6), Some(-73.4), "2024/01/15 10:30:00.000");
        handle.insert_batch_sync(&[pos1, pos2], "UTC").unwrap();

        let query = BboxQuery {
            south: 45.0,
            north: 46.0,
            west: -74.0,
            east: -73.0,
            start_ms: None,
            end_ms: None,
            limit: 1000,
        };
        let bytes = handle.query_bbox_arrow_sync(query).unwrap();
        assert!(!bytes.is_empty());

        use arrow::ipc::reader::StreamReader;
        let reader = StreamReader::try_new(std::io::Cursor::new(&bytes), None).unwrap();
        let schema = reader.schema();
        assert_eq!(schema.fields().len(), 11);
        assert_eq!(schema.field(0).name(), "hex_ident");
        assert_eq!(schema.field(10).name(), "timestamp_ms");

        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
        assert_eq!(total_rows, 2);
    }

    #[test]
    fn test_raw_messages_arrow_returns_valid_ipc() {
        let handle = StorageHandle::open(test_config()).unwrap();

        // Insert raw messages via insert_raw_batch_sync
        let raw = RawSbsRecord {
            hex_ident: "A1B2C3".to_string(),
            msg_type: "MSG".to_string(),
            transmission_type: Some(3),
            timestamp: "2024/01/15 10:00:00.000".to_string(),
            timestamp_ms: 0, // will be parsed from timestamp field
            raw_message: "MSG,3,1,1,A1B2C3,1,2024/01/15,10:00:00.000,,,45.5,-73.5,35000,,,,,,0"
                .to_string(),
            source_id: "test".to_string(),
        };
        handle.insert_raw_batch_sync(&[raw], "UTC").unwrap();

        let query = RawMessageQuery {
            hex_ident: "A1B2C3".to_string(),
            start_ms: 0,
            end_ms: i64::MAX,
        };
        let bytes = handle.query_raw_messages_arrow_sync(query).unwrap();
        assert!(!bytes.is_empty());

        use arrow::ipc::reader::StreamReader;
        let reader = StreamReader::try_new(std::io::Cursor::new(&bytes), None).unwrap();
        let schema = reader.schema();
        assert_eq!(schema.fields().len(), 6);
        assert_eq!(schema.field(0).name(), "hex_ident");
        assert_eq!(schema.field(4).name(), "raw_message");

        let batches: Vec<_> = reader.collect::<Result<Vec<_>, _>>().unwrap();
        let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
        assert_eq!(total_rows, 1);
    }

    #[test]
    fn test_get_aircraft_summary() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let mut pos1 =
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000");
        pos1.altitude = Some(30000.0);
        let mut pos2 =
            sample_position("A1B2C3", Some(45.6), Some(-73.6), "2024/01/15 10:31:00.000");
        pos2.altitude = Some(35000.0);
        let pos3 = sample_position("D4E5F6", Some(46.0), Some(-74.0), "2024/01/15 10:30:00.000");

        handle
            .insert_batch_sync(&[pos1, pos2, pos3], "UTC")
            .unwrap();

        let summaries = handle.get_aircraft_summary_sync(None, None).unwrap();

        assert_eq!(summaries.len(), 2);

        // Find A1B2C3
        let a = summaries.iter().find(|s| s.hex_ident == "A1B2C3").unwrap();
        assert_eq!(a.position_count, 2);
        assert_eq!(a.min_altitude, Some(30000.0));
        assert_eq!(a.max_altitude, Some(35000.0));
    }

    #[test]
    fn test_get_stats_time_range() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("A1B2C3", Some(45.6), Some(-73.6), "2024/01/15 10:35:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 2);
        assert!(stats.oldest_timestamp_ms.is_some());
        assert!(stats.newest_timestamp_ms.is_some());
        assert!(stats.oldest_timestamp_ms.unwrap() < stats.newest_timestamp_ms.unwrap());
    }

    #[test]
    fn test_prune_removes_old_data() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("OLD", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("NEW", Some(45.6), Some(-73.6), "2024/06/15 10:00:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        // Prune anything before 2024/03/01
        let cutoff = chrono::NaiveDateTime::parse_from_str(
            "2024/03/01 00:00:00.000",
            "%Y/%m/%d %H:%M:%S%.3f",
        )
        .unwrap()
        .and_utc()
        .timestamp_millis();

        let deleted = handle.prune_sync(cutoff).unwrap();
        assert_eq!(deleted, 1);

        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 1);
    }

    #[test]
    fn test_parse_timestamp_to_ms_valid() {
        let ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "Local");
        // SBS-1 timestamps carry no timezone; interpret as local time, not UTC.
        let expected = chrono::NaiveDateTime::parse_from_str(
            "2024/01/15 10:30:00.000",
            "%Y/%m/%d %H:%M:%S%.3f",
        )
        .unwrap()
        .and_local_timezone(chrono::Local)
        .single()
        .unwrap()
        .timestamp_millis();
        assert_eq!(ms, expected);
    }

    #[test]
    fn test_parse_timestamp_to_ms_no_millis() {
        let ms = parse_timestamp_to_ms("2024/01/15 10:30:00", "Local");
        let expected =
            chrono::NaiveDateTime::parse_from_str("2024/01/15 10:30:00", "%Y/%m/%d %H:%M:%S")
                .unwrap()
                .and_local_timezone(chrono::Local)
                .single()
                .unwrap()
                .timestamp_millis();
        assert_eq!(ms, expected);
    }

    #[test]
    fn test_parse_timestamp_to_ms_invalid_uses_current() {
        let before = chrono::Utc::now().timestamp_millis();
        let ms = parse_timestamp_to_ms("invalid", "UTC");
        let after = chrono::Utc::now().timestamp_millis();
        assert!(ms >= before && ms <= after);
    }

    #[test]
    fn test_parse_timestamp_to_ms_utc() {
        let ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "UTC");
        let expected = chrono::NaiveDateTime::parse_from_str(
            "2024/01/15 10:30:00.000",
            "%Y/%m/%d %H:%M:%S%.3f",
        )
        .unwrap()
        .and_utc()
        .timestamp_millis();
        assert_eq!(ms, expected);
    }

    #[test]
    fn test_parse_timestamp_to_ms_iana_paris() {
        // Europe/Paris = UTC+1 in January (no DST)
        // Local 10:30 Paris = 09:30 UTC → 1 hour before the UTC reading
        let utc_ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "UTC");
        let paris_ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "Europe/Paris");
        assert_eq!(paris_ms, utc_ms - 3600 * 1000);
    }

    #[test]
    fn test_parse_timestamp_to_ms_unknown_tz_does_not_panic() {
        // Unknown TZ must fall back gracefully — no panic
        let ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "Not/A/TZ");
        assert!(ms > 0);
    }

    #[test]
    fn test_source_id_stored() {
        let config = StorageConfig {
            db_path: None,
            source_id: "my-receiver".to_string(),
            gap_threshold_ms: 3_600_000,
        };
        let handle = StorageHandle::open(config).unwrap();

        let positions = vec![sample_position(
            "A1B2C3",
            Some(45.5),
            Some(-73.5),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        // Query source_id from raw SQL
        let storage = handle.inner.lock().unwrap();
        let source: String = storage
            .conn
            .query_row("SELECT source_id FROM positions LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(source, "my-receiver");
    }

    #[test]
    fn test_time_distribution_empty() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: 1000,
                end_ms: 2000,
                num_buckets: 10,
                ..Default::default()
            })
            .unwrap();
        assert!(buckets.is_empty());
    }

    #[test]
    fn test_time_distribution_buckets() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Insert positions spread across multiple buckets
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(45.6), Some(-73.6), "2024/01/15 10:00:30.000"),
            sample_position("A3", Some(45.7), Some(-73.7), "2024/01/15 10:01:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let ts_start = parse_timestamp_to_ms("2024/01/15 10:00:00.000", "UTC");
        let ts_end = parse_timestamp_to_ms("2024/01/15 10:02:00.000", "UTC");

        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: ts_start,
                end_ms: ts_end,
                num_buckets: 4,
                ..Default::default()
            })
            .unwrap();

        // Should have at least 1 bucket with data
        assert!(!buckets.is_empty());
        // Total count across all buckets should equal 3
        let total: u64 = buckets.iter().map(|b| b.count).sum();
        assert_eq!(total, 3);
        // Buckets should be ordered by bucket_ms
        for w in buckets.windows(2) {
            assert!(w[0].bucket_ms < w[1].bucket_ms);
        }
    }

    #[test]
    fn test_time_distribution_same_bucket() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Two positions very close together should fall in same bucket with a large bucket width
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(45.6), Some(-73.6), "2024/01/15 10:00:01.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let ts_start = parse_timestamp_to_ms("2024/01/15 09:00:00.000", "UTC");
        let ts_end = parse_timestamp_to_ms("2024/01/15 11:00:00.000", "UTC");

        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: ts_start,
                end_ms: ts_end,
                num_buckets: 2,
                ..Default::default()
            })
            .unwrap();

        // With 2 buckets over 2 hours, bucket_width = 1 hour
        // Both positions are at ~10:00:00, so they fall in the same second-half bucket
        let total: u64 = buckets.iter().map(|b| b.count).sum();
        assert_eq!(total, 2);
        // They should be in a single bucket since they are only 1 second apart
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].count, 2);
    }

    #[test]
    fn test_time_distribution_respects_range() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(45.6), Some(-73.6), "2024/01/15 12:00:00.000"), // 2 hours later
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        // Query a range that only covers the first position
        let ts_start = parse_timestamp_to_ms("2024/01/15 09:59:00.000", "UTC");
        let ts_end = parse_timestamp_to_ms("2024/01/15 10:01:00.000", "UTC");

        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: ts_start,
                end_ms: ts_end,
                num_buckets: 4,
                ..Default::default()
            })
            .unwrap();

        let total: u64 = buckets.iter().map(|b| b.count).sum();
        assert_eq!(total, 1); // Only the first position falls in range
    }

    #[test]
    fn test_clone_shares_connection() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let handle2 = handle.clone();

        let positions = vec![sample_position(
            "A1B2C3",
            Some(45.5),
            Some(-73.5),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        // Clone should see the same data
        let stats = handle2.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 1);
    }

    #[tokio::test]
    async fn test_async_insert_and_query() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("D4E5F6", Some(46.0), Some(-74.0), "2024/01/15 10:30:01.000"),
        ];

        handle
            .insert_batch(positions, "UTC".to_string())
            .await
            .unwrap();

        let stats = handle.get_stats().await.unwrap();
        assert_eq!(stats.row_count, 2);

        let results = handle
            .query_bbox(BboxQuery {
                north: 47.0,
                south: 45.0,
                east: -72.0,
                west: -75.0,
                start_ms: None,
                end_ms: None,
                limit: 100,
            })
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_async_trajectory() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("A1B2C3", Some(45.6), Some(-73.6), "2024/01/15 10:31:00.000"),
        ];
        handle
            .insert_batch(positions, "UTC".to_string())
            .await
            .unwrap();

        let trajectory = handle
            .get_trajectory(TrajectoryQuery {
                hex_ident: "A1B2C3".to_string(),
                start_ms: None,
                end_ms: None,
            })
            .await
            .unwrap();

        assert_eq!(trajectory.len(), 2);
        assert!(trajectory[0].timestamp_ms < trajectory[1].timestamp_ms);
    }

    #[tokio::test]
    async fn test_async_prune() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("OLD", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("NEW", Some(45.6), Some(-73.6), "2024/06/15 10:00:00.000"),
        ];
        handle
            .insert_batch(positions, "UTC".to_string())
            .await
            .unwrap();

        let cutoff = chrono::NaiveDateTime::parse_from_str(
            "2024/03/01 00:00:00.000",
            "%Y/%m/%d %H:%M:%S%.3f",
        )
        .unwrap()
        .and_utc()
        .timestamp_millis();

        let deleted = handle.prune(cutoff).await.unwrap();
        assert_eq!(deleted, 1);
    }

    // --- Detection range tests ---

    #[test]
    fn test_detection_range_empty_db() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.5,
                receiver_lon: -73.5,
                start_ms: Some(0),
                end_ms: Some(i64::MAX),
            })
            .unwrap();

        assert_eq!(sectors.len(), 36);
        assert!(sectors.iter().all(|s| s.max_distance_nm == 0.0));
        assert!(sectors.iter().all(|s| s.position_count == 0));
    }

    #[test]
    fn test_detection_range_always_36_sectors() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Insert a single position
        let positions = vec![sample_position(
            "A1B2C3",
            Some(46.0),
            Some(-73.5),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.5,
                receiver_lon: -73.5,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        assert_eq!(sectors.len(), 36);
        // Bearings should be 0, 10, 20, ..., 350
        for (i, s) in sectors.iter().enumerate() {
            assert_eq!(s.bearing_deg, (i * 10) as u16);
        }
    }

    #[test]
    fn test_detection_range_single_position_validates_against_geo() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let rx_lat = 45.5;
        let rx_lon = -73.5;
        let ac_lat = 46.0;
        let ac_lon = -73.0;

        let positions = vec![sample_position(
            "A1B2C3",
            Some(ac_lat),
            Some(ac_lon),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: rx_lat,
                receiver_lon: rx_lon,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        // Validate against reference geo functions
        let expected_dist = crate::geo::haversine_nm(rx_lat, rx_lon, ac_lat, ac_lon);
        let expected_bearing = crate::geo::initial_bearing_deg(rx_lat, rx_lon, ac_lat, ac_lon);
        let expected_sector = crate::geo::bearing_to_sector(expected_bearing);

        // Exactly one sector should have data
        let non_zero: Vec<_> = sectors.iter().filter(|s| s.position_count > 0).collect();
        assert_eq!(non_zero.len(), 1, "Expected exactly 1 non-zero sector");
        assert_eq!(non_zero[0].bearing_deg, (expected_sector * 10) as u16);
        assert_eq!(non_zero[0].position_count, 1);
        // DuckDB and Rust haversine should agree within ~0.1 NM
        assert!(
            (non_zero[0].max_distance_nm - expected_dist).abs() < 0.1,
            "DuckDB dist {} vs Rust dist {}: diff > 0.1 NM",
            non_zero[0].max_distance_nm,
            expected_dist
        );
    }

    #[test]
    fn test_detection_range_max_per_sector() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let rx_lat = 45.0;
        let rx_lon = -73.0;

        // Two positions due north at different distances
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.0), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(46.5), Some(-73.0), "2024/01/15 10:00:01.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: rx_lat,
                receiver_lon: rx_lon,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        // Both should be in the same sector (roughly north)
        let north_sectors: Vec<_> = sectors.iter().filter(|s| s.position_count > 0).collect();
        assert_eq!(
            north_sectors.len(),
            1,
            "Both positions should be in same sector"
        );
        assert_eq!(north_sectors[0].position_count, 2);

        // Max distance should be the farther one
        let far_dist = crate::geo::haversine_nm(rx_lat, rx_lon, 46.5, -73.0);
        assert!(
            (north_sectors[0].max_distance_nm - far_dist).abs() < 0.1,
            "Max distance should be the farther position"
        );
    }

    #[test]
    fn test_detection_range_time_window_filtering() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("OLD", Some(46.0), Some(-73.0), "2024/01/15 10:00:00.000"),
            sample_position("NEW", Some(46.0), Some(-73.0), "2024/01/15 12:00:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        // Query only second half of the time range
        let mid = parse_timestamp_to_ms("2024/01/15 11:00:00.000", "UTC");
        let end = parse_timestamp_to_ms("2024/01/15 13:00:00.000", "UTC");

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.0,
                receiver_lon: -73.0,
                start_ms: Some(mid),
                end_ms: Some(end),
            })
            .unwrap();

        let total_count: u64 = sectors.iter().map(|s| s.position_count).sum();
        assert_eq!(total_count, 1, "Only the NEW position should be included");
    }

    #[test]
    fn test_detection_range_null_coords_excluded() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1", Some(46.0), Some(-73.0), "2024/01/15 10:00:00.000"),
            sample_position("A2", None, None, "2024/01/15 10:00:01.000"), // no coords
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.0,
                receiver_lon: -73.0,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        let total_count: u64 = sectors.iter().map(|s| s.position_count).sum();
        assert_eq!(total_count, 1, "Null-coord position should be excluded");
    }

    fn sample_position_with_altitude(
        hex: &str,
        lat: Option<f64>,
        lon: Option<f64>,
        altitude: Option<f64>,
        ts: &str,
    ) -> AircraftPosition {
        let mut pos = sample_position(hex, lat, lon, ts);
        pos.altitude = altitude;
        pos
    }

    #[test]
    fn test_detection_range_altitude_single_position() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let positions = vec![sample_position_with_altitude(
            "A1",
            Some(46.0),
            Some(-73.0),
            Some(35000.0),
            "2024/01/15 10:00:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.0,
                receiver_lon: -73.0,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        let non_zero: Vec<_> = sectors.iter().filter(|s| s.position_count > 0).collect();
        assert_eq!(non_zero.len(), 1);
        assert_eq!(non_zero[0].min_altitude, Some(35000.0));
        assert_eq!(non_zero[0].max_altitude, Some(35000.0));
    }

    #[test]
    fn test_detection_range_altitude_min_max_per_sector() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Two positions due north at different altitudes
        let positions = vec![
            sample_position_with_altitude(
                "A1",
                Some(45.5),
                Some(-73.0),
                Some(5000.0),
                "2024/01/15 10:00:00.000",
            ),
            sample_position_with_altitude(
                "A2",
                Some(45.6),
                Some(-73.0),
                Some(40000.0),
                "2024/01/15 10:00:01.000",
            ),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.0,
                receiver_lon: -73.0,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        let non_zero: Vec<_> = sectors.iter().filter(|s| s.position_count > 0).collect();
        assert_eq!(non_zero.len(), 1);
        assert_eq!(non_zero[0].min_altitude, Some(5000.0));
        assert_eq!(non_zero[0].max_altitude, Some(40000.0));
    }

    #[test]
    fn test_detection_range_altitude_null_when_no_altitude_data() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Position with no altitude
        let positions = vec![sample_position_with_altitude(
            "A1",
            Some(46.0),
            Some(-73.0),
            None,
            "2024/01/15 10:00:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.0,
                receiver_lon: -73.0,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        let non_zero: Vec<_> = sectors.iter().filter(|s| s.position_count > 0).collect();
        assert_eq!(non_zero.len(), 1);
        assert_eq!(non_zero[0].min_altitude, None);
        assert_eq!(non_zero[0].max_altitude, None);
    }

    #[test]
    fn test_detection_range_empty_sectors_have_null_altitude() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.0,
                receiver_lon: -73.0,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        assert!(sectors.iter().all(|s| s.min_altitude.is_none()));
        assert!(sectors.iter().all(|s| s.max_altitude.is_none()));
    }

    #[test]
    fn test_detection_range_50nm_accuracy() {
        // Receiver near Paris (48.8°N, 2.3°E). Place aircraft ~50 NM away
        // in several directions and verify DuckDB haversine matches Rust.
        let handle = StorageHandle::open(test_config()).unwrap();
        let rx_lat = 48.8;
        let rx_lon = 2.3;

        // ~50 NM north (0.833° latitude ≈ 50 NM)
        let north_lat = 49.634;
        let north_lon = 2.3;
        // ~50 NM east (longitude offset adjusted for latitude)
        let east_lat = 48.8;
        let east_lon = 3.565; // 0.833° / cos(48.8°) ≈ 1.265°
                              // ~50 NM southwest
        let sw_lat = 48.2;
        let sw_lon = 1.5;

        let positions = vec![
            sample_position(
                "NORTH",
                Some(north_lat),
                Some(north_lon),
                "2024/01/15 10:00:00.000",
            ),
            sample_position(
                "EAST",
                Some(east_lat),
                Some(east_lon),
                "2024/01/15 10:00:01.000",
            ),
            sample_position("SW", Some(sw_lat), Some(sw_lon), "2024/01/15 10:00:02.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: rx_lat,
                receiver_lon: rx_lon,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        let non_zero: Vec<_> = sectors.iter().filter(|s| s.position_count > 0).collect();
        assert_eq!(
            non_zero.len(),
            3,
            "Expected 3 non-zero sectors, got {non_zero:?}"
        );

        for s in &non_zero {
            // Find the matching position based on sector bearing
            let (ac_lat, ac_lon, label) = if s.bearing_deg < 30 {
                (north_lat, north_lon, "NORTH")
            } else if s.bearing_deg >= 80 && s.bearing_deg <= 100 {
                (east_lat, east_lon, "EAST")
            } else {
                (sw_lat, sw_lon, "SW")
            };

            let expected = crate::geo::haversine_nm(rx_lat, rx_lon, ac_lat, ac_lon);
            let diff = (s.max_distance_nm - expected).abs();
            assert!(
                diff < 0.2,
                "{label}: DuckDB={:.2} NM, Rust={:.2} NM, diff={:.2} NM (>0.2 tolerance)",
                s.max_distance_nm,
                expected,
                diff
            );
            eprintln!(
                "{label}: bearing={}°, DuckDB={:.2} NM, Rust={:.2} NM, diff={:.4} NM",
                s.bearing_deg, s.max_distance_nm, expected, diff
            );
        }

        // Verify max range is ~50 NM
        let max_range = non_zero
            .iter()
            .map(|s| s.max_distance_nm)
            .fold(0.0_f64, f64::max);
        assert!(
            max_range > 40.0,
            "Max range {max_range:.1} NM should be >40 NM for ~50 NM positions"
        );
    }

    #[tokio::test]
    async fn test_detection_range_async() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let positions = vec![sample_position(
            "A1",
            Some(46.0),
            Some(-73.0),
            "2024/01/15 10:00:00.000",
        )];
        handle
            .insert_batch(positions, "UTC".to_string())
            .await
            .unwrap();

        let sectors = handle
            .get_detection_range(crate::types::DetectionRangeQuery {
                receiver_lat: 45.0,
                receiver_lon: -73.0,
                start_ms: None,
                end_ms: None,
            })
            .await
            .unwrap();

        assert_eq!(sectors.len(), 36);
        let total: u64 = sectors.iter().map(|s| s.position_count).sum();
        assert_eq!(total, 1);
    }

    // --- Hourly heatmap tests ---

    #[test]
    fn test_hourly_heatmap_groups_by_day_and_hour() {
        let handle = StorageHandle::open(test_config()).unwrap();

        // Insert positions across 2 different days and different hours (UTC).
        // Day 1: Jan 15 2024, hours 10 and 14
        // Day 2: Jan 16 2024, hour 10
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(45.6), Some(-73.6), "2024/01/15 10:30:00.000"),
            sample_position("A1", Some(45.7), Some(-73.7), "2024/01/15 14:00:00.000"),
            sample_position("A3", Some(45.8), Some(-73.8), "2024/01/16 10:00:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let start = parse_timestamp_to_ms("2024/01/15 00:00:00.000", "UTC");
        let end = parse_timestamp_to_ms("2024/01/16 23:59:59.000", "UTC");

        let cells = handle
            .get_hourly_heatmap_sync(crate::types::HourlyHeatmapQuery {
                start_ms: start,
                end_ms: end,
            })
            .unwrap();

        // Should have 3 cells: (Jan15, 10), (Jan15, 14), (Jan16, 10)
        assert_eq!(cells.len(), 3);

        // All ordered by day_ms, then hour
        assert!(cells[0].day_ms <= cells[1].day_ms);
        assert!(cells[1].day_ms <= cells[2].day_ms);

        // Jan 15, hour 10: 2 messages, 2 distinct aircraft (A1, A2)
        assert_eq!(cells[0].hour, 10);
        assert_eq!(cells[0].aircraft_count, 2);
        assert_eq!(cells[0].message_count, 2);
        assert_eq!(cells[0].raw_message_count, 0);

        // Jan 15, hour 14: 1 message, 1 aircraft (A1)
        assert_eq!(cells[1].hour, 14);
        assert_eq!(cells[1].aircraft_count, 1);
        assert_eq!(cells[1].message_count, 1);
        assert_eq!(cells[1].raw_message_count, 0);

        // Jan 16, hour 10: 1 message, 1 aircraft (A3)
        assert_eq!(cells[2].hour, 10);
        assert_eq!(cells[2].aircraft_count, 1);
        assert_eq!(cells[2].message_count, 1);
        assert_eq!(cells[2].raw_message_count, 0);
    }

    #[test]
    fn test_hourly_heatmap_empty_db() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let cells = handle
            .get_hourly_heatmap_sync(crate::types::HourlyHeatmapQuery {
                start_ms: 0,
                end_ms: i64::MAX,
            })
            .unwrap();
        assert!(cells.is_empty());
    }

    #[test]
    fn test_hourly_heatmap_respects_time_window() {
        let handle = StorageHandle::open(test_config()).unwrap();

        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(45.6), Some(-73.6), "2024/01/16 10:00:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        // Query only Jan 15
        let start = parse_timestamp_to_ms("2024/01/15 00:00:00.000", "UTC");
        let end = parse_timestamp_to_ms("2024/01/15 23:59:59.000", "UTC");

        let cells = handle
            .get_hourly_heatmap_sync(crate::types::HourlyHeatmapQuery {
                start_ms: start,
                end_ms: end,
            })
            .unwrap();

        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].aircraft_count, 1);
        assert_eq!(cells[0].raw_message_count, 0);
    }

    #[test]
    fn test_hourly_heatmap_includes_raw_message_count() {
        let handle = StorageHandle::open(test_config()).unwrap();

        // Insert positions and raw messages in overlapping time windows.
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(45.6), Some(-73.6), "2024/01/15 10:30:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let raw_records = vec![
            sample_raw_record("A1", "MSG,3", Some(3), "2024/01/15 10:00:00.000"),
            sample_raw_record("A1", "MSG,1", Some(1), "2024/01/15 10:00:01.000"),
            sample_raw_record("A2", "MSG,3", Some(3), "2024/01/15 10:00:02.000"),
            // One raw message in hour 14, no positions in that hour
            sample_raw_record("A3", "MSG,4", Some(4), "2024/01/15 14:00:00.000"),
        ];
        handle.insert_raw_batch_sync(&raw_records, "UTC").unwrap();

        let start = parse_timestamp_to_ms("2024/01/15 00:00:00.000", "UTC");
        let end = parse_timestamp_to_ms("2024/01/15 23:59:59.000", "UTC");

        let cells = handle
            .get_hourly_heatmap_sync(crate::types::HourlyHeatmapQuery {
                start_ms: start,
                end_ms: end,
            })
            .unwrap();

        // Should have 2 cells: hour 10 (positions + raw) and hour 14 (raw only)
        assert_eq!(cells.len(), 2);

        // Hour 10: 2 aircraft, 2 position msgs, 3 raw msgs
        let h10 = cells.iter().find(|c| c.hour == 10).unwrap();
        assert_eq!(h10.aircraft_count, 2);
        assert_eq!(h10.message_count, 2);
        assert_eq!(h10.raw_message_count, 3);

        // Hour 14: 0 aircraft, 0 position msgs, 1 raw msg (from FULL OUTER JOIN)
        let h14 = cells.iter().find(|c| c.hour == 14).unwrap();
        assert_eq!(h14.aircraft_count, 0);
        assert_eq!(h14.message_count, 0);
        assert_eq!(h14.raw_message_count, 1);
    }

    // --- Raw messages tests ---

    fn sample_raw_record(hex: &str, msg_type: &str, trans: Option<u8>, ts: &str) -> RawSbsRecord {
        RawSbsRecord {
            hex_ident: hex.to_string(),
            msg_type: msg_type.to_string(),
            transmission_type: trans,
            timestamp: ts.to_string(),
            timestamp_ms: 0,
            raw_message: format!("MSG,{},{}", trans.unwrap_or(0), hex),
            source_id: String::new(),
        }
    }

    #[test]
    fn test_insert_raw_batch_and_count() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let records = vec![
            sample_raw_record("A1B2C3", "MSG,3", Some(3), "2024/01/15 10:30:00.000"),
            sample_raw_record("A1B2C3", "MSG,1", Some(1), "2024/01/15 10:30:01.000"),
            sample_raw_record("D4E5F6", "MSG,3", Some(3), "2024/01/15 10:30:02.000"),
        ];
        handle.insert_raw_batch_sync(&records, "UTC").unwrap();
        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.raw_message_count, 3);
    }

    #[test]
    fn test_insert_raw_batch_empty() {
        let handle = StorageHandle::open(test_config()).unwrap();
        handle.insert_raw_batch_sync(&[], "UTC").unwrap();
        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.raw_message_count, 0);
    }

    #[test]
    fn test_query_raw_messages_by_hex_and_time() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let records = vec![
            sample_raw_record("A1B2C3", "MSG,3", Some(3), "2024/01/15 10:30:00.000"),
            sample_raw_record("A1B2C3", "MSG,1", Some(1), "2024/01/15 10:30:01.000"),
            sample_raw_record("D4E5F6", "MSG,3", Some(3), "2024/01/15 10:30:02.000"),
        ];
        handle.insert_raw_batch_sync(&records, "UTC").unwrap();

        let results = handle
            .query_raw_messages_sync(RawMessageQuery {
                hex_ident: "A1B2C3".to_string(),
                start_ms: 0,
                end_ms: i64::MAX,
            })
            .unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.hex_ident == "A1B2C3"));
    }

    #[test]
    fn test_query_raw_messages_respects_time_bounds() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let records = vec![
            sample_raw_record("A1B2C3", "MSG,3", Some(3), "2024/01/15 10:00:00.000"),
            sample_raw_record("A1B2C3", "MSG,3", Some(3), "2024/01/15 11:00:00.000"),
            sample_raw_record("A1B2C3", "MSG,3", Some(3), "2024/01/15 12:00:00.000"),
        ];
        handle.insert_raw_batch_sync(&records, "UTC").unwrap();

        let start = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "UTC");
        let end = parse_timestamp_to_ms("2024/01/15 11:30:00.000", "UTC");

        let results = handle
            .query_raw_messages_sync(RawMessageQuery {
                hex_ident: "A1B2C3".to_string(),
                start_ms: start,
                end_ms: end,
            })
            .unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_stats_includes_raw_count() {
        let handle = StorageHandle::open(test_config()).unwrap();

        // Initially zero
        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.raw_message_count, 0);

        // Insert some raw records
        let records = vec![
            sample_raw_record("A1B2C3", "MSG,3", Some(3), "2024/01/15 10:30:00.000"),
            sample_raw_record("D4E5F6", "MSG,1", Some(1), "2024/01/15 10:30:01.000"),
        ];
        handle.insert_raw_batch_sync(&records, "UTC").unwrap();

        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.raw_message_count, 2);
        // Position count should still be zero
        assert_eq!(stats.row_count, 0);
    }

    #[test]
    fn test_get_raw_message_count_no_filter() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let records = vec![
            sample_raw_record("A1B2C3", "MSG,3", Some(3), "2024/01/15 10:30:00.000"),
            sample_raw_record("A1B2C3", "MSG,1", Some(1), "2024/01/15 10:30:01.000"),
            sample_raw_record("D4E5F6", "MSG,3", Some(3), "2024/01/15 10:30:02.000"),
        ];
        handle.insert_raw_batch_sync(&records, "UTC").unwrap();
        let count = handle.get_raw_message_count_sync(None, None).unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_get_raw_message_count_with_time_range() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let records = vec![
            sample_raw_record("A1B2C3", "MSG,3", Some(3), "2024/01/15 10:00:00.000"),
            sample_raw_record("A1B2C3", "MSG,1", Some(1), "2024/01/15 11:00:00.000"),
            sample_raw_record("D4E5F6", "MSG,3", Some(3), "2024/01/15 12:00:00.000"),
        ];
        handle.insert_raw_batch_sync(&records, "UTC").unwrap();

        let start = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "UTC");
        let end = parse_timestamp_to_ms("2024/01/15 11:30:00.000", "UTC");

        let count = handle
            .get_raw_message_count_sync(Some(start), Some(end))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_get_raw_message_count_empty() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let count = handle.get_raw_message_count_sync(None, None).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_time_distribution_aircraft_metric() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Two positions for aircraft A1, one for A2 — all in same bucket
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A1", Some(45.6), Some(-73.6), "2024/01/15 10:00:10.000"),
            sample_position("A2", Some(45.7), Some(-73.7), "2024/01/15 10:00:20.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let ts_start = parse_timestamp_to_ms("2024/01/15 09:00:00.000", "UTC");
        let ts_end = parse_timestamp_to_ms("2024/01/15 11:00:00.000", "UTC");

        // Positions metric: should count 3
        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: ts_start,
                end_ms: ts_end,
                num_buckets: 1,
                metric: crate::types::TimeDistributionMetric::Positions,
            })
            .unwrap();
        let total: u64 = buckets.iter().map(|b| b.count).sum();
        assert_eq!(total, 3);

        // Aircraft metric: should count 2 distinct hex_ident values
        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: ts_start,
                end_ms: ts_end,
                num_buckets: 1,
                metric: crate::types::TimeDistributionMetric::Aircraft,
            })
            .unwrap();
        let total: u64 = buckets.iter().map(|b| b.count).sum();
        assert_eq!(total, 2);
    }

    #[test]
    fn test_time_distribution_raw_messages_metric() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Insert raw messages (these go to raw_messages table, not positions)
        let records = vec![
            sample_raw_record("A1", "MSG,1", Some(1), "2024/01/15 10:00:00.000"),
            sample_raw_record("A1", "MSG,3", Some(3), "2024/01/15 10:00:10.000"),
            sample_raw_record("A2", "MSG,3", Some(3), "2024/01/15 10:00:20.000"),
            sample_raw_record("A2", "MSG,4", Some(4), "2024/01/15 10:00:30.000"),
        ];
        handle.insert_raw_batch_sync(&records, "UTC").unwrap();

        let ts_start = parse_timestamp_to_ms("2024/01/15 09:00:00.000", "UTC");
        let ts_end = parse_timestamp_to_ms("2024/01/15 11:00:00.000", "UTC");

        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: ts_start,
                end_ms: ts_end,
                num_buckets: 1,
                metric: crate::types::TimeDistributionMetric::RawMessages,
            })
            .unwrap();
        let total: u64 = buckets.iter().map(|b| b.count).sum();
        assert_eq!(total, 4);
    }

    #[test]
    fn test_time_distribution_default_metric_is_positions() {
        // Verify serde default: omitting metric field should give Positions
        let json = r#"{"start_ms": 0, "end_ms": 1000, "num_buckets": 10}"#;
        let query: crate::types::TimeDistributionQuery = serde_json::from_str(json).unwrap();
        assert_eq!(
            query.metric,
            crate::types::TimeDistributionMetric::Positions
        );
    }

    // --- Checkpoint tests ---

    #[test]
    fn test_checkpoint_on_in_memory_db() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Insert some data so there's something to checkpoint
        let positions = vec![sample_position(
            "A1B2C3",
            Some(45.5),
            Some(-73.5),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();
        // Should not error even on in-memory DB
        handle.checkpoint_sync().unwrap();
    }

    #[test]
    fn test_checkpoint_on_file_backed_db() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let config = StorageConfig {
            db_path: Some(db_path),
            source_id: "test".to_string(),
            gap_threshold_ms: 3_600_000,
        };
        let handle = StorageHandle::open(config).unwrap();
        let positions = vec![sample_position(
            "A1B2C3",
            Some(45.5),
            Some(-73.5),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();
        handle.checkpoint_sync().unwrap();
        // Data still accessible after checkpoint
        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 1);
    }

    // --- Export database tests ---

    #[test]
    fn test_export_database_creates_valid_copy() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Insert positions
        let positions = vec![
            sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("D4E5F6", Some(46.0), Some(-74.0), "2024/01/15 10:31:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        // Insert raw messages
        let raw_records = vec![crate::types::RawSbsRecord {
            hex_ident: "A1B2C3".to_string(),
            msg_type: "MSG".to_string(),
            transmission_type: Some(3),
            timestamp: "2024/01/15 10:30:00.000".to_string(),
            timestamp_ms: 0,
            raw_message: "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,,,45.5,-73.5,35000,,,,,,0"
                .to_string(),
            source_id: String::new(),
        }];
        handle.insert_raw_batch_sync(&raw_records, "UTC").unwrap();

        // Export to a temp file
        let dir = tempfile::tempdir().unwrap();
        let export_path = dir.path().join("export.db");
        handle.export_database_sync(&export_path).unwrap();

        // Open exported DB and verify
        assert!(export_path.exists());
        let exported = Connection::open(&export_path).unwrap();

        let pos_count: i64 = exported
            .query_row("SELECT COUNT(*) FROM positions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pos_count, 2);

        let raw_count: i64 = exported
            .query_row("SELECT COUNT(*) FROM raw_messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(raw_count, 1);
    }

    #[test]
    fn test_export_database_overwrites_existing() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let positions = vec![sample_position(
            "A1B2C3",
            Some(45.5),
            Some(-73.5),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let export_path = dir.path().join("export.db");

        // Export once
        handle.export_database_sync(&export_path).unwrap();
        // Export again — should overwrite without error
        handle.export_database_sync(&export_path).unwrap();

        let exported = Connection::open(&export_path).unwrap();
        let pos_count: i64 = exported
            .query_row("SELECT COUNT(*) FROM positions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pos_count, 1);
    }

    #[test]
    fn test_export_database_creates_parent_dirs() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let positions = vec![sample_position(
            "A1B2C3",
            Some(45.5),
            Some(-73.5),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let export_path = dir.path().join("nested").join("dir").join("export.db");

        handle.export_database_sync(&export_path).unwrap();
        assert!(export_path.exists());
    }

    #[test]
    fn test_export_database_original_still_works() {
        let handle = StorageHandle::open(test_config()).unwrap();
        let positions = vec![sample_position(
            "A1B2C3",
            Some(45.5),
            Some(-73.5),
            "2024/01/15 10:30:00.000",
        )];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let export_path = dir.path().join("export.db");
        handle.export_database_sync(&export_path).unwrap();

        // Original DB still works — can insert and query after export
        let more = vec![sample_position(
            "D4E5F6",
            Some(46.0),
            Some(-74.0),
            "2024/01/15 10:31:00.000",
        )];
        handle.insert_batch_sync(&more, "UTC").unwrap();
        let stats = handle.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 2);
    }

    // --- move_database_to_snapshot tests ---

    #[test]
    fn test_move_database_to_snapshot_renames_file() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        std::fs::write(&db_path, b"data").unwrap();

        let snapshot_path = dir.path().join("test_snapshot.db");
        move_database_to_snapshot(&db_path, &snapshot_path).unwrap();

        assert!(!db_path.exists());
        assert!(snapshot_path.exists());
        assert_eq!(std::fs::read(&snapshot_path).unwrap(), b"data");
    }

    #[test]
    fn test_move_database_to_snapshot_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        std::fs::write(&db_path, b"data").unwrap();

        let snapshot_path = dir.path().join("snapshots").join("nested").join("test.db");
        move_database_to_snapshot(&db_path, &snapshot_path).unwrap();

        assert!(!db_path.exists());
        assert!(snapshot_path.exists());
    }

    #[test]
    fn test_move_database_to_snapshot_moves_wal_file() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let wal_path = dir.path().join("test.db.wal");
        std::fs::write(&db_path, b"data").unwrap();
        std::fs::write(&wal_path, b"wal-data").unwrap();

        let snapshot_path = dir.path().join("snapshot.db");
        move_database_to_snapshot(&db_path, &snapshot_path).unwrap();

        assert!(!db_path.exists());
        assert!(!wal_path.exists());
        assert!(snapshot_path.exists());
        let wal_snapshot = dir.path().join("snapshot.db.wal");
        assert!(wal_snapshot.exists());
        assert_eq!(std::fs::read(&wal_snapshot).unwrap(), b"wal-data");
    }

    #[test]
    fn test_move_database_to_snapshot_missing_source_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("nonexistent.db");
        let snapshot_path = dir.path().join("snapshot.db");

        let result = move_database_to_snapshot(&db_path, &snapshot_path);
        assert!(result.is_err());
    }

    // --- Import database tests ---

    /// Helper: create an exported DB file with given positions and raw messages.
    fn create_export_db(
        positions: &[AircraftPosition],
        raw_records: &[crate::types::RawSbsRecord],
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let source = StorageHandle::open(test_config()).unwrap();
        if !positions.is_empty() {
            source.insert_batch_sync(positions, "UTC").unwrap();
        }
        if !raw_records.is_empty() {
            source.insert_raw_batch_sync(raw_records, "UTC").unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.db");
        source.export_database_sync(&path).unwrap();
        (dir, path)
    }

    #[test]
    fn test_preview_import_valid_db() {
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(46.0), Some(-74.0), "2024/01/15 11:00:00.000"),
        ];
        let raw = vec![sample_raw_record(
            "A1",
            "MSG,3",
            Some(3),
            "2024/01/15 10:00:00.000",
        )];
        let (_dir, path) = create_export_db(&positions, &raw);

        let target = StorageHandle::open(test_config()).unwrap();
        let preview = target.preview_import_sync(&path).unwrap();

        assert_eq!(preview.positions.row_count, 2);
        assert!(preview.positions.oldest_timestamp_ms.is_some());
        assert!(preview.positions.newest_timestamp_ms.is_some());
        assert_eq!(preview.raw_messages.row_count, 1);
    }

    #[test]
    fn test_preview_import_missing_tables() {
        // Create an empty DuckDB file with no tables
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.db");
        let conn = Connection::open(&path).unwrap();
        drop(conn);

        let target = StorageHandle::open(test_config()).unwrap();
        let preview = target.preview_import_sync(&path).unwrap();

        assert_eq!(preview.positions.row_count, 0);
        assert!(preview.positions.oldest_timestamp_ms.is_none());
        assert_eq!(preview.raw_messages.row_count, 0);
    }

    #[test]
    fn test_preview_import_nonexistent_file() {
        let target = StorageHandle::open(test_config()).unwrap();
        let result = target.preview_import_sync(std::path::Path::new("/nonexistent/path.db"));
        assert!(result.is_err());
    }

    #[test]
    fn test_import_inserts_new_records() {
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(46.0), Some(-74.0), "2024/01/15 11:00:00.000"),
            sample_position("A3", Some(47.0), Some(-75.0), "2024/01/15 12:00:00.000"),
        ];
        let raw = vec![
            sample_raw_record("A1", "MSG,3", Some(3), "2024/01/15 10:00:00.000"),
            sample_raw_record("A2", "MSG,1", Some(1), "2024/01/15 11:00:00.000"),
        ];
        let (_dir, path) = create_export_db(&positions, &raw);

        // Empty target DB
        let target = StorageHandle::open(test_config()).unwrap();
        let result = target.import_database_sync(&path).unwrap();

        assert_eq!(result.positions_imported, 3);
        assert_eq!(result.raw_messages_imported, 2);

        let stats = target.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 3);
        assert_eq!(stats.raw_message_count, 2);
    }

    #[test]
    fn test_import_deduplicates_positions() {
        // Source DB has 3 positions
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A2", Some(46.0), Some(-74.0), "2024/01/15 11:00:00.000"),
            sample_position("A3", Some(47.0), Some(-75.0), "2024/01/15 12:00:00.000"),
        ];
        let (_dir, path) = create_export_db(&positions, &[]);

        // Target already has one overlapping position (A1 at same timestamp)
        let target = StorageHandle::open(test_config()).unwrap();
        target
            .insert_batch_sync(
                &[sample_position(
                    "A1",
                    Some(45.5),
                    Some(-73.5),
                    "2024/01/15 10:00:00.000",
                )],
                "UTC",
            )
            .unwrap();

        let result = target.import_database_sync(&path).unwrap();

        // Only A2 and A3 should be imported (A1 is duplicate)
        assert_eq!(result.positions_imported, 2);

        let stats = target.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 3); // 1 existing + 2 imported
    }

    #[test]
    fn test_import_deduplicates_raw_messages() {
        let raw = vec![
            sample_raw_record("A1", "MSG,3", Some(3), "2024/01/15 10:00:00.000"),
            sample_raw_record("A2", "MSG,1", Some(1), "2024/01/15 11:00:00.000"),
        ];
        let (_dir, path) = create_export_db(&[], &raw);

        // Target already has the A1 raw message
        let target = StorageHandle::open(test_config()).unwrap();
        target
            .insert_raw_batch_sync(
                &[sample_raw_record(
                    "A1",
                    "MSG,3",
                    Some(3),
                    "2024/01/15 10:00:00.000",
                )],
                "UTC",
            )
            .unwrap();

        let result = target.import_database_sync(&path).unwrap();

        assert_eq!(result.raw_messages_imported, 1); // only A2
        let stats = target.get_stats_sync().unwrap();
        assert_eq!(stats.raw_message_count, 2); // 1 existing + 1 imported
    }

    #[test]
    fn test_import_missing_source_tables() {
        // Create an empty DuckDB file with no tables
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.db");
        let conn = Connection::open(&path).unwrap();
        drop(conn);

        let target = StorageHandle::open(test_config()).unwrap();
        let result = target.import_database_sync(&path).unwrap();

        assert_eq!(result.positions_imported, 0);
        assert_eq!(result.raw_messages_imported, 0);
    }

    #[test]
    fn test_import_current_db_still_works() {
        let positions = vec![sample_position(
            "A1",
            Some(45.5),
            Some(-73.5),
            "2024/01/15 10:00:00.000",
        )];
        let (_dir, path) = create_export_db(&positions, &[]);

        let target = StorageHandle::open(test_config()).unwrap();
        target.import_database_sync(&path).unwrap();

        // Can still insert and query after import
        let more = vec![sample_position(
            "B1",
            Some(48.0),
            Some(-76.0),
            "2024/01/15 13:00:00.000",
        )];
        target.insert_batch_sync(&more, "UTC").unwrap();

        let stats = target.get_stats_sync().unwrap();
        assert_eq!(stats.row_count, 2); // 1 imported + 1 new
    }

    // --- Flight summary tests ---

    /// Helper: insert a position with a specific hex, callsign, altitude, and timestamp_ms.
    /// Also updates the flights table and in-memory tracker (mirrors insert_batch_sync).
    fn insert_position(
        handle: &StorageHandle,
        hex: &str,
        callsign: Option<&str>,
        altitude: Option<f64>,
        ts_ms: i64,
    ) {
        let mut storage = handle.inner.lock().unwrap();
        storage
            .conn
            .execute(
                "INSERT INTO positions (hex_ident, callsign, latitude, longitude, altitude, timestamp_ms, source_id)
                 VALUES (?, ?, 48.0, 2.0, ?, ?, 'test')",
                params![hex, callsign, altitude, ts_ms],
            )
            .unwrap();

        // Update flights table incrementally (same logic as insert_batch_sync)
        let gap_threshold = storage.gap_threshold_ms;
        match storage.flight_tracker.get(hex) {
            Some(active) if (ts_ms - active.last_seen_ms) <= gap_threshold => {
                let fid = active.flight_id.clone();
                storage
                    .conn
                    .execute(
                        "UPDATE flights SET
                            last_seen_ms = GREATEST(last_seen_ms, ?),
                            position_count = position_count + 1,
                            callsign = COALESCE(?, callsign),
                            min_altitude = LEAST(COALESCE(min_altitude, ?), COALESCE(?, min_altitude)),
                            max_altitude = GREATEST(COALESCE(max_altitude, ?), COALESCE(?, max_altitude))
                         WHERE flight_id = ?",
                        params![ts_ms, callsign, altitude, altitude, altitude, altitude, fid],
                    )
                    .unwrap();
                let active_mut = storage.flight_tracker.get_mut(hex).unwrap();
                active_mut.last_seen_ms = ts_ms;
            }
            _ => {
                let flight_num = match storage.flight_tracker.get(hex) {
                    Some(active) => active.flight_num + 1,
                    None => 0,
                };
                let flight_id = format!("{}_{}", hex, flight_num);
                storage
                    .conn
                    .execute(
                        "INSERT INTO flights (flight_id, hex_ident, flight_num, callsign,
                                              position_count, first_seen_ms, last_seen_ms,
                                              min_altitude, max_altitude)
                         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
                        params![
                            flight_id, hex, flight_num, callsign, ts_ms, ts_ms, altitude, altitude
                        ],
                    )
                    .unwrap();
                storage.flight_tracker.insert(
                    hex.to_string(),
                    ActiveFlight {
                        flight_id,
                        flight_num,
                        last_seen_ms: ts_ms,
                    },
                );
            }
        }
    }

    #[test]
    fn test_flight_summary_single_flight() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // 3 positions 10 minutes apart — well within 1h threshold
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(35000.0), 1000);
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(36000.0), 601_000); // +10min
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(37000.0), 1_201_000); // +10min

        let query = FlightSummaryQuery {
            start_ms: None,
            end_ms: None,
        };
        let flights = handle.get_flight_summary_sync(&query).unwrap();
        assert_eq!(flights.len(), 1);
        assert_eq!(flights[0].hex_ident, "A1B2C3");
        assert_eq!(flights[0].flight_num, 0);
        assert_eq!(flights[0].position_count, 3);
    }

    #[test]
    fn test_flight_summary_gap_splits_flights() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Flight 1: two positions close together
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(35000.0), 1000);
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(36000.0), 601_000);
        // Flight 2: 2 hours later (gap > 1h threshold)
        let gap = 3_600_000 + 1; // just over 1h
        insert_position(
            &handle,
            "A1B2C3",
            Some("FLT200"),
            Some(10000.0),
            601_000 + gap,
        );
        insert_position(
            &handle,
            "A1B2C3",
            Some("FLT200"),
            Some(11000.0),
            601_000 + gap + 60_000,
        );

        let query = FlightSummaryQuery {
            start_ms: None,
            end_ms: None,
        };
        let flights = handle.get_flight_summary_sync(&query).unwrap();
        assert_eq!(flights.len(), 2);

        // Ordered by last_seen DESC, so flight 2 (later) comes first
        assert_eq!(flights[0].flight_num, 1);
        assert_eq!(flights[0].first_seen_ms, 601_000 + gap);
        assert_eq!(flights[0].position_count, 2);

        assert_eq!(flights[1].flight_num, 0);
        assert_eq!(flights[1].first_seen_ms, 1000);
        assert_eq!(flights[1].position_count, 2);
    }

    #[test]
    fn test_flight_summary_callsign_per_flight() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Flight 0 has callsign "FLT100"
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(35000.0), 1000);
        // Flight 1 (after gap) has callsign "FLT200"
        insert_position(&handle, "A1B2C3", Some("FLT200"), Some(10000.0), 3_700_000);

        let query = FlightSummaryQuery {
            start_ms: None,
            end_ms: None,
        };
        let flights = handle.get_flight_summary_sync(&query).unwrap();
        assert_eq!(flights.len(), 2);

        // Ordered by last_seen DESC
        assert_eq!(flights[0].callsign.as_deref(), Some("FLT200"));
        assert_eq!(flights[1].callsign.as_deref(), Some("FLT100"));
    }

    #[test]
    fn test_flight_summary_multiple_aircraft() {
        let handle = StorageHandle::open(test_config()).unwrap();
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(35000.0), 1000);
        insert_position(&handle, "D4E5F6", Some("FLT200"), Some(20000.0), 2000);

        let query = FlightSummaryQuery {
            start_ms: None,
            end_ms: None,
        };
        let flights = handle.get_flight_summary_sync(&query).unwrap();
        assert!(flights.len() >= 2);
        // Both hex_idents present
        let hexes: Vec<&str> = flights.iter().map(|f| f.hex_ident.as_str()).collect();
        assert!(hexes.contains(&"A1B2C3"));
        assert!(hexes.contains(&"D4E5F6"));
        // Ordered by last_seen DESC
        assert_eq!(flights[0].last_seen_ms, 2000);
    }

    #[test]
    fn test_flight_summary_time_filter() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // Flight A: spans 1000–10000ms (3 positions, single flight within 1h gap)
        insert_position(&handle, "A1B2C3", Some("A"), Some(35000.0), 1000);
        insert_position(&handle, "A1B2C3", Some("A"), Some(36000.0), 5000);
        insert_position(&handle, "A1B2C3", Some("A"), Some(37000.0), 10_000);
        // Flight B: completely outside query window
        insert_position(&handle, "D4E5F6", Some("B"), Some(20000.0), 20_000);

        // Query window 3000–15000: overlaps flight A, excludes flight B
        let query = FlightSummaryQuery {
            start_ms: Some(3000),
            end_ms: Some(15_000),
        };
        let flights = handle.get_flight_summary_sync(&query).unwrap();
        assert_eq!(flights.len(), 1);
        // Returns the full pre-computed flight (all 3 positions)
        assert_eq!(flights[0].hex_ident, "A1B2C3");
        assert_eq!(flights[0].position_count, 3);
        assert_eq!(flights[0].first_seen_ms, 1000);
        assert_eq!(flights[0].last_seen_ms, 10_000);
    }

    #[test]
    fn test_flight_summary_custom_threshold() {
        // With 15-minute threshold, a 30min gap splits into 2 flights
        let config = StorageConfig {
            db_path: None,
            source_id: "test".to_string(),
            gap_threshold_ms: 900_000, // 15 minutes
        };
        let handle = StorageHandle::open(config).unwrap();
        // 3 positions: gap between 2nd and 3rd is 30 minutes
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(35000.0), 0);
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(36000.0), 60_000); // +1 min
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(37000.0), 1_860_000); // +30 min later

        let query = FlightSummaryQuery {
            start_ms: None,
            end_ms: None,
        };
        let flights = handle.get_flight_summary_sync(&query).unwrap();
        assert_eq!(flights.len(), 2); // 30min gap > 15min threshold
    }

    #[test]
    fn test_flight_summary_flight_id_format() {
        let handle = StorageHandle::open(test_config()).unwrap();
        insert_position(&handle, "A1B2C3", Some("FLT100"), Some(35000.0), 1000);
        // second flight after gap
        insert_position(&handle, "A1B2C3", Some("FLT200"), Some(10000.0), 3_700_000);

        let query = FlightSummaryQuery {
            start_ms: None,
            end_ms: None,
        };
        let flights = handle.get_flight_summary_sync(&query).unwrap();
        assert_eq!(flights.len(), 2);

        // Check flight_id format: "{hex_ident}_{flight_num}"
        let ids: Vec<&str> = flights.iter().map(|f| f.flight_id.as_str()).collect();
        assert!(ids.contains(&"A1B2C3_0"));
        assert!(ids.contains(&"A1B2C3_1"));
    }

    #[test]
    fn test_insert_batch_aggregates_flight_updates() {
        let handle = StorageHandle::open(test_config()).unwrap();

        // Build 5 positions for the same hex with varying altitudes
        let positions: Vec<AircraftPosition> = vec![
            AircraftPosition {
                hex_ident: "AAA111".to_string(),
                callsign: Some("FLT1".to_string()),
                altitude: Some(100.0),
                latitude: Some(48.0),
                longitude: Some(2.0),
                ground_speed: None,
                track: None,
                vertical_rate: None,
                squawk: None,
                is_on_ground: None,
                timestamp: "2024/01/15,10:00:00.000".to_string(),
                message_count: 0,
            },
            AircraftPosition {
                hex_ident: "AAA111".to_string(),
                callsign: Some("FLT1".to_string()),
                altitude: Some(200.0),
                latitude: Some(48.1),
                longitude: Some(2.1),
                ground_speed: None,
                track: None,
                vertical_rate: None,
                squawk: None,
                is_on_ground: None,
                timestamp: "2024/01/15,10:00:01.000".to_string(),
                message_count: 0,
            },
            AircraftPosition {
                hex_ident: "AAA111".to_string(),
                callsign: Some("FLT1".to_string()),
                altitude: Some(50.0),
                latitude: Some(48.2),
                longitude: Some(2.2),
                ground_speed: None,
                track: None,
                vertical_rate: None,
                squawk: None,
                is_on_ground: None,
                timestamp: "2024/01/15,10:00:02.000".to_string(),
                message_count: 0,
            },
            AircraftPosition {
                hex_ident: "AAA111".to_string(),
                callsign: Some("FLT1".to_string()),
                altitude: Some(300.0),
                latitude: Some(48.3),
                longitude: Some(2.3),
                ground_speed: None,
                track: None,
                vertical_rate: None,
                squawk: None,
                is_on_ground: None,
                timestamp: "2024/01/15,10:00:03.000".to_string(),
                message_count: 0,
            },
            AircraftPosition {
                hex_ident: "AAA111".to_string(),
                callsign: Some("FLT1".to_string()),
                altitude: Some(150.0),
                latitude: Some(48.4),
                longitude: Some(2.4),
                ground_speed: None,
                track: None,
                vertical_rate: None,
                squawk: None,
                is_on_ground: None,
                timestamp: "2024/01/15,10:00:04.000".to_string(),
                message_count: 0,
            },
        ];

        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let query = FlightSummaryQuery {
            start_ms: None,
            end_ms: None,
        };
        let flights = handle.get_flight_summary_sync(&query).unwrap();
        assert_eq!(flights.len(), 1);
        assert_eq!(flights[0].hex_ident, "AAA111");
        assert_eq!(flights[0].position_count, 5);
        assert_eq!(flights[0].min_altitude, Some(50.0));
        assert_eq!(flights[0].max_altitude, Some(300.0));
    }

    // --- Flights metric in time distribution ---

    #[test]
    fn test_time_distribution_flights_metric() {
        let handle = StorageHandle::open(test_config()).unwrap();
        // A1: flight spanning 10:00–10:50 (positions at 10:00 and 10:50)
        // A2: flight at 10:00 only (single position)
        // Query range: 09:00–11:00 with 4 buckets → 30-min buckets
        // Bucket 0: 09:00–09:30 → no flights
        // Bucket 1: 09:30–10:00 → no flights (10:00:00 falls in bucket 2)
        // Bucket 2: 10:00–10:30 → A1 active (started here), A2 active = 2 flights
        // Bucket 3: 10:30–11:00 → A1 still active (ends 10:50) = 1 flight
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A1", Some(45.6), Some(-73.6), "2024/01/15 10:50:00.000"),
            sample_position("A2", Some(45.7), Some(-73.7), "2024/01/15 10:00:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let ts_start = parse_timestamp_to_ms("2024/01/15 09:00:00.000", "UTC");
        let ts_end = parse_timestamp_to_ms("2024/01/15 11:00:00.000", "UTC");

        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: ts_start,
                end_ms: ts_end,
                num_buckets: 4,
                metric: crate::types::TimeDistributionMetric::Flights,
            })
            .unwrap();

        // A1's flight spans buckets 2 and 3; A2's flight is in bucket 2 only
        let total: u64 = buckets.iter().map(|b| b.count).sum();
        assert_eq!(total, 3); // 2 in bucket 2 + 1 in bucket 3

        // Verify per-bucket: bucket with A1+A2 has 2, bucket with only A1 has 1
        let counts: Vec<u64> = buckets.iter().map(|b| b.count).collect();
        assert!(counts.contains(&2), "expected a bucket with 2 flights");
        assert!(counts.contains(&1), "expected a bucket with 1 flight");
    }

    #[test]
    fn test_time_distribution_flights_metric_gap_splits() {
        let mut config = test_config();
        config.gap_threshold_ms = 1_800_000; // 30 minutes
        let handle = StorageHandle::open(config).unwrap();

        // A1 has two flights separated by >30min gap
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A1", Some(45.6), Some(-73.6), "2024/01/15 10:10:00.000"),
            // 1-hour gap → new flight
            sample_position("A1", Some(45.7), Some(-73.7), "2024/01/15 11:10:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let ts_start = parse_timestamp_to_ms("2024/01/15 09:00:00.000", "UTC");
        let ts_end = parse_timestamp_to_ms("2024/01/15 12:00:00.000", "UTC");

        let buckets = handle
            .get_time_distribution_sync(crate::types::TimeDistributionQuery {
                start_ms: ts_start,
                end_ms: ts_end,
                num_buckets: 1,
                metric: crate::types::TimeDistributionMetric::Flights,
            })
            .unwrap();
        let total: u64 = buckets.iter().map(|b| b.count).sum();
        assert_eq!(total, 2); // A1 has 2 flights due to gap
    }

    // --- Flight count in heatmap ---

    #[test]
    fn test_hourly_heatmap_includes_flight_count() {
        let handle = StorageHandle::open(test_config()).unwrap();

        // A1: single flight spanning hour 10 and hour 11 (10:30 → 11:15, gap 45min < 1h threshold)
        // A2: flight within hour 10 only (10:15)
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000"),
            sample_position("A1", Some(45.6), Some(-73.6), "2024/01/15 11:15:00.000"),
            sample_position("A2", Some(45.7), Some(-73.7), "2024/01/15 10:15:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let start = parse_timestamp_to_ms("2024/01/15 00:00:00.000", "UTC");
        let end = parse_timestamp_to_ms("2024/01/15 23:59:59.000", "UTC");

        let cells = handle
            .get_hourly_heatmap_sync(crate::types::HourlyHeatmapQuery {
                start_ms: start,
                end_ms: end,
            })
            .unwrap();

        // Hour 10: A1 active (started here) + A2 active → flight_count = 2
        // Hour 11: A1 still active (ends 11:15) → flight_count = 1
        assert_eq!(cells.len(), 2);
        let h10 = cells.iter().find(|c| c.hour == 10).unwrap();
        let h11 = cells.iter().find(|c| c.hour == 11).unwrap();
        assert_eq!(h10.flight_count, 2);
        assert_eq!(h11.flight_count, 1);
        assert_eq!(h10.aircraft_count, 2);
        assert_eq!(h11.aircraft_count, 1);
    }

    // --- Flight count in detection range ---

    #[test]
    fn test_detection_range_includes_flight_count() {
        let handle = StorageHandle::open(test_config()).unwrap();

        // Receiver at (45.0, -73.0). Two aircraft with positions nearby.
        let positions = vec![
            sample_position("A1", Some(45.5), Some(-73.5), "2024/01/15 10:00:00.000"),
            sample_position("A1", Some(45.6), Some(-73.6), "2024/01/15 10:10:00.000"),
            sample_position("A2", Some(45.5), Some(-73.5), "2024/01/15 10:05:00.000"),
        ];
        handle.insert_batch_sync(&positions, "UTC").unwrap();

        let sectors = handle
            .get_detection_range_sync(crate::types::DetectionRangeQuery {
                receiver_lat: 45.0,
                receiver_lon: -73.0,
                start_ms: None,
                end_ms: None,
            })
            .unwrap();

        // All positions should be in the same sector (NW-ish from receiver)
        let active: Vec<_> = sectors.iter().filter(|s| s.position_count > 0).collect();
        assert!(!active.is_empty());
        // The sector with positions should have 2 flights (A1 and A2)
        let sector = active[0];
        assert_eq!(sector.flight_count, 2);
        assert_eq!(sector.position_count, 3);
    }
}
