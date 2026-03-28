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
    pub flight_count: u64,
    pub flight_size_bytes: u64,
    pub status_event_count: u64,
    pub event_of_interest_count: u64,
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
    /// Count of distinct flights (from flights table, bucketed by first_seen_ms).
    Flights,
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
    /// Number of distinct flights observed in this sector.
    pub flight_count: u64,
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
    /// Number of distinct flights in this cell.
    pub flight_count: u64,
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

/// Category of status event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusEventType {
    Feed,
    Socket,
    Pulsar,
    Storage,
}

impl std::fmt::Display for StatusEventType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Feed => write!(f, "feed"),
            Self::Socket => write!(f, "socket"),
            Self::Pulsar => write!(f, "pulsar"),
            Self::Storage => write!(f, "storage"),
        }
    }
}

/// Status value within a status event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StatusEventStatus {
    AppStart,
    Started,
    Stopped,
    Connecting,
    Connected,
    Degraded,
    ConnectionLost,
    Disconnected,
    Released,
    Reclaimed,
    Error,
}

impl std::fmt::Display for StatusEventStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AppStart => write!(f, "AppStart"),
            Self::Started => write!(f, "Started"),
            Self::Stopped => write!(f, "Stopped"),
            Self::Connecting => write!(f, "Connecting"),
            Self::Connected => write!(f, "Connected"),
            Self::Degraded => write!(f, "Degraded"),
            Self::ConnectionLost => write!(f, "ConnectionLost"),
            Self::Disconnected => write!(f, "Disconnected"),
            Self::Released => write!(f, "Released"),
            Self::Reclaimed => write!(f, "Reclaimed"),
            Self::Error => write!(f, "Error"),
        }
    }
}

impl std::str::FromStr for StatusEventStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "AppStart" => Ok(Self::AppStart),
            "Started" => Ok(Self::Started),
            "Stopped" => Ok(Self::Stopped),
            "Connecting" => Ok(Self::Connecting),
            "Connected" => Ok(Self::Connected),
            "Degraded" => Ok(Self::Degraded),
            "ConnectionLost" => Ok(Self::ConnectionLost),
            "Disconnected" => Ok(Self::Disconnected),
            "Released" => Ok(Self::Released),
            "Reclaimed" => Ok(Self::Reclaimed),
            "Error" => Ok(Self::Error),
            other => Err(format!("unknown StatusEventStatus: {other}")),
        }
    }
}

impl std::str::FromStr for StatusEventType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "feed" => Ok(Self::Feed),
            "socket" => Ok(Self::Socket),
            "pulsar" => Ok(Self::Pulsar),
            "storage" => Ok(Self::Storage),
            other => Err(format!("unknown StatusEventType: {other}")),
        }
    }
}

/// A status lifecycle event for the audit trail.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusEvent {
    pub timestamp_ms: i64,
    pub event_type: StatusEventType,
    pub status: StatusEventStatus,
    pub detail: Option<String>,
    pub source_id: Option<String>,
}

impl StatusEvent {
    /// Create a new event with the current UTC timestamp.
    pub fn now(event_type: StatusEventType, status: StatusEventStatus) -> Self {
        Self {
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            event_type,
            status,
            detail: None,
            source_id: None,
        }
    }

    /// Builder: attach a detail string.
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Builder: attach a source_id.
    pub fn with_source_id(mut self, id: impl Into<String>) -> Self {
        self.source_id = Some(id.into());
        self
    }
}

/// Query parameters for status event retrieval.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatusEventQuery {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub event_type: Option<StatusEventType>,
    pub limit: Option<usize>,
}

/// A user-created or system-generated event of interest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventOfInterest {
    pub id: String,
    pub title: String,
    pub description: String,
    /// Point-in-time or start of interval (epoch ms).
    pub timestamp_ms: i64,
    /// End of interval (epoch ms). None for point-in-time events.
    pub end_timestamp_ms: Option<i64>,
    /// Point location latitude. None if no point geo reference.
    pub latitude: Option<f64>,
    /// Point location longitude. None if no point geo reference.
    pub longitude: Option<f64>,
    /// Bounding box north. None if no area geo reference.
    pub bbox_north: Option<f64>,
    pub bbox_south: Option<f64>,
    pub bbox_east: Option<f64>,
    pub bbox_west: Option<f64>,
    /// Origin of the event: "user", "detector", "news_feed", etc.
    pub source: String,
    /// Classification: "military", "emergency", "anomaly", "observation", etc.
    pub category: Option<String>,
    /// JSON blob for source-specific data (detection confidence, article URL, etc.)
    pub metadata: Option<String>,
    /// Comma-separated hex_idents of associated aircraft.
    pub linked_hex_idents: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Parameters for creating a new event of interest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEventOfInterest {
    pub title: String,
    pub description: String,
    pub timestamp_ms: i64,
    pub end_timestamp_ms: Option<i64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub bbox_north: Option<f64>,
    pub bbox_south: Option<f64>,
    pub bbox_east: Option<f64>,
    pub bbox_west: Option<f64>,
    /// Defaults to "user" if not provided.
    pub source: Option<String>,
    pub category: Option<String>,
    pub metadata: Option<String>,
    pub linked_hex_idents: Option<String>,
}

/// Parameters for updating an existing event of interest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateEventOfInterest {
    pub id: String,
    pub title: String,
    pub description: String,
    pub timestamp_ms: i64,
    pub end_timestamp_ms: Option<i64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub bbox_north: Option<f64>,
    pub bbox_south: Option<f64>,
    pub bbox_east: Option<f64>,
    pub bbox_west: Option<f64>,
    pub source: Option<String>,
    pub category: Option<String>,
    pub metadata: Option<String>,
    pub linked_hex_idents: Option<String>,
}

/// Query parameters for event of interest retrieval.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EventOfInterestQuery {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// Filter by source (e.g., "user", "detector").
    pub source: Option<String>,
    /// Filter by category (e.g., "military", "emergency").
    pub category: Option<String>,
    pub limit: Option<usize>,
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
