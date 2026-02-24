//! DuckDB storage backend for ADS-B position data.
//!
//! Provides a thread-safe `StorageHandle` that wraps a DuckDB connection
//! and exposes insert/query operations. Uses `spawn_blocking` for all
//! DuckDB operations since `duckdb::Connection` is not `Send`.

use crate::error::StorageError;
use crate::sbs_parser::AircraftPosition;
use crate::types::{
    AircraftSummary, BboxQuery, PositionRecord, StorageConfig, StorageStats, TrajectoryQuery,
};
use duckdb::{params, Connection};
use std::sync::{Arc, Mutex};
use tracing::info;

/// Thread-safe DuckDB handle. Cloneable (Arc internals).
///
/// All public methods are synchronous (`_sync` suffix) at this layer.
/// Async wrappers using `spawn_blocking` are provided as convenience
/// methods without the suffix.
#[derive(Clone)]
pub struct StorageHandle {
    inner: Arc<Mutex<Storage>>,
}

struct Storage {
    conn: Connection,
    source_id: String,
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

        Ok(Self {
            inner: Arc::new(Mutex::new(Storage {
                conn,
                source_id: config.source_id,
            })),
        })
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

        let storage = self
            .inner
            .lock()
            .map_err(|e| StorageError::Query(format!("Lock poisoned: {e}")))?;

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
        }

        appender.flush()?;
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

        // DuckDB database_size() returns a human-readable string for file-backed DBs.
        // For in-memory DBs it returns '0 bytes'. We approximate with row count * avg row size.
        let db_size_bytes = (row_count as u64).saturating_mul(128); // ~128 bytes per row estimate

        Ok(StorageStats {
            row_count: row_count as u64,
            db_size_bytes,
            oldest_timestamp_ms: oldest,
            newest_timestamp_ms: newest,
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

        info!("Pruned {deleted} positions older than {older_than_ms}");
        Ok(deleted as u64)
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
}
