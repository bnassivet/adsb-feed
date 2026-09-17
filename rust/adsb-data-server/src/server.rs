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

use crate::tool_service;
use adsb_data_engine::SharedStorage;
use adsb_data_engine::{
    EventOfInterestQuery, FlightSummaryQuery, HourlyHeatmapQuery, TimeDistributionQuery,
    TrajectoryQuery,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};
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

/// Args for `getScenario` — a single scenario id.
#[derive(Debug, Default, Deserialize)]
struct ScenarioIdArgs {
    #[serde(default)]
    id: String,
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
        "listScenarios" => tool_service::list_scenarios(storage)
            .await
            .and_then(to_value),
        "getScenario" => match parse::<ScenarioIdArgs>(args) {
            Ok(a) => tool_service::get_scenario(storage, a.id)
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
///
/// Deliberately **without** `/metrics`. The desktop app serves this same
/// router from its embedded tool server, and it is not a scrape target: it is
/// a GUI on a laptop, its DuckDB file is a different database from the
/// recorder's, and Prometheus has no idea when it is running. Use
/// [`router_with_metrics`] for the daemon.
pub fn router(storage: SharedStorage) -> Router {
    Router::new()
        .route("/tools/{name}", post(handle))
        .with_state(storage)
}

/// What the `/metrics` handler needs: this recorder's identity and the cached
/// storage statistics.
#[cfg(feature = "metrics")]
#[derive(Clone)]
pub struct MetricsState {
    /// This crate's version, for `adsb_build_info`.
    pub version: String,
    /// The receiver id, whose suffix supplies the `stage` label.
    pub source_id: String,
    /// Refreshed in the background; see [`crate::metrics_export`].
    pub cache: crate::metrics_export::StatsCache,
}

#[cfg(feature = "metrics")]
async fn handle_metrics(State(state): State<MetricsState>) -> impl axum::response::IntoResponse {
    let cached = state.cache.snapshot();
    let body = crate::metrics_export::render(&state.version, &state.source_id, cached.as_ref());
    (
        [(
            axum::http::header::CONTENT_TYPE,
            adsb_pulsar_client::metrics_export::content_type(),
        )],
        body,
    )
}

/// [`router`] plus `/metrics`, for the daemon.
///
/// The two surfaces share one listener: the recorder already has a port, and
/// giving the scrape endpoint its own would be another thing to configure, to
/// check for collisions in `make doctor`, and to forget on one machine.
#[cfg(feature = "metrics")]
pub fn router_with_metrics(storage: SharedStorage, metrics: MetricsState) -> Router {
    router(storage).merge(
        Router::new()
            .route("/metrics", axum::routing::get(handle_metrics))
            .with_state(metrics),
    )
}

/// Bind `bind:port`, logging what was bound and how widely.
///
/// `None` on failure: binding failure is non-fatal everywhere this is used —
/// the process keeps running, and the agent simply gets connection errors and
/// reports its history tools as unavailable.
async fn bind_listener(bind: IpAddr, port: u16) -> Option<tokio::net::TcpListener> {
    let addr = SocketAddr::new(bind, port);
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            if bind.is_loopback() {
                info!("Agent tool server listening on http://{addr}");
            } else {
                // Worth a warning rather than an info: this API has no
                // authentication of any kind.
                warn!(
                    "Agent tool server listening on http://{addr}: reachable from the network, \
                     with no authentication"
                );
            }
            Some(listener)
        }
        Err(e) => {
            warn!("Agent tool server: failed to bind {addr} (agent history tools disabled): {e}");
            None
        }
    }
}

/// The tool server itself: bind, then serve until the task is dropped.
///
/// Returns a future and spawns nothing, so **the caller chooses what drives
/// it**. That matters because the two consumers have different runtimes: the
/// daemon is inside `#[tokio::main]`, while the Tauri app calls this from its
/// `setup` hook, where no tokio runtime is running yet and Tauri manages its
/// own. Spawning here with `tokio::spawn` aborted the desktop app at launch
/// with "there is no reactor running".
///
/// `bind` is explicit rather than hardcoded so the daemon can be configured;
/// the desktop passes `Ipv4Addr::LOCALHOST` and means it.
pub async fn serve(storage: SharedStorage, bind: IpAddr, port: u16) {
    let Some(listener) = bind_listener(bind, port).await else {
        return;
    };
    if let Err(e) = axum::serve(listener, router(storage)).await {
        warn!("Agent tool server exited: {e}");
    }
}

/// Convenience for callers already inside a tokio runtime (the daemon).
///
/// A Tauri app must NOT use this — it has no ambient runtime at setup time.
/// Use `tauri::async_runtime::spawn(serve(storage, port))` instead.
pub fn spawn(storage: SharedStorage, bind: IpAddr, port: u16) {
    tokio::spawn(serve(storage, bind, port));
}

