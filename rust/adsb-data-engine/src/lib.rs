//! ADS-B Data Engine — shared storage, query, and parsing crate.
//!
//! This crate provides:
//! - SBS-1 message parsing (`sbs_parser`)
//! - DuckDB storage and query operations (`storage`)
//! - Domain types for positions, queries, and statistics (`types`)

pub mod error;
pub mod geo;
pub mod sbs_parser;
pub mod storage;
pub mod types;

// Re-export primary public API at crate root.
pub use error::StorageError;
pub use sbs_parser::{parse_sbs_message, AircraftPosition};
pub use storage::StorageHandle;
pub use types::{
    AircraftSummary, BboxQuery, DetectionRangeQuery, DetectionRangeSector, PositionRecord,
    StorageConfig, StorageStats, TimeDistributionBucket, TimeDistributionQuery, TrajectoryQuery,
};
