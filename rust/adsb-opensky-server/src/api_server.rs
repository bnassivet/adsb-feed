//! The control API server: status, enable/disable, watch leases, credits and
//! track backfill, with the OpenAPI document that describes them.
//!
//! Each route is registered from the same `#[utoipa::path]` attribute that
//! documents it, so the document cannot drift from what is served. No
//! authentication: loopback unless configured otherwise, and loud when not.

use crate::api::{
    ApiError, Area, CreditsReport, EnabledSetting, HourCredits, OPENAPI_PATH, WatchAccepted,
    WatchRequest,
};
use crate::control::{Control, TrackError};
use crate::provider::ProviderError;
use crate::states::{OpenSkyTrack, Waypoint};
use crate::status::{CreditsSummary, OpenSkyStatus, ServiceState, WatchSummary};
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use tokio::sync::watch;
use tracing::{info, warn};
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

/// What the handlers share.
#[derive(Clone)]
pub struct ApiState {
    pub control: Arc<Control>,
    /// The poller's status, as published.
    pub status: watch::Receiver<OpenSkyStatus>,
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "ADS-B OpenSky gap-filler control API",
        description = "Tell the OpenSky service what to watch, and inspect what it spends.\n\n\
            A client `PUT`s its watch list -- aircraft by ICAO address, and areas -- under \
            its own id. The list is a lease: renew it within `lease_seconds` or it lapses. \
            The service polls OpenSky for the union of live leases within the account's \
            daily credit budget and publishes each poll on the MQTT topic \
            `<base>/opensky/states` (not retained), its status, retained, on \
            `<base>/opensky/status`, beside `<base>/opensky/availability`.\n\n\
            Nothing fetched is recorded. No authentication: the API binds 127.0.0.1 \
            unless `[opensky] http_bind` opens it."
    ),
    tags(
        (name = "status", description = "What the service is doing and spending"),
        (name = "control", description = "Enable or disable polling"),
        (name = "watch", description = "What to poll, as renewable leases"),
        (name = "tracks", description = "On-demand track backfill")
    ),
    components(schemas(
        OpenSkyStatus, ServiceState, WatchSummary, CreditsSummary, EnabledSetting, WatchRequest,
        WatchAccepted, Area, CreditsReport, HourCredits, OpenSkyTrack, Waypoint, ApiError
    ))
)]
struct ApiDoc;

/// The service's current status.
///
/// The same document published, retained, on the MQTT status topic.
#[utoipa::path(
    get,
    path = "/v1/status",
    tag = "status",
    responses((status = 200, description = "The current status", body = OpenSkyStatus))
)]
async fn get_status(State(state): State<ApiState>) -> Json<OpenSkyStatus> {
    Json(state.status.borrow().clone())
}

/// Enable or disable polling.
///
/// In memory only: a restart comes back enabled. Disabling stops polling and
/// spends nothing; leases are kept. Re-enabling after refused credentials
/// tries them again.
#[utoipa::path(
    put,
    path = "/v1/enabled",
    tag = "control",
    request_body = EnabledSetting,
    responses(
        (status = 202, description = "Accepted; the status reports when it takes effect", body = EnabledSetting),
        (status = 400, description = "The body is not an EnabledSetting", body = ApiError)
    )
)]
async fn put_enabled(
    State(state): State<ApiState>,
    body: Result<Json<EnabledSetting>, JsonRejection>,
) -> Response {
    let setting = match body {
        Ok(Json(s)) => s,
        Err(r) => return error(StatusCode::BAD_REQUEST, r.body_text()),
    };
    state.control.set_enabled(setting.enabled);
    info!(
        "OpenSky polling {} through the control API",
        if setting.enabled {
            "enabled"
        } else {
            "disabled"
        }
    );
    (StatusCode::ACCEPTED, Json(setting)).into_response()
}

