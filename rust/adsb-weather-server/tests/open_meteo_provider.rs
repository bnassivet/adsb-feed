//! `OpenMeteoProvider` over real HTTP, against a local server replaying a
//! recorded Open-Meteo response. No request leaves the machine.

use adsb_weather_server::GridSpec;
use adsb_weather_server::budget::TokenBucket;
use adsb_weather_server::provider::{
    ErrorClass, OpenMeteoProvider, ProviderError, WeatherProvider,
};
use adsb_weather_server::status::RateLimitScope;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// A provider pointed at a server that answers every request with `status`,
/// an optional JSON `reason` body and optional extra headers.
async fn failing_provider(
    status: StatusCode,
    reason: Option<&'static str>,
    headers: &'static [(&'static str, &'static str)],
) -> OpenMeteoProvider {
    let router = Router::new().route(
        "/v1/forecast",
        get(move || async move {
            let mut response = match reason {
                Some(reason) => (
                    status,
                    axum::Json(serde_json::json!({ "error": true, "reason": reason })),
                )
                    .into_response(),
                None => (status, "slow down").into_response(),
            };
            for (name, value) in headers {
                response
                    .headers_mut()
                    .insert(*name, axum::http::HeaderValue::from_static(value));
            }
            response
        }),
    );
    OpenMeteoProvider::new(serve(router).await, "best_match").unwrap()
}

async fn fetch_error(provider: &OpenMeteoProvider) -> ProviderError {
    provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect_err("the fetch must fail")
}

/// Like the fixture server, but the first request for latitude 48 fails with
/// a 503 -- a grid whose second chunk dies mid-fetch.
async fn flaky_server() -> (String, Queries) {
    let queries = Queries::default();
    let failed_once = Arc::new(AtomicBool::new(false));
    let router = Router::new()
        .route(
            "/v1/forecast",
            get(
                move |State(queries): State<Queries>,
                      Query(query): Query<HashMap<String, String>>| {
                    let failed_once = failed_once.clone();
                    async move {
                        let second_chunk = query.get("latitude").map(String::as_str) == Some("48");
                        if second_chunk && !failed_once.swap(true, Ordering::SeqCst) {
                            queries.lock().unwrap().push(query);
                            return StatusCode::SERVICE_UNAVAILABLE.into_response();
                        }
                        fixture_handler(State(queries), Query(query))
                            .await
                            .into_response()
                    }
                },
            ),
        )
        .with_state(queries.clone());
    (serve(router).await, queries)
}

fn latitudes(queries: &Queries) -> Vec<String> {
    queries
        .lock()
        .unwrap()
        .iter()
        .map(|q| q["latitude"].clone())
        .collect()
}

#[tokio::test]
async fn a_retry_only_fetches_the_chunks_that_failed() {
    let (url, queries) = flaky_server().await;
    let provider = OpenMeteoProvider::new(url, "best_match")
        .unwrap()
        .with_chunk(1);

    provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect_err("the second chunk fails");
    let snap = provider
        .fetch(column_grid(), &[250], NOW_MS + 60_000)
        .await
        .expect("the retry completes the grid");

    // The first chunk was paid for once, not twice.
    assert_eq!(latitudes(&queries), ["47", "48", "48"]);
    assert_eq!(snap.surface.mslp_hpa, vec![Some(1021.7), Some(1021.9)]);
}

#[tokio::test]
async fn a_retry_in_another_model_hour_fetches_everything_again() {
    let (url, queries) = flaky_server().await;
    let provider = OpenMeteoProvider::new(url, "best_match")
        .unwrap()
        .with_chunk(1);

    provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect_err("the second chunk fails");
    // An hour on, the held chunk describes an hour nobody wants any more.
    let _ = provider
        .fetch(column_grid(), &[250], NOW_MS + 3_600_000)
        .await;

    assert_eq!(latitudes(&queries), ["47", "48", "47", "48"]);
}

#[tokio::test]
async fn a_completed_fetch_leaves_nothing_to_resume() {
    let (url, queries) = fixture_server().await;
    let provider = OpenMeteoProvider::new(url, "best_match")
        .unwrap()
        .with_chunk(1);

    provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect("fetch");
    provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect("refetch");

    assert_eq!(latitudes(&queries), ["47", "48", "47", "48"]);
}

