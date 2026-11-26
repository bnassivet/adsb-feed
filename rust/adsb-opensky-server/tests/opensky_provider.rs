//! The HTTP provider and token source against a local stand-in for OpenSky.

use adsb_opensky_server::api::Area;
use adsb_opensky_server::auth::{Credentials, TokenSource};
use adsb_opensky_server::provider::{HttpProvider, OpenSkyProvider, ProviderError};
use axum::Router;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Seen {
    token_requests: usize,
    /// (path, raw query, authorization header) per API call.
    calls: Vec<(String, String, Option<String>)>,
    /// Status the next states call answers with; 200 when empty.
    script: Vec<u16>,
}

type Shared = Arc<Mutex<Seen>>;

const STATES: &str = r#"{"time": 1764000000, "states": [
    ["3c6444", "DLH9LF  ", "Germany", 1763999995, 1763999999, -2.1, 46.9, 10668.0, false, 231.5, 87.2, 0.0, null, 10900.0, "1000", false, 0]
]}"#;

async fn token(State(seen): State<Shared>, body: String) -> Response {
    let mut seen = seen.lock().unwrap();
    seen.token_requests += 1;
    if body.contains("client_secret=wrong") {
        return (StatusCode::UNAUTHORIZED, r#"{"error":"invalid_client"}"#).into_response();
    }
    assert!(body.contains("grant_type=client_credentials"), "{body}");
    let n = seen.token_requests;
    axum::Json(serde_json::json!({"access_token": format!("tok{n}"), "expires_in": 1800}))
        .into_response()
}

fn record(seen: &Shared, path: &str, query: Option<String>, headers: &HeaderMap) -> Option<u16> {
    let mut seen = seen.lock().unwrap();
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    seen.calls
        .push((path.into(), query.unwrap_or_default(), auth));
    (!seen.script.is_empty()).then(|| seen.script.remove(0))
}

async fn states(State(seen): State<Shared>, RawQuery(q): RawQuery, headers: HeaderMap) -> Response {
    match record(&seen, "/states/all", q, &headers) {
        Some(429) => (
            StatusCode::TOO_MANY_REQUESTS,
            [("X-Rate-Limit-Retry-After-Seconds", "120")],
            "",
        )
            .into_response(),
        Some(code) if code != 200 => StatusCode::from_u16(code).unwrap().into_response(),
        _ => (
            [("X-Rate-Limit-Remaining", "3999")],
            [("content-type", "application/json")],
            STATES,
        )
            .into_response(),
    }
}

async fn tracks(State(seen): State<Shared>, RawQuery(q): RawQuery, headers: HeaderMap) -> Response {
    record(&seen, "/tracks/all", q.clone(), &headers);
    if q.unwrap_or_default().contains("icao24=000000") {
        return StatusCode::NOT_FOUND.into_response();
    }
    r#"{"icao24":"3c6444","callsign":"DLH9LF  ","startTime":1,"endTime":2,
        "path":[[1, 47.0, -1.0, 1000.0, 90.0, false]]}"#
        .into_response()
}

async fn serve() -> (String, Shared) {
    let seen: Shared = Arc::default();
    let app = Router::new()
        .route("/token", post(token))
        .route("/api/states/all", get(states))
        .route("/api/tracks/all", get(tracks))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

fn provider(url: &str, secret: Option<&str>) -> HttpProvider {
    let auth = secret.map(|s| {
        TokenSource::new(
            format!("{url}/token"),
            Credentials {
                client_id: "me-api-client".into(),
                client_secret: s.into(),
            },
        )
        .unwrap()
    });
    HttpProvider::new(format!("{url}/api"), auth).unwrap()
}

#[tokio::test]
async fn aircraft_are_asked_for_in_one_call_with_the_bearer_token() {
    let (url, seen) = serve().await;
    let p = provider(&url, Some("right"));
    let reply = p
        .states_by_icao(&["3c6444".into(), "39de4f".into()])
        .await
        .unwrap();
    assert_eq!(reply.value.states[0].icao24, "3c6444");
    assert_eq!(reply.remaining, Some(3_999));
    let seen = seen.lock().unwrap();
    let (path, query, auth) = &seen.calls[0];
    assert_eq!(path, "/states/all");
    assert_eq!(query, "icao24=3c6444&icao24=39de4f");
    assert_eq!(auth.as_deref(), Some("Bearer tok1"));
}

#[tokio::test]
async fn an_area_is_sent_as_opensky_s_four_bounds() {
    let (url, seen) = serve().await;
    let area = Area {
        id: "w".into(),
        north: 48.0,
        south: 46.5,
        east: 0.25,
        west: -3.0,
    };
    provider(&url, None).states_in_area(&area).await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.calls[0].1, "lamin=46.5&lomin=-3&lamax=48&lomax=0.25");
    assert_eq!(seen.calls[0].2, None, "anonymous sends no token");
    assert_eq!(seen.token_requests, 0);
}

