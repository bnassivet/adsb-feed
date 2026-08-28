//! Shared query service for read-only history tools.
//!
//! These free functions take a `&SharedStorage` directly (rather than a
//! `tauri::State`) so they can be called from **both** the `#[tauri::command]`
//! wrappers in `commands.rs` and the localhost agent tool server in
//! `tool_server.rs`. This keeps a single source of truth for the query logic
//! and the graceful "Storage not available" degradation string.

use adsb_data_engine::SharedStorage;
use adsb_data_engine::{
    AircraftSummary, EventOfInterest, EventOfInterestQuery, FlightSummary, FlightSummaryQuery,
    HourlyHeatmapCell, HourlyHeatmapQuery, PositionRecord, Scenario, ScenarioWithTracks,
    StorageStats, TimeDistributionBucket, TimeDistributionQuery, TrajectoryQuery,
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

/// List saved simulation scenarios, most recently updated first.
///
/// Read-only, like everything else here: scenario *writes* deliberately go
/// through the CopilotKit frontend tools instead of the agent tool server, so
/// every mutation passes through a UI layer that can confirm it.
pub async fn list_scenarios(storage: &SharedStorage) -> Result<Vec<Scenario>, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.list_scenarios().await.map_err(|e| e.to_string())
}

/// Get one saved scenario together with its tracks.
pub async fn get_scenario(
    storage: &SharedStorage,
    id: String,
) -> Result<ScenarioWithTracks, String> {
    let guard = storage.read().await;
    let s = guard
        .as_ref()
        .ok_or_else(|| STORAGE_UNAVAILABLE.to_string())?;
    s.get_scenario(id).await.map_err(|e| e.to_string())
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
            share: None,
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

        let scenarios = list_scenarios(&storage).await.expect("scenarios");
        assert!(scenarios.is_empty());
    }

    #[tokio::test]
    async fn list_scenarios_unavailable_when_none() {
        let storage = empty_storage();
        let err = list_scenarios(&storage).await.unwrap_err();
        assert_eq!(err, STORAGE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn get_scenario_unavailable_when_none() {
        let storage = empty_storage();
        let err = get_scenario(&storage, "any-id".to_string())
            .await
            .unwrap_err();
        assert_eq!(err, STORAGE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn get_scenario_reports_missing_id_distinctly() {
        // A missing scenario must not be confused with unavailable storage —
        // the UI treats those two cases very differently.
        let handle = adsb_data_engine::StorageHandle::open(adsb_data_engine::StorageConfig {
            db_path: None,
            source_id: "test".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
        })
        .expect("open in-memory storage");
        let storage: SharedStorage = Arc::new(RwLock::new(Some(handle)));

        let err = get_scenario(&storage, "nope".to_string())
            .await
            .unwrap_err();
        assert_ne!(err, STORAGE_UNAVAILABLE);
        assert!(err.contains("Scenario not found"), "got: {err}");
    }

    #[tokio::test]
    async fn scenario_round_trip_through_service_layer() {
        let handle = adsb_data_engine::StorageHandle::open(adsb_data_engine::StorageConfig {
            db_path: None,
            source_id: "test".to_string(),
            gap_threshold_ms: 3_600_000,
            share: None,
        })
        .expect("open in-memory storage");
        let created = handle
            .insert_scenario_sync(&adsb_data_engine::CreateScenario {
                name: "Approach Rush".to_string(),
                ..Default::default()
            })
            .expect("insert scenario");
        let storage: SharedStorage = Arc::new(RwLock::new(Some(handle)));

        let listed = list_scenarios(&storage).await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Approach Rush");

        let fetched = get_scenario(&storage, created.id.clone())
            .await
            .expect("get");
        assert_eq!(fetched.scenario.id, created.id);
        assert!(fetched.tracks.is_empty());
    }
}
