//! The control API's OpenAPI document and Swagger UI, over real HTTP.
//!
//! The document is generated from the code, so these tests pin what matters
//! to a consumer: it lists exactly the routes the contract defines, every
//! documented operation is really served, and its schemas say what serde
//! actually writes.

use adsb_weather_server::api::{ENABLED_PATH, OPENAPI_PATH, STATUS_PATH, SWAGGER_UI_PATH};
use adsb_weather_server::api_server::{ApiState, router};
use adsb_weather_server::control::Control;
use adsb_weather_server::projection::project;
use adsb_weather_server::refresh::ReportedState;
use adsb_weather_server::state_file::StateStore;
use adsb_weather_server::status::{RateLimitScope, STATUS_VERSION, ServiceState, WeatherStatus};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;
use tokio::sync::watch;

const METHODS: [&str; 5] = ["get", "put", "post", "delete", "patch"];

struct Server {
    url: String,
    _status: watch::Sender<WeatherStatus>,
}

async fn server() -> Server {
    let control = Arc::new(Control::new(Arc::new(StateStore::in_memory())));
    let (status_tx, status) =
        watch::channel(project(control.enabled(), &ReportedState::default(), 1));
    let app = router(ApiState { control, status });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        url: format!("http://{addr}"),
        _status: status_tx,
    }
}

/// Status, content type and body of a GET.
async fn get(url: &str) -> (u16, String, String) {
    let response = reqwest::get(url).await.unwrap();
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    (status, content_type, response.text().await.unwrap())
}

async fn document(server: &Server) -> Value {
    let (status, _, body) = get(&format!("{}{OPENAPI_PATH}", server.url)).await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str(&body).expect("the document is JSON")
}

/// Every (path, method) the document describes.
fn operations(doc: &Value) -> BTreeSet<(String, String)> {
    doc["paths"]
        .as_object()
        .expect("paths")
        .iter()
        .flat_map(|(path, item)| {
            METHODS
                .iter()
                .filter(|m| item.get(**m).is_some())
                .map(move |m| (path.clone(), m.to_string()))
        })
        .collect()
}

/// The strings an enum schema allows, whether utoipa wrote it as one `enum`
/// or as a `oneOf` of single-value enums (it does the latter for documented
/// variants).
fn enum_values(schema: &Value) -> BTreeSet<String> {
    let as_strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s.as_str().map(String::from))
            .collect()
    };
    if let Some(values) = schema.get("enum") {
        return as_strings(values).into_iter().collect();
    }
    schema["oneOf"]
        .as_array()
        .expect("an enum or a oneOf")
        .iter()
        .flat_map(|variant| as_strings(&variant["enum"]))
        .collect()
}

fn serde_strings<T: serde::Serialize>(values: &[T]) -> BTreeSet<String> {
    values
        .iter()
        .map(|v| {
            serde_json::to_value(v)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

#[tokio::test]
async fn the_document_is_openapi_3_for_this_version() {
    let doc = document(&server().await).await;
    assert!(doc["openapi"].as_str().unwrap().starts_with("3."), "{doc}");
    assert!(!doc["info"]["title"].as_str().unwrap().is_empty());
    assert_eq!(doc["info"]["version"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn it_documents_exactly_the_contract_routes() {
    let doc = document(&server().await).await;
    let expected: BTreeSet<(String, String)> = [
        (STATUS_PATH.to_string(), "get".to_string()),
        (ENABLED_PATH.to_string(), "put".to_string()),
    ]
    .into();
    assert_eq!(operations(&doc), expected);
}

#[tokio::test]
async fn the_command_documents_its_body_and_every_answer() {
    let doc = document(&server().await).await;
    let put = &doc["paths"][ENABLED_PATH]["put"];

    let body_ref = put["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        .as_str()
        .unwrap_or_default();
    assert!(body_ref.ends_with("/EnabledSetting"), "{put}");
    assert_eq!(put["requestBody"]["required"], true);

    let answers: BTreeSet<&str> = put["responses"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(answers, BTreeSet::from(["202", "400", "500"]));
}

#[tokio::test]
async fn the_schemas_say_what_serde_writes() {
    let doc = document(&server().await).await;
    let schemas = &doc["components"]["schemas"];

    // Field names: a sample with every optional field set serialises every key.
    let sample = WeatherStatus {
        version: STATUS_VERSION,
        enabled: true,
        state: ServiceState::Idle,
        consecutive_failures: 0,
        rate_limit: Some(RateLimitScope::Daily),
        last_success_ms: Some(1),
        last_error: Some("e".into()),
        next_fetch_ms: Some(2),
        snapshot_valid_time_ms: Some(3),
        updated_at_ms: 4,
    };
    let written: BTreeSet<String> = serde_json::to_value(&sample)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let documented: BTreeSet<String> = schemas["WeatherStatus"]["properties"]
        .as_object()
        .expect("WeatherStatus properties")
        .keys()
        .cloned()
        .collect();
    assert_eq!(documented, written);

    // Enum strings: exactly the snake_case words on the wire.
    assert_eq!(
        enum_values(&schemas["ServiceState"]),
        serde_strings(&[
            ServiceState::Idle,
            ServiceState::Fetching,
            ServiceState::Retrying,
            ServiceState::RateLimited,
            ServiceState::Rejected,
            ServiceState::Disabled,
        ])
    );
    assert_eq!(
        enum_values(&schemas["RateLimitScope"]),
        serde_strings(&[
            RateLimitScope::Minutely,
            RateLimitScope::Hourly,
            RateLimitScope::Daily,
            RateLimitScope::Unknown,
        ])
    );
    assert!(schemas["ApiError"]["properties"]["error"].is_object());
}

#[tokio::test]
async fn every_documented_operation_is_routed() {
    let server = server().await;
    let doc = document(&server).await;
    let http = reqwest::Client::new();

    for (path, method) in operations(&doc) {
        let url = format!("{}{path}", server.url);
        let response = match method.as_str() {
            "get" => http.get(&url).send().await.unwrap(),
            "put" => http
                .put(&url)
                .header("content-type", "application/json")
                .body(r#"{"enabled":true}"#)
                .send()
                .await
                .unwrap(),
            other => panic!("no request written for {other} {path}"),
        };
        let status = response.status().as_u16();
        assert!(
            status != 404 && status != 405,
            "{method} {path} is documented but answers {status}"
        );
    }
}

#[tokio::test]
async fn swagger_ui_is_served_and_points_at_the_document() {
    let server = server().await;

    let (status, content_type, body) = get(&format!("{}{SWAGGER_UI_PATH}/", server.url)).await;
    assert_eq!(status, 200, "{body}");
    assert!(content_type.starts_with("text/html"), "{content_type}");

    let (status, _, initializer) = get(&format!(
        "{}{SWAGGER_UI_PATH}/swagger-initializer.js",
        server.url
    ))
    .await;
    assert_eq!(status, 200);
    assert!(initializer.contains(OPENAPI_PATH), "{initializer}");
}