/// Set this client's watch list, and renew its lease.
///
/// Replaces the client's previous list whole. Renew within `lease_seconds`
/// (the desktop does every 20 s), or the list lapses and polling for it stops.
/// A list with any invalid entry is refused whole and changes nothing.
#[utoipa::path(
    put,
    path = "/v1/watch/{client_id}",
    tag = "watch",
    params(("client_id" = String, Path, description = "The client's own id: letters, digits, '-', '_', '.'")),
    request_body = WatchRequest,
    responses(
        (status = 200, description = "Accepted and leased", body = WatchAccepted),
        (status = 400, description = "Invalid id, address or area, or over a limit; nothing changed", body = ApiError)
    )
)]
async fn put_watch(
    State(state): State<ApiState>,
    Path(client_id): Path<String>,
    body: Result<Json<WatchRequest>, JsonRejection>,
) -> Response {
    let request = match body {
        Ok(Json(r)) => r,
        Err(r) => return error(StatusCode::BAD_REQUEST, r.body_text()),
    };
    match state.control.put_watch(&client_id, &request) {
        Ok(accepted) => Json(accepted).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

/// Drop this client's watch list now, without waiting for its lease.
#[utoipa::path(
    delete,
    path = "/v1/watch/{client_id}",
    tag = "watch",
    params(("client_id" = String, Path, description = "The client's own id")),
    responses((status = 204, description = "Dropped, or there was none"))
)]
async fn delete_watch(State(state): State<ApiState>, Path(client_id): Path<String>) -> StatusCode {
    state.control.remove_watch(&client_id);
    StatusCode::NO_CONTENT
}

/// Credits spent per hour over the last 24 hours, per OpenSky bucket.
#[utoipa::path(
    get,
    path = "/v1/credits",
    tag = "status",
    responses((status = 200, description = "24 hours, oldest first", body = CreditsReport))
)]
async fn get_credits(State(state): State<ApiState>) -> Json<CreditsReport> {
    let now = state.control.now();
    Json(state.control.credits_report(now))
}

/// Optional query of `GET /v1/track/{icao24}`.
#[derive(Debug, Default, serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TrackQuery {
    /// Any moment of the wanted flight, epoch seconds, within the last 30
    /// days. Omitted: the live flight.
    pub time: Option<i64>,
}

/// An aircraft's track from OpenSky: sparse waypoints of one flight.
///
/// Without `time`, the live flight, for 4 `/tracks` credits. With `time`, the
/// flight the aircraft was on then: 4 credits within a day, an estimated 30
/// beyond (the ledger records what OpenSky actually counted). OpenSky
/// documents the endpoint as experimental and keeps 30 days of tracks.
#[utoipa::path(
    get,
    path = "/v1/track/{icao24}",
    tag = "tracks",
    params(("icao24" = String, Path, description = "ICAO 24-bit address, hex"), TrackQuery),
    responses(
        (status = 200, description = "The flight's track", body = OpenSkyTrack),
        (status = 400, description = "Not an ICAO address", body = ApiError),
        (status = 404, description = "OpenSky has no flight for it at that time", body = ApiError),
        (status = 409, description = "The service is anonymous; tracks need credentials", body = ApiError),
        (status = 422, description = "time is in the future or more than 30 days old", body = ApiError),
        (status = 429, description = "Out of /tracks credits", body = ApiError),
        (status = 502, description = "OpenSky failed or refused", body = ApiError)
    )
)]
async fn get_track(
    State(state): State<ApiState>,
    Path(icao24): Path<String>,
    Query(query): Query<TrackQuery>,
) -> Response {
    match state.control.track_at(&icao24, query.time).await {
        Ok(track) => Json(track).into_response(),
        Err(e) => {
            let status = match &e {
                TrackError::BadIcao(_) => StatusCode::BAD_REQUEST,
                TrackError::Anonymous => StatusCode::CONFLICT,
                TrackError::OverBudget => StatusCode::TOO_MANY_REQUESTS,
                TrackError::OutOfRange(_) => StatusCode::UNPROCESSABLE_ENTITY,
                TrackError::Provider(ProviderError::NotFound) => StatusCode::NOT_FOUND,
                TrackError::Provider(ProviderError::RateLimited { .. }) => {
                    StatusCode::TOO_MANY_REQUESTS
                }
                TrackError::Provider(_) => StatusCode::BAD_GATEWAY,
            };
            error(status, e.to_string())
        }
    }
}

