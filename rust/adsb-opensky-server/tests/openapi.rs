//! The OpenAPI document and Swagger UI: the document lists exactly the
//! contract's routes, and `/metrics` is served but never documented.

use adsb_opensky_server::api::{
    Area, CREDITS_PATH, ENABLED_PATH, METRICS_PATH, OPENAPI_PATH, STATUS_PATH, SWAGGER_UI_PATH,
    TRACK_PATH, WATCH_PATH,
};
use adsb_opensky_server::api_server::{ApiState, router_with_metrics};
use adsb_opensky_server::control::{Budget, Control};
use adsb_opensky_server::credits::Ledger;
use adsb_opensky_server::provider::{OpenSkyProvider, ProviderError, Reply};
use adsb_opensky_server::states::{OpenSkyTrack, StatesResponse};
use adsb_opensky_server::status::OpenSkyStatus;
use adsb_opensky_server::watch::{WatchLimits, WatchSet};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

struct Null;

#[async_trait::async_trait]
impl OpenSkyProvider for Null {
    fn authenticated(&self) -> bool {
        true
    }
    async fn states_by_icao(&self, _: &[String]) -> Result<Reply<StatesResponse>, ProviderError> {
        Err(ProviderError::NotFound)
    }
    async fn states_in_area(&self, _: &Area) -> Result<Reply<StatesResponse>, ProviderError> {
        Err(ProviderError::NotFound)
    }
    async fn track(&self, _: &str, _: Option<i64>) -> Result<Reply<OpenSkyTrack>, ProviderError> {
        Err(ProviderError::NotFound)
    }
}

async fn server() -> (String, watch::Sender<OpenSkyStatus>) {
    let control = Arc::new(Control::new(
        WatchSet::new(WatchLimits::default(), 60_000),
        Ledger::default(),
        None,
        Budget {
            daily_credits: 4_000,
            min_interval: Duration::from_secs(10),
        },
        Arc::new(Null),
        Arc::new(|| 0),
    ));
    let (tx, status) = watch::channel(OpenSkyStatus::initial(true, true, 4_000, 0));
    let app = router_with_metrics(ApiState { control, status }, "pi-dev");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), tx)
}

async fn get(url: &str) -> (u16, String) {
    let r = reqwest::get(url).await.unwrap();
    (r.status().as_u16(), r.text().await.unwrap())
}

#[tokio::test]
async fn the_document_lists_exactly_the_contract_s_operations() {
    let (url, _tx) = server().await;
    let (status, body) = get(&format!("{url}{OPENAPI_PATH}")).await;
    assert_eq!(status, 200);
    let doc: Value = serde_json::from_str(&body).unwrap();
    let ops: BTreeSet<(String, String)> = doc["paths"]
        .as_object()
        .unwrap()
        .iter()
        .flat_map(|(path, item)| {
            ["get", "put", "post", "delete", "patch"]
                .into_iter()
                .filter(|m| item.get(*m).is_some())
                .map(move |m| (path.clone(), m.to_string()))
        })
        .collect();
    let expected: BTreeSet<(String, String)> = [
        (STATUS_PATH, "get"),
        (ENABLED_PATH, "put"),
        (WATCH_PATH, "put"),
        (WATCH_PATH, "delete"),
        (CREDITS_PATH, "get"),
        (TRACK_PATH, "get"),
    ]
    .into_iter()
    .map(|(p, m)| (p.to_string(), m.to_string()))
    .collect();
    assert_eq!(ops, expected);
}

#[tokio::test]
async fn service_states_are_documented_as_serde_writes_them() {
    let (url, _tx) = server().await;
    let (_, body) = get(&format!("{url}{OPENAPI_PATH}")).await;
    assert!(body.contains("rate_limited"));
    assert!(body.contains("unauthorized"));
}

#[tokio::test]
async fn the_track_s_optional_time_is_documented() {
    let (url, _tx) = server().await;
    let (_, body) = get(&format!("{url}{OPENAPI_PATH}")).await;
    let doc: Value = serde_json::from_str(&body).unwrap();
    let params = doc["paths"][TRACK_PATH]["get"]["parameters"]
        .as_array()
        .unwrap();
    let time = params
        .iter()
        .find(|p| p["name"] == "time")
        .expect("time documented");
    assert_eq!(time["in"], "query");
    assert_ne!(time["required"], true);
}

#[tokio::test]
async fn metrics_are_served_but_not_documented() {
    let (url, _tx) = server().await;
    let (status, body) = get(&format!("{url}{METRICS_PATH}")).await;
    assert_eq!(status, 200);
    assert!(body.contains("adsb_opensky_states_credits_used_24h"));
    let (_, doc) = get(&format!("{url}{OPENAPI_PATH}")).await;
    assert!(!doc.contains(METRICS_PATH));
}

#[tokio::test]
async fn swagger_ui_is_served() {
    let (url, _tx) = server().await;
    let (status, body) = get(&format!("{url}{SWAGGER_UI_PATH}/")).await;
    assert_eq!(status, 200);
    assert!(body.to_lowercase().contains("swagger"));
}