#[tokio::test]
async fn requests_are_paced_to_the_call_budget() {
    let (url, queries) = fixture_server().await;
    // One call's worth of tokens, refilled five times a second: the second
    // single-location request has to wait about 200 ms for its token.
    let provider = OpenMeteoProvider::new(url, "best_match")
        .unwrap()
        .with_chunk(1)
        .with_pacer(TokenBucket::new(1.0, 5.0));

    let started = std::time::Instant::now();
    provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect("fetch");

    assert_eq!(queries.lock().unwrap().len(), 2);
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(190), "{elapsed:?}");
}

#[tokio::test]
async fn an_api_rejection_keeps_its_status_and_reason() {
    let provider = failing_provider(
        StatusCode::BAD_REQUEST,
        Some("Latitude must be in range of -90 to 90°"),
        &[],
    )
    .await;

    let err = fetch_error(&provider).await;
    match &err {
        ProviderError::Status {
            status: 400,
            reason: Some(reason),
            ..
        } => assert!(reason.contains("Latitude"), "{reason}"),
        other => panic!("expected a 400 with its reason, got {other:?}"),
    }
    assert!(err.to_string().contains("Latitude"), "{err}");
    // Asking again cannot fix a malformed request: it is not retried like a
    // network blip.
    assert_eq!(err.class(), ErrorClass::Rejected);
}

#[tokio::test]
async fn rate_limiting_is_recognisable() {
    let provider = failing_provider(StatusCode::TOO_MANY_REQUESTS, None, &[]).await;

    let err = fetch_error(&provider).await;
    assert!(
        matches!(err, ProviderError::Status { status: 429, .. }),
        "{err:?}"
    );
    assert!(err.is_rate_limited());
    assert_eq!(
        err.class(),
        ErrorClass::RateLimited {
            scope: RateLimitScope::Unknown,
            retry_after: None
        }
    );
}

#[tokio::test]
async fn a_daily_limit_is_told_apart_from_a_minutely_one() {
    let provider = failing_provider(
        StatusCode::TOO_MANY_REQUESTS,
        Some("Daily API request limit exceeded. Please try again tomorrow."),
        &[],
    )
    .await;

    assert_eq!(
        fetch_error(&provider).await.class(),
        ErrorClass::RateLimited {
            scope: RateLimitScope::Daily,
            retry_after: None
        }
    );
}

#[tokio::test]
async fn a_retry_after_header_is_kept() {
    let provider = failing_provider(
        StatusCode::TOO_MANY_REQUESTS,
        None,
        &[("retry-after", "120")],
    )
    .await;

    assert_eq!(
        fetch_error(&provider).await.class(),
        ErrorClass::RateLimited {
            scope: RateLimitScope::Unknown,
            retry_after: Some(Duration::from_secs(120))
        }
    );
}

#[tokio::test]
async fn a_server_error_is_transient() {
    let provider = failing_provider(StatusCode::SERVICE_UNAVAILABLE, None, &[]).await;
    assert_eq!(fetch_error(&provider).await.class(), ErrorClass::Transient);
}

#[tokio::test]
async fn a_rate_limit_with_a_json_reason_is_still_a_rate_limit() {
    // What Open-Meteo actually sends: a 429 whose body is the same
    // `{"error": true, "reason": ...}` shape as a 400. Decoding the body must
    // not throw the status away.
    let router = Router::new().route(
        "/v1/forecast",
        get(|| async {
            (
                StatusCode::TOO_MANY_REQUESTS,
                axum::Json(serde_json::json!({
                    "error": true,
                    "reason": "Minutely API request limit exceeded. Please try again in one minute."
                })),
            )
        }),
    );
    let provider = OpenMeteoProvider::new(serve(router).await, "best_match").unwrap();

    let err = provider
        .fetch(column_grid(), &[250], NOW_MS)
        .await
        .expect_err("429 must fail");
    assert!(err.is_rate_limited(), "{err:?}");
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
    assert_eq!(err.class(), ErrorClass::Transient);
}

#[test]
fn provider_names_itself_for_logs() {
    let provider = OpenMeteoProvider::new("http://127.0.0.1:1/v1/forecast", "best_match").unwrap();
    assert_eq!(provider.name(), "open-meteo");
}