fn error(status: StatusCode, message: String) -> Response {
    (status, Json(ApiError { error: message })).into_response()
}

fn documented_routes() -> (Router<ApiState>, utoipa::openapi::OpenApi) {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(get_status))
        .routes(routes!(put_enabled))
        .routes(routes!(put_watch, delete_watch))
        .routes(routes!(get_credits))
        .routes(routes!(get_track))
        .split_for_parts()
}

/// The API's OpenAPI document, as served at [`OPENAPI_PATH`].
pub fn openapi() -> utoipa::openapi::OpenApi {
    documented_routes().1
}

/// The routes, the document and, with `swagger-ui`, Swagger UI.
pub fn router(state: ApiState) -> Router {
    let (routes, document) = documented_routes();
    #[cfg(feature = "swagger-ui")]
    let routes = routes.merge(
        utoipa_swagger_ui::SwaggerUi::new(crate::api::SWAGGER_UI_PATH).url(OPENAPI_PATH, document),
    );
    #[cfg(not(feature = "swagger-ui"))]
    let routes = routes.route(
        OPENAPI_PATH,
        axum::routing::get(move || {
            let document = document.clone();
            async move { Json(document) }
        }),
    );
    routes.with_state(state)
}

#[cfg(feature = "metrics")]
#[derive(Clone)]
struct MetricsState {
    version: String,
    source_id: String,
    status: watch::Receiver<OpenSkyStatus>,
}

#[cfg(feature = "metrics")]
async fn get_metrics(State(state): State<MetricsState>) -> impl IntoResponse {
    let status = state.status.borrow().clone();
    let body = crate::metrics_export::render(&state.version, &state.source_id, &status);
    (
        [(
            axum::http::header::CONTENT_TYPE,
            adsb_pulsar_client::metrics_export::content_type(),
        )],
        body,
    )
}

/// [`router`] plus `/metrics`, merged after the document is split out so it
/// never enters it.
#[cfg(feature = "metrics")]
pub fn router_with_metrics(state: ApiState, source_id: impl Into<String>) -> Router {
    let metrics = MetricsState {
        version: env!("CARGO_PKG_VERSION").to_string(),
        source_id: source_id.into(),
        status: state.status.clone(),
    };
    router(state).merge(
        Router::new()
            .route(crate::api::METRICS_PATH, axum::routing::get(get_metrics))
            .with_state(metrics),
    )
}

/// Binds `bind:port` and serves until `shutdown` turns true. A bind failure
/// is logged, not fatal: without the API nothing is watched, so nothing is
/// spent.
pub async fn serve(
    bind: IpAddr,
    port: u16,
    state: ApiState,
    source_id: String,
    mut shutdown: watch::Receiver<bool>,
) {
    let addr = SocketAddr::new(bind, port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            warn!("OpenSky control API could not bind {addr}; nothing can be watched: {e}");
            return;
        }
    };
    if bind.is_loopback() {
        info!("OpenSky control API listening on http://{addr}");
    } else {
        warn!(
            "OpenSky control API listening on http://{addr}: reachable from the network, \
             with no authentication"
        );
    }
    info!("OpenSky control API documented at http://{addr}{OPENAPI_PATH}");

    #[cfg(feature = "metrics")]
    let app = router_with_metrics(state, source_id);
    #[cfg(not(feature = "metrics"))]
    let app = {
        let _ = source_id;
        router(state)
    };

    let stopped = async move {
        while shutdown.changed().await.is_ok() {
            if *shutdown.borrow() {
                break;
            }
        }
    };
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(stopped)
        .await
    {
        warn!("OpenSky control API exited: {e}");
    }
}