/// [`serve`], with `/metrics` on the same listener.
#[cfg(feature = "metrics")]
pub async fn serve_with_metrics(
    storage: SharedStorage,
    bind: IpAddr,
    port: u16,
    metrics: MetricsState,
) {
    let Some(listener) = bind_listener(bind, port).await else {
        return;
    };
    info!(
        "Recorder metrics at http://{}/metrics",
        SocketAddr::new(bind, port)
    );
    if let Err(e) = axum::serve(listener, router_with_metrics(storage, metrics)).await {
        warn!("Agent tool server exited: {e}");
    }
}

/// Convenience for callers already inside a tokio runtime (the daemon).
#[cfg(feature = "metrics")]
pub fn spawn_with_metrics(storage: SharedStorage, bind: IpAddr, port: u16, metrics: MetricsState) {
    tokio::spawn(serve_with_metrics(storage, bind, port, metrics));
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
            share: None,
            remote: None,
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

    /// Deliberately NOT a `#[tokio::test]`: there is no runtime in scope here,
    /// which is the whole point.
    ///
    /// Regression. `spawn` used to call `tokio::spawn` directly, and the Tauri
    /// app calls it from its `setup` hook where no runtime is running yet, so
    /// the desktop aborted at launch with "there is no reactor running, must be
    /// called from the context of a Tokio 1.x runtime". Building the future must
    /// not require an ambient runtime -- only driving it does, and choosing what
    /// drives it is the caller's business.
    #[test]
    fn serve_future_can_be_built_without_an_ambient_runtime() {
        let storage: SharedStorage = Arc::new(RwLock::new(None));
        let fut = serve(storage, IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0);
        // Dropping it unpolled is fine; constructing it is what used to panic.
        drop(fut);
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
        assert!(
            resp["error"]
                .as_str()
                .unwrap()
                .contains("Invalid arguments")
        );
    }

    #[tokio::test]
    async fn trajectory_happy_path_empty() {
        let storage = in_memory_storage();
        let resp = dispatch(&storage, "getTrajectory", json!({"hex_ident": "ABC123"})).await;
        assert_eq!(resp["ok"], true);
        assert!(resp["data"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_scenarios_accepts_null_body() {
        let storage = in_memory_storage();
        let resp = dispatch(&storage, "listScenarios", Value::Null).await;
        assert_eq!(resp["ok"], true);
        assert!(resp["data"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_scenarios_returns_saved_scenarios() {
        let storage = in_memory_storage();
        {
            let guard = storage.read().await;
            guard
                .as_ref()
                .unwrap()
                .insert_scenario_sync(&adsb_data_engine::CreateScenario {
                    name: "Approach Rush".to_string(),
                    ..Default::default()
                })
                .expect("insert scenario");
        }

        let resp = dispatch(&storage, "listScenarios", json!({})).await;
        assert_eq!(resp["ok"], true);
        let rows = resp["data"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "Approach Rush");
        assert_eq!(rows[0]["track_count"], 0);
    }

    #[tokio::test]
    async fn get_scenario_returns_scenario_with_tracks() {
        let storage = in_memory_storage();
        let scenario_id = {
            let guard = storage.read().await;
            let handle = guard.as_ref().unwrap();
            let scenario = handle
                .insert_scenario_sync(&adsb_data_engine::CreateScenario {
                    name: "Night Patrol".to_string(),
                    ..Default::default()
                })
                .expect("insert scenario");
            handle
                .insert_scenario_track_sync(&adsb_data_engine::CreateScenarioTrack {
                    scenario_id: scenario.id.clone(),
                    hex_ident: "AAA111".to_string(),
                    callsign: "HELI01".to_string(),
                    category: "helicopter".to_string(),
                    waypoints_json: "[]".to_string(),
                    ..Default::default()
                })
                .expect("insert track");
            scenario.id
        };

        let resp = dispatch(&storage, "getScenario", json!({ "id": scenario_id })).await;
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["data"]["scenario"]["name"], "Night Patrol");
        assert_eq!(resp["data"]["tracks"].as_array().unwrap().len(), 1);
        assert_eq!(resp["data"]["tracks"][0]["callsign"], "HELI01");
    }

    #[tokio::test]
    async fn get_scenario_missing_id_is_an_error_envelope() {
        let storage = in_memory_storage();
        let resp = dispatch(&storage, "getScenario", json!({ "id": "nope" })).await;
        assert_eq!(resp["ok"], false);
        assert!(
            resp["error"]
                .as_str()
                .unwrap()
                .contains("Scenario not found")
        );
    }

    #[tokio::test]
    async fn scenario_writes_are_not_reachable_from_the_tool_server() {
        // The tool server is deliberately read-only: scenario mutations go
        // through the CopilotKit frontend tools so they stay user-visible.
        let storage = in_memory_storage();
        for name in [
            "createScenario",
            "deleteScenario",
            "createScenarioTrack",
            "updateScenarioTrack",
            "deleteScenarioTrack",
        ] {
            let resp = dispatch(&storage, name, json!({})).await;
            assert_eq!(resp["ok"], false, "{name} must not be dispatchable");
            assert!(resp["error"].as_str().unwrap().contains("Unknown tool"));
        }
    }
}
