//! The control API server: `GET /v1/status`, `PUT /v1/enabled`, and the
//! OpenAPI document that describes them.
//!
//! Two handlers, two sides of CQRS. `PUT` hands the setting to
//! [`Control`] -- the command side -- and answers `202 Accepted`. `GET` reads
//! the status projection -- the query side -- which is also what the MQTT
//! publisher sends. Neither handler writes what the other reads.
//!
//! The OpenAPI document is generated from this file: each route is registered
//! from the same `#[utoipa::path]` attribute that documents it, so the two
//! cannot disagree. It is served at [`OPENAPI_PATH`], with Swagger UI at
//! [`crate::api::SWAGGER_UI_PATH`] when the `swagger-ui` feature is on.
//!
//! No authentication. It binds loopback unless configured otherwise, and says
//! so loudly when it is not.

use crate::api::{ApiError, EnabledSetting, OPENAPI_PATH};
use crate::control::Control;
use crate::status::{RateLimitScope, ServiceState, WeatherStatus};
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
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
    /// The command side.
    pub control: Arc<Control>,
    /// The query side: the status projection.
    pub status: watch::Receiver<WeatherStatus>,
}

/// The document's fixed parts. Paths are added as the routes are registered.
#[derive(OpenApi)]
#[openapi(
    info(
        title = "ADS-B weather service control API",
        description = "Pause, resume and inspect the weather service.\n\n\
            Commands and status travel separately. `PUT /v1/enabled` sets the \
            desired state and answers 202 once it is persisted; what the service \
            then does is reported by `GET /v1/status` and, retained, on the MQTT \
            topic `<base>/weather/status`, beside `<base>/weather/availability` \
            (`online`/`offline`).\n\n\
            No authentication: the API binds 127.0.0.1 unless `[weather] http_bind` \
            opens it."
    ),
    tags(
        (name = "status", description = "What the service is doing (the query side)"),
        (name = "control", description = "Enable or disable fetching (the command side)")
    ),
    components(schemas(WeatherStatus, ServiceState, RateLimitScope, EnabledSetting, ApiError))
)]
struct ApiDoc;

/// The service's current status.
///
/// The same document the service publishes, retained, on its MQTT status
/// topic. `enabled` is the desired setting; `state` is what the service is
/// doing about it. A change is still pending while the two disagree.
#[utoipa::path(
    get,
    path = "/v1/status",
    tag = "status",
    responses((status = 200, description = "The current status", body = WeatherStatus))
)]
async fn get_status(State(state): State<ApiState>) -> Json<WeatherStatus> {
    Json(state.status.borrow().clone())
}

