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

/// Which metric to count in each histogram bucket.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeDistributionMetric {
    /// Count of position rows (default).
    #[default]
    Positions,
    /// Count of distinct aircraft (hex_ident).
    Aircraft,
    /// Count of raw SBS-1 messages.
    RawMessages,
}

/// Query parameters for time distribution (histogram).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TimeDistributionQuery {
    pub start_ms: i64,
    pub end_ms: i64,
    pub num_buckets: u32,
    /// Which metric to histogram. Defaults to `Positions` if absent.
    #[serde(default)]
    pub metric: TimeDistributionMetric,
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
    /// Total number of raw SBS-1 messages in this cell.
    pub raw_message_count: u64,
}

/// Preview of a single table in an external database file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablePreview {
    pub row_count: u64,
    pub oldest_timestamp_ms: Option<i64>,
    pub newest_timestamp_ms: Option<i64>,
}

/// Preview of an external database file before import.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    pub positions: TablePreview,
    pub raw_messages: TablePreview,
}

/// Result of a database import operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub positions_imported: u64,
    pub raw_messages_imported: u64,
}

/// Summary of a single flight segment within a time window.
///
/// A "flight" is defined as a contiguous sequence of positions for the same
/// `hex_ident` where consecutive positions are separated by no more than
/// `gap_threshold_ms`. When a gap exceeds the threshold, a new flight begins.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightSummary {
    pub hex_ident: String,
    /// 0-based flight index per hex_ident within the query window.
    pub flight_num: u32,
    /// Unique identifier: "{hex_ident}_{flight_num}".
    pub flight_id: String,
    pub callsign: Option<String>,
    pub position_count: u64,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub min_altitude: Option<f64>,
    pub max_altitude: Option<f64>,
}

/// Query parameters for flight-segmented summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightSummaryQuery {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

/// Configuration for opening a storage handle.
#[derive(Debug, Clone)]
pub struct StorageConfig {
    /// Path to the DuckDB file. `None` for in-memory (tests).
    pub db_path: Option<std::path::PathBuf>,
    /// Source identifier for this receiver.
    pub source_id: String,
    /// Time gap in milliseconds that separates flights. Default: 3_600_000 (1 hour).
    /// Positions for the same hex_ident separated by more than this gap start a new flight.
    pub gap_threshold_ms: i64,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            db_path: None,
            source_id: "unknown".to_string(),
            gap_threshold_ms: 3_600_000, // 1 hour
        }
    }
}