#[tokio::test]
async fn the_token_is_reused_until_it_is_due() {
    let (url, seen) = serve().await;
    let p = provider(&url, Some("right"));
    for _ in 0..3 {
        p.states_by_icao(&["3c6444".into()]).await.unwrap();
    }
    assert_eq!(seen.lock().unwrap().token_requests, 1);
}

#[tokio::test]
async fn a_401_refreshes_the_token_and_retries_once() {
    let (url, seen) = serve().await;
    seen.lock().unwrap().script = vec![401];
    let p = provider(&url, Some("right"));
    p.states_by_icao(&["3c6444".into()]).await.unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.token_requests, 2);
    assert_eq!(seen.calls.len(), 2);
    assert_eq!(seen.calls[1].2.as_deref(), Some("Bearer tok2"));
}

#[tokio::test]
async fn two_401s_in_a_row_are_unauthorized() {
    let (url, seen) = serve().await;
    seen.lock().unwrap().script = vec![401, 401];
    let err = provider(&url, Some("right"))
        .states_by_icao(&["3c6444".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, ProviderError::Unauthorized(_)), "{err:?}");
}

#[tokio::test]
async fn refused_credentials_are_unauthorized_without_calling_the_api() {
    let (url, seen) = serve().await;
    let err = provider(&url, Some("wrong"))
        .states_by_icao(&["3c6444".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, ProviderError::Unauthorized(_)), "{err:?}");
    assert!(seen.lock().unwrap().calls.is_empty());
}

#[tokio::test]
async fn a_429_carries_opensky_s_retry_after() {
    let (url, seen) = serve().await;
    seen.lock().unwrap().script = vec![429];
    let err = provider(&url, None)
        .states_by_icao(&["3c6444".into()])
        .await
        .unwrap_err();
    assert_eq!(
        err,
        ProviderError::RateLimited {
            retry_after: Some(std::time::Duration::from_secs(120))
        }
    );
}

#[tokio::test]
async fn a_5xx_is_transient() {
    let (url, seen) = serve().await;
    seen.lock().unwrap().script = vec![503];
    let err = provider(&url, None)
        .states_by_icao(&["3c6444".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, ProviderError::Transient(_)), "{err:?}");
}

#[tokio::test]
async fn a_live_track_is_asked_for_with_time_zero() {
    let (url, seen) = serve().await;
    let p = provider(&url, Some("right"));
    let t = p.track("3c6444", None).await.unwrap().value;
    assert_eq!(t.callsign.as_deref(), Some("DLH9LF"));
    assert_eq!(t.path.len(), 1);
    assert_eq!(seen.lock().unwrap().calls[0].1, "icao24=3c6444&time=0");
    assert_eq!(
        p.track("000000", None).await.unwrap_err(),
        ProviderError::NotFound
    );
}

#[tokio::test]
async fn a_past_track_is_asked_for_at_its_time() {
    let (url, seen) = serve().await;
    let p = provider(&url, Some("right"));
    p.track("3c6444", Some(1_764_000_000)).await.unwrap();
    assert_eq!(
        seen.lock().unwrap().calls[0].1,
        "icao24=3c6444&time=1764000000"
    );
}

#[tokio::test]
async fn an_unreachable_api_is_transient() {
    let p = HttpProvider::new("http://127.0.0.1:9", None).unwrap();
    let err = p.states_by_icao(&["3c6444".into()]).await.unwrap_err();
    assert!(matches!(err, ProviderError::Transient(_)), "{err:?}");
}
