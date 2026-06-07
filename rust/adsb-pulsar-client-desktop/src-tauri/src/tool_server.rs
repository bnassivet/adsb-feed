//! Localhost HTTP tool server for the Python LangGraph agent.
//!
//! Exposes the read-only history tools (the DuckDB-backed data plane) over a
//! loopback-only HTTP endpoint so the server-side ReAct loop in the Python
//! agent can chain queries internally — without round-tripping each hop back
//! through the frontend.
//!
//! Only **read-only** data tools live here. UI side-effect tools
//! (`panMapTo`, `selectAircraft`, …) and sensitive mutating tools
//! (`startFeed`, `createEventOfInterest`, …) remain client-executed via AG-UI
//! forwarding, so they stay under user-in-the-loop control and are never
//! reachable from this endpoint.
//!
//! Wire contract: `POST /tools/{name}` with a JSON args body whose field names
//! match the `adsb-data-engine` query structs (snake_case). The response is
//! always `{ "ok": true, "data": <result> }` or
//! `{ "ok": false, "error": "<message>" }`.

use crate::state::SharedStorage;
use crate::tool_service;
use adsb_data_engine::{
    EventOfInterestQuery, FlightSummaryQuery, HourlyHeatmapQuery, TimeDistributionQuery,
    TrajectoryQuery,
};
use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{info, warn};

/// Args for `getAircraftSummary` / `getFlightSummary` — both take an optional
/// time window only.
#[derive(Debug, Default, Deserialize)]
struct TimeWindowArgs {
    #[serde(default)]
    start_ms: Option<i64>,
    #[serde(default)]
    end_ms: Option<i64>,
}

/// Dispatch a tool call to the shared service layer and wrap the result in the
/// `{ ok, data | error }` envelope.
///
/// Kept separate from the HTTP layer so it can be unit-tested directly without
/// binding a socket. Unknown tool names and malformed args return an `ok:false`
/// envelope rather than an HTTP error, so the agent can relay a useful message.
pub async fn dispatch(storage: &SharedStorage, name: &str, args: Value) -> Value {
    let result: Result<Value, String> = match name {
        "getStorageStats" => tool_service::get_storage_stats(storage)
            .await
            .and_then(to_value),
        "getAircraftSummary" => match parse::<TimeWindowArgs>(args) {
            Ok(a) => tool_service::get_aircraft_summary(storage, a.start_ms, a.end_ms)
                .await
                .and_then(to_value),
            Err(e) => Err(e),
        },
        "getFlightSummary" => match parse::<TimeWindowArgs>(args) {
            Ok(a) => tool_service::get_flight_summary(
                storage,
                FlightSummaryQuery {
                    start_ms: a.start_ms,
                    end_ms: a.end_ms,
                },
            )
            .await
            .and_then(to_value),
            Err(e) => Err(e),
        },
        "getTrajectory" => match parse::<TrajectoryQuery>(args) {
            Ok(q) => tool_service::get_trajectory(storage, q)
                .await
                .and_then(to_value),
            Err(e) => Err(e),
        },
        "getTimeDistribution" => match parse::<TimeDistributionQuery>(args) {
            Ok(q) => tool_service::get_time_distribution(storage, q)
                .await
                .and_then(to_value),
            Err(e) => Err(e),
        },
        "getHourlyHeatmap" => match parse::<HourlyHeatmapQuery>(args) {
            Ok(q) => tool_service::get_hourly_heatmap(storage, q)
                .await
                .and_then(to_value),
            Err(e) => Err(e),
        },
        "getEventsOfInterest" => match parse::<EventOfInterestQuery>(args) {
            Ok(q) => tool_service::get_events_of_interest(storage, q)
                .await
                .and_then(to_value),
            Err(e) => Err(e),
        },
        other => Err(format!("Unknown tool: {other}")),
    };

    match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(args: Value) -> Result<T, String> {
    // `null` (no body) → fall back to the type's Deserialize of an empty object
    // so tools whose fields are all optional work with an absent body.
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {e}"))
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

async fn handle(
    State(storage): State<SharedStorage>,
    Path(name): Path<String>,
    body: Option<Json<Value>>,
) -> Json<Value> {
    let args = body.map(|Json(v)| v).unwrap_or(Value::Null);
    Json(dispatch(&storage, &name, args).await)
}

/// Build the tool-server router (used by `spawn` and integration tests).
pub fn router(storage: SharedStorage) -> Router {
    Router::new()
        .route("/tools/{name}", post(handle))
        .with_state(storage)
}

/// Spawn the loopback tool server on a background tokio task.
///
/// Binds `127.0.0.1:<port>` only — never exposed off-host. Binding failure is
/// non-fatal: the desktop app keeps running, the agent simply gets connection
/// errors and reports tools as unavailable.
pub fn spawn(storage: SharedStorage, port: u16) {
    tauri::async_runtime::spawn(async move {
        let addr = format!("127.0.0.1:{port}");
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                warn!(
                    "Agent tool server: failed to bind {addr} (agent history tools disabled): {e}"
                );
                return;
            }
        };
        info!("Agent tool server listening on http://{addr}");
        if let Err(e) = axum::serve(listener, router(storage)).await {
            warn!("Agent tool server exited: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn empty_storage() -> SharedStorage {
        Arc::new(RwLock::new(None))
    }

    fn in_memory_storage() -> SharedStorage {
        let handle = adsb_data_engine::StorageHandle::open(adsb_data_engine::StorageConfig {
            db_path: None,
            source_id: "test".to_string(),
            gap_threshold_ms: 3_600_000,
        })
        .expect("open in-memory storage");
        Arc::new(RwLock::new(Some(handle)))
    }

    #[tokio::test]
    async fn unknown_tool_returns_error_envelope() {
        let storage = empty_storage();
        let resp = dispatch(&storage, "nope", json!({})).await;
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("Unknown tool"));
    }

    #[tokio::test]
    async fn storage_unavailable_returns_structured_error() {
        let storage = empty_storage();
        let resp = dispatch(&storage, "getStorageStats", Value::Null).await;
        assert_eq!(resp["ok"], false);
        assert_eq!(resp["error"], tool_service::STORAGE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn aircraft_summary_accepts_null_body() {
        // All fields optional → absent body must not be a parse error.
        let storage = in_memory_storage();
        let resp = dispatch(&storage, "getAircraftSummary", Value::Null).await;
        assert_eq!(resp["ok"], true);
        assert!(resp["data"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn storage_stats_happy_path() {
        let storage = in_memory_storage();
        let resp = dispatch(&storage, "getStorageStats", json!({})).await;
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["data"]["row_count"], 0);
    }

    #[tokio::test]
    async fn trajectory_missing_required_field_is_arg_error() {
        let storage = in_memory_storage();
        // hex_ident is required by TrajectoryQuery.
        let resp = dispatch(&storage, "getTrajectory", json!({"start_ms": 1})).await;
        assert_eq!(resp["ok"], false);
        assert!(resp["error"]
            .as_str()
            .unwrap()
            .contains("Invalid arguments"));
    }

    #[tokio::test]
    async fn trajectory_happy_path_empty() {
        let storage = in_memory_storage();
        let resp = dispatch(&storage, "getTrajectory", json!({"hex_ident": "ABC123"})).await;
        assert_eq!(resp["ok"], true);
        assert!(resp["data"].as_array().unwrap().is_empty());
    }
}
