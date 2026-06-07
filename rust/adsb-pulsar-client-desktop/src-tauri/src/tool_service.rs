//! Shared query service for read-only history tools.
//!
//! These free functions take a `&SharedStorage` directly (rather than a
//! `tauri::State`) so they can be called from **both** the `#[tauri::command]`
//! wrappers in `commands.rs` and the localhost agent tool server in
//! `tool_server.rs`. This keeps a single source of truth for the query logic
//! and the graceful "Storage not available" degradation string.

use crate::state::SharedStorage;
use adsb_data_engine::{
    AircraftSummary, EventOfInterest, EventOfInterestQuery, FlightSummary, FlightSummaryQuery,
    HourlyHeatmapCell, HourlyHeatmapQuery, PositionRecord, StorageStats, TimeDistributionBucket,
    TimeDistributionQuery, TrajectoryQuery,
};

/// Returned (and relayed to the agent) when the DuckDB connection is `None`
/// (init failed or the user released it). Mirrors the existing command-layer
/// string so callers behave identically regardless of entry point.
pub const STORAGE_UNAVAILABLE: &str = "Storage not available";

/// Get storage statistics.
pub async fn get_storage_stats(storage: &SharedStorage) -> Result<StorageStats, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.get_stats().await.map_err(|e| e.to_string())
}

/// Get summary of distinct aircraft in a time window.
pub async fn get_aircraft_summary(
    storage: &SharedStorage,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<Vec<AircraftSummary>, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.get_aircraft_summary(start_ms, end_ms)
        .await
        .map_err(|e| e.to_string())
}

/// Get flight-segmented summaries for a time window.
pub async fn get_flight_summary(
    storage: &SharedStorage,
    query: FlightSummaryQuery,
) -> Result<Vec<FlightSummary>, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.get_flight_summary(query).await.map_err(|e| e.to_string())
}

/// Get trajectory for a single aircraft.
pub async fn get_trajectory(
    storage: &SharedStorage,
    query: TrajectoryQuery,
) -> Result<Vec<PositionRecord>, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.get_trajectory(query).await.map_err(|e| e.to_string())
}

/// Get time distribution histogram for a time range.
pub async fn get_time_distribution(
    storage: &SharedStorage,
    query: TimeDistributionQuery,
) -> Result<Vec<TimeDistributionBucket>, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.get_time_distribution(query)
        .await
        .map_err(|e| e.to_string())
}

/// Get hourly activity heatmap grouped by (day, hour).
pub async fn get_hourly_heatmap(
    storage: &SharedStorage,
    query: HourlyHeatmapQuery,
) -> Result<Vec<HourlyHeatmapCell>, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.get_hourly_heatmap(query).await.map_err(|e| e.to_string())
}

/// Query user-created events of interest.
pub async fn get_events_of_interest(
    storage: &SharedStorage,
    query: EventOfInterestQuery,
) -> Result<Vec<EventOfInterest>, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.query_events_of_interest(query)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    /// A `SharedStorage` that is `None` simulates init failure / released state.
    fn empty_storage() -> SharedStorage {
        Arc::new(RwLock::new(None))
    }

    #[tokio::test]
    async fn storage_stats_unavailable_when_none() {
        let storage = empty_storage();
        let err = get_storage_stats(&storage).await.unwrap_err();
        assert_eq!(err, STORAGE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn aircraft_summary_unavailable_when_none() {
        let storage = empty_storage();
        let err = get_aircraft_summary(&storage, None, None)
            .await
            .unwrap_err();
        assert_eq!(err, STORAGE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn trajectory_unavailable_when_none() {
        let storage = empty_storage();
        let query = TrajectoryQuery {
            hex_ident: "ABC123".to_string(),
            start_ms: None,
            end_ms: None,
        };
        let err = get_trajectory(&storage, query).await.unwrap_err();
        assert_eq!(err, STORAGE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn queries_against_real_storage_succeed() {
        // In-memory DuckDB (db_path = None) — exercises the happy path through
        // the service layer end to end.
        let handle = adsb_data_engine::StorageHandle::open(adsb_data_engine::StorageConfig {
            db_path: None,
            source_id: "test".to_string(),
            gap_threshold_ms: 3_600_000,
        })
        .expect("open in-memory storage");
        let storage: SharedStorage = Arc::new(RwLock::new(Some(handle)));

        // Empty DB: stats present, summaries empty — but no error.
        let stats = get_storage_stats(&storage).await.expect("stats");
        assert_eq!(stats.row_count, 0);

        let summary = get_aircraft_summary(&storage, None, None)
            .await
            .expect("summary");
        assert!(summary.is_empty());

        let events = get_events_of_interest(&storage, EventOfInterestQuery::default())
            .await
            .expect("events");
        assert!(events.is_empty());
    }
}
