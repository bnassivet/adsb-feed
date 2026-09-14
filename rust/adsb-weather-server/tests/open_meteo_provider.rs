//! `OpenMeteoProvider` over real HTTP, against a local server replaying a
//! recorded Open-Meteo response. No request leaves the machine.

use adsb_weather_server::GridSpec;
use adsb_weather_server::open_meteo::OpenMeteoError;
use adsb_weather_server::provider::{OpenMeteoProvider, ProviderError, WeatherProvider};
use axum::Router;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const FIXTURE: &str = include_str!("../src/fixtures/open_meteo_two_points.json");
/// Second hour of the fixture, plus ten minutes.
const NOW_MS: i64 = (1_789_412_400 + 600) * 1000;

type Queries = Arc<Mutex<Vec<HashMap<String, String>>>>;

/// Two rows, one column: points (47, -3) and (48, -3). Distinct latitudes let
/// the fixture server answer each chunk with its own location.
fn column_grid() -> GridSpec {
    GridSpec {
        lat0: 47.0,
        lon0: -3.0,
        dlat: 1.0,
        dlon: 1.0,
        nlat: 2,
        nlon: 1,
    }
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}/v1/forecast")
}

/// Replays the fixture: the whole array for a multi-location request, the
/// matching bare object for a single one -- the shape Open-Meteo returns.
async fn fixture_handler(
    State(queries): State<Queries>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let latitude = query.get("latitude").cloned().unwrap_or_default();
    queries.lock().unwrap().push(query);
    let all: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
    let body = match latitude.as_str() {
        "47" => all[0].clone(),
        "48" => all[1].clone(),
        _ => all,
    };
    axum::Json(body)
}

async fn fixture_server() -> (String, Queries) {
    let queries = Queries::default();
    let router = Router::new()
        .route("/v1/forecast", get(fixture_handler))
        .with_state(queries.clone());
    (serve(router).await, queries)
}

#[tokio::test]
async fn fetches_and_assembles_a_snapshot() {
    let (url, queries) = fixture_server().await;
    let provider = OpenMeteoProvider::new(url, "best_match").unwrap();

    let snap = provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect("fetch");

    assert_eq!(snap.valid_time_ms, 1_789_412_400_000);
    assert_eq!(snap.surface.mslp_hpa, vec![Some(1021.7), Some(1021.9)]);
    assert_eq!(
        snap.levels[&250].wind_speed_kt,
        vec![Some(33.7), Some(49.7)]
    );
    assert!(snap.validate().is_ok());

    let queries = queries.lock().unwrap();
    assert_eq!(queries.len(), 1, "two points fit in one request");
    assert_eq!(queries[0]["latitude"], "47,48");
    assert_eq!(queries[0]["models"], "best_match");
}

#[tokio::test]
async fn one_request_per_chunk_and_results_stay_in_grid_order() {
    let (url, queries) = fixture_server().await;
    let provider = OpenMeteoProvider::new(url, "best_match")
        .unwrap()
        .with_chunk(1);

    let snap = provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect("fetch");

    assert_eq!(queries.lock().unwrap().len(), 2);
    assert_eq!(snap.surface.mslp_hpa, vec![Some(1021.7), Some(1021.9)]);
}

#[tokio::test]
async fn an_api_rejection_surfaces_the_reason() {
    let router = Router::new().route(
        "/v1/forecast",
        get(|| async {
            (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({
                    "error": true,
                    "reason": "Latitude must be in range of -90 to 90°"
                })),
            )
        }),
    );
    let provider = OpenMeteoProvider::new(serve(router).await, "best_match").unwrap();

    match provider.fetch(column_grid(), &[250], NOW_MS).await {
        Err(ProviderError::Decode(OpenMeteoError::Api(reason))) => {
            assert!(reason.contains("Latitude"), "{reason}");
        }
        other => panic!("expected an Api rejection, got {other:?}"),
    }
}

#[tokio::test]
async fn rate_limiting_is_recognisable() {
    let router = Router::new().route(
        "/v1/forecast",
        get(|| async { (StatusCode::TOO_MANY_REQUESTS, "slow down") }),
    );
    let provider = OpenMeteoProvider::new(serve(router).await, "best_match").unwrap();

    let err = provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect_err("429 must fail");
    assert!(
        matches!(err, ProviderError::Status { status: 429, .. }),
        "{err:?}"
    );
    assert!(err.is_rate_limited());
}

#[tokio::test]
async fn an_unreachable_server_is_an_http_error() {
    // Bind, learn the port, release it: nothing is listening there any more.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    let provider =
        OpenMeteoProvider::new(format!("http://{addr}/v1/forecast"), "best_match").unwrap();
    let err = provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect_err("nothing is listening");
    assert!(matches!(err, ProviderError::Http { .. }), "{err:?}");
    assert!(!err.is_rate_limited());
}

#[test]
fn provider_names_itself_for_logs() {
    let provider = OpenMeteoProvider::new("http://127.0.0.1:1/v1/forecast", "best_match").unwrap();
    assert_eq!(provider.name(), "open-meteo");
}
