//! ADS-B Data Engine — shared storage, query, and parsing crate.
//!
//! This crate provides:
//! - SBS-1 message parsing (`sbs_parser`)
//! - DuckDB storage and query operations (`storage`)
//! - Domain types for positions, queries, and statistics (`types`)

pub mod error;
pub mod geo;
pub mod ingest;
pub mod sbs_parser;
pub mod share;
pub mod storage;
pub mod types;

// Re-export primary public API at crate root.
pub use error::StorageError;
pub use ingest::{
    BatchSink, IngestConfig, IngestPipeline, NoopSink, SharedStorage, merge_into_buffer,
};
pub use sbs_parser::{
    AircraftPosition, extract_sbs_timestamp, parse_sbs_message, parse_sbs_raw_fields,
};
pub use storage::{StorageHandle, move_database_to_snapshot};
pub use types::{
    AircraftSummary, BboxQuery, CreateEventOfInterest, CreateScenario, CreateScenarioTrack,
    DetectionRangeQuery, DetectionRangeSector, EventOfInterest, EventOfInterestQuery,
    FlightSummary, FlightSummaryQuery, HourlyHeatmapCell, HourlyHeatmapQuery, ImportPreview,
    ImportResult, PositionRecord, RawMessageQuery, RawSbsRecord, Scenario, ScenarioTrack,
    ScenarioWithTracks, ShareConfig, ShareInfo, ShareStatus, StatusEvent, StatusEventQuery,
    StatusEventStatus, StatusEventType, StorageConfig, StorageStats, TablePreview,
    TimeDistributionBucket, TimeDistributionMetric, TimeDistributionQuery, TrajectoryQuery,
    UpdateEventOfInterest, UpdateScenario, UpdateScenarioTrack,
};
