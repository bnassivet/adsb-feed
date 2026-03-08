//! Domain types for the ADS-B data engine.

use serde::{Deserialize, Serialize};

/// Row returned from DuckDB historical queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionRecord {
    pub hex_ident: String,
    pub callsign: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude: Option<f64>,
    pub ground_speed: Option<f64>,
    pub track: Option<f64>,
    pub vertical_rate: Option<f64>,
    pub squawk: Option<String>,
    pub is_on_ground: Option<bool>,
    pub timestamp_ms: i64,
}

/// Bounding box + time window query parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BboxQuery {
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub limit: usize,
}

/// Single-aircraft trajectory query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrajectoryQuery {
    pub hex_ident: String,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

/// Summary of a single aircraft within a time window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AircraftSummary {
    pub hex_ident: String,
    pub callsign: Option<String>,
    pub position_count: u64,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub min_altitude: Option<f64>,
    pub max_altitude: Option<f64>,
}

/// Storage statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageStats {
    pub row_count: u64,
    pub db_size_bytes: u64,
    pub oldest_timestamp_ms: Option<i64>,
    pub newest_timestamp_ms: Option<i64>,
    pub raw_message_count: u64,
    pub raw_db_size_bytes: u64,
}

/// A single raw SBS-1 message stored for audit/replay purposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawSbsRecord {
    pub hex_ident: String,
    pub msg_type: String,
    pub transmission_type: Option<u8>,
    pub timestamp: String,
    pub timestamp_ms: i64,
    pub raw_message: String,
    pub source_id: String,
}

/// Query parameters for raw message retrieval.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawMessageQuery {
    pub hex_ident: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// A single bucket in a time distribution histogram.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeDistributionBucket {
    pub bucket_ms: i64,
    pub count: u64,
}

/// Query parameters for time distribution (histogram).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeDistributionQuery {
    pub start_ms: i64,
    pub end_ms: i64,
    pub num_buckets: u32,
}

/// Query parameters for detection range analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionRangeQuery {
    pub receiver_lat: f64,
    pub receiver_lon: f64,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

/// A single 10° azimuth sector in the detection range result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionRangeSector {
    /// Center bearing of this sector: 0, 10, 20, ..., 350.
    pub bearing_deg: u16,
    /// Maximum distance detected in this sector (nautical miles).
    pub max_distance_nm: f64,
    /// Number of positions observed in this sector.
    pub position_count: u64,
    /// Minimum altitude observed in this sector (feet), if any.
    pub min_altitude: Option<f64>,
    /// Maximum altitude observed in this sector (feet), if any.
    pub max_altitude: Option<f64>,
}

/// Query parameters for hourly activity heatmap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HourlyHeatmapQuery {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// A single cell in the hourly activity heatmap (one day × one hour).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HourlyHeatmapCell {
    /// Midnight epoch ms of the calendar day (UTC).
    pub day_ms: i64,
    /// Hour of day (0–23).
    pub hour: u8,
    /// Number of distinct aircraft seen in this cell.
    pub aircraft_count: u64,
    /// Total number of position messages in this cell.
    pub message_count: u64,
}

/// Configuration for opening a storage handle.
#[derive(Debug, Clone)]
pub struct StorageConfig {
    /// Path to the DuckDB file. `None` for in-memory (tests).
    pub db_path: Option<std::path::PathBuf>,
    /// Source identifier for this receiver.
    pub source_id: String,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            db_path: None,
            source_id: "unknown".to_string(),
        }
    }
}