/// Enable or disable fetching.
///
/// Sets the desired state and persists it, so it survives a restart. `202`
/// means accepted, not done: the service reports acting on it through
/// `GET /v1/status` and the MQTT status topic. Disabling pauses fetching
/// only -- the last grid stays published. Sending the same setting twice is
/// the same as once.
#[utoipa::path(
    put,
    path = "/v1/enabled",
    tag = "control",
    request_body = EnabledSetting,
    responses(
        (status = 202, description = "Accepted and persisted; not acted on yet", body = EnabledSetting),
        (status = 400, description = "The body is not an EnabledSetting; nothing changed", body = ApiError),
        (status = 500, description = "The setting could not be saved; nothing changed", body = ApiError)
    )
)]
async fn put_enabled(
    State(state): State<ApiState>,
    body: Result<Json<EnabledSetting>, JsonRejection>,
) -> Response {
    let setting = match body {
        Ok(Json(setting)) => setting,
        Err(rejection) => return error(StatusCode::BAD_REQUEST, rejection.body_text()),
    };
    // The setting is written to disk before it takes effect; keep that
    // blocking I/O off the async workers.
    let control = state.control.clone();
    match tokio::task::spawn_blocking(move || control.set_enabled(setting.enabled)).await {
        Ok(Ok(())) => {
            info!(
                "Weather fetching {} through the control API",
                if setting.enabled {
                    "enabled"
                } else {
                    "disabled"
                }
            );
            (StatusCode::ACCEPTED, Json(setting)).into_response()
        }
        Ok(Err(e)) => {
            warn!("Could not apply a weather enable/disable command: {e}");
            error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn error(status: StatusCode, message: String) -> Response {
    (status, Json(ApiError { error: message })).into_response()
}

/// The documented routes, and the document built from them.
fn documented_routes() -> (Router<ApiState>, utoipa::openapi::OpenApi) {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(get_status))
        .routes(routes!(put_enabled))
        .split_for_parts()
}

/// The API's OpenAPI document, as served at [`OPENAPI_PATH`].
pub fn openapi() -> utoipa::openapi::OpenApi {
    documented_routes().1
}

/// What the `/metrics` handler needs: this service's identity, and the same
/// status projection the control API serves.
///
/// Its own state, deliberately. [`ApiState`] is constructed literally by the
/// control-API tests, and the metrics endpoint shares nothing with the control
/// handlers beyond the status channel it clones from them.
#[cfg(feature = "metrics")]
#[derive(Clone)]
pub struct MetricsState {
    /// This crate's version, for `adsb_build_info`.
    pub version: String,
    /// The receiver id, whose suffix supplies the `stage` label.
    pub source_id: String,
    /// The query side, shared with `GET /v1/status`.
    pub status: watch::Receiver<WeatherStatus>,
}

#[cfg(feature = "metrics")]
async fn get_metrics(State(state): State<MetricsState>) -> impl IntoResponse {
    // Cloned rather than held: a `watch` borrow guard must not be alive across
    // an await, and rendering is cheap enough not to care.
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

/// The API's routes, its OpenAPI document and, with the `swagger-ui` feature,
/// Swagger UI (used by [`serve`] and by tests).
pub fn router(state: ApiState) -> Router {
    let (routes, document) = documented_routes();

    // Swagger UI serves the document itself, at the URL it is told to load.
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

/// [`router`] plus the Prometheus endpoint at [`crate::api::METRICS_PATH`].
///
/// The metrics route is merged **after** the documented routes are split out,
/// so it never enters the OpenAPI document. That is deliberate: the document
/// describes the versioned JSON control contract the desktop compiles a client
/// against, and `/metrics` answers `text/plain` to a scraper that would never
/// read it. `tests/openapi.rs` pins both halves of that.
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

/// Binds `bind:port` and serves until `shutdown` turns true.
///
/// A bind failure is logged, not fatal: the service keeps fetching and
/// publishing, only remote control is lost.
pub async fn serve(
    bind: IpAddr,
    port: u16,
    state: ApiState,
    source_id: String,
    mut shutdown: watch::Receiver<bool>,
) {
    let addr = SocketAddr::new(bind, port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(e) => {
            warn!(
                "Weather control API could not bind {addr} (enable/disable over HTTP is unavailable): {e}"
            );
            return;
        }
    };
    if bind.is_loopback() {
        info!("Weather control API listening on http://{addr}");
    } else {
        warn!(
            "Weather control API listening on http://{addr}: reachable from the network, \
             with no authentication"
        );
    }
    info!("Weather control API documented at http://{addr}{OPENAPI_PATH}");
    #[cfg(feature = "swagger-ui")]
    info!(
        "Weather control API Swagger UI at http://{addr}{}/",
        crate::api::SWAGGER_UI_PATH
    );

    #[cfg(feature = "metrics")]
    info!(
        "Weather metrics at http://{addr}{}",
        crate::api::METRICS_PATH
    );

    // The endpoint has to be on the *served* router, not only the one the
    // tests build: with `router` here, /metrics passed every test and 404'd in
    // production.
    #[cfg(feature = "metrics")]
    let app = router_with_metrics(state, source_id);
    #[cfg(not(feature = "metrics"))]
    let app = {
        // Only the metrics endpoint needs the identity.
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
        warn!("Weather control API exited: {e}");
    }
}
