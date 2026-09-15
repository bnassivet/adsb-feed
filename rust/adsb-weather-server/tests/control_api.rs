//! The control API over real HTTP, driven through the client the desktop uses.

use adsb_weather_server::api::ENABLED_PATH;
use adsb_weather_server::api_client::{ApiClient, ClientError};
use adsb_weather_server::api_server::{ApiState, router};
use adsb_weather_server::control::Control;
use adsb_weather_server::projection::project;
use adsb_weather_server::refresh::ReportedState;
use adsb_weather_server::state_file::{self, StateStore};
use adsb_weather_server::status::{ServiceState, WeatherStatus};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::watch;

struct Server {
    url: String,
    control: Arc<Control>,
    _status: watch::Sender<WeatherStatus>,
    state_path: PathBuf,
    _dir: TempDir,
}

/// A server whose state file lives at `relative` inside a fresh directory.
async fn server_at(relative: &str) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join(relative);
    let (store, _) = StateStore::open(Some(state_path.clone()));
    let control = Arc::new(Control::new(Arc::new(store)));
    let (status_tx, status) =
        watch::channel(project(control.enabled(), &ReportedState::default(), 1));

    let app = router(ApiState {
        control: control.clone(),
        status,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    Server {
        url: format!("http://{addr}"),
        control,
        _status: status_tx,
        state_path,
        _dir: dir,
    }
}

async fn server() -> Server {
    server_at("state.json").await
}

async fn raw_put(server: &Server, body: &'static str) -> (u16, serde_json::Value) {
    let response = reqwest::Client::new()
        .put(format!("{}{ENABLED_PATH}", server.url))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.bytes().await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

#[tokio::test]
async fn the_status_is_served() {
    let server = server().await;
    let status = ApiClient::new(&server.url).unwrap().status().await.unwrap();
    assert!(status.enabled);
    assert_eq!(status.state, ServiceState::Idle);
}

#[tokio::test]
async fn disabling_is_accepted_and_persisted() {
    let server = server().await;
    ApiClient::new(&server.url)
        .unwrap()
        .set_enabled(false)
        .await
        .unwrap();

    assert!(!server.control.enabled());
    let saved = state_file::load(&server.state_path).unwrap().unwrap();
    assert!(!saved.enabled);
}

#[tokio::test]
async fn a_command_does_not_write_the_status() {
    // CQRS: the command side changes the desired setting; the status changes
    // only when the projection says so. Here nothing projects, so the served
    // status must still be the old one.
    let server = server().await;
    let client = ApiClient::new(&server.url).unwrap();
    client.set_enabled(false).await.unwrap();

    assert!(client.status().await.unwrap().enabled);
}

#[tokio::test]
async fn a_put_answers_202_with_the_accepted_setting() {
    let server = server().await;
    let (status, body) = raw_put(&server, r#"{"enabled":false}"#).await;
    assert_eq!(status, 202);
    assert_eq!(body, serde_json::json!({ "enabled": false }));
}

#[tokio::test]
async fn sending_the_same_setting_twice_is_the_same_as_once() {
    let server = server().await;
    let client = ApiClient::new(&server.url).unwrap();
    client.set_enabled(false).await.unwrap();
    client.set_enabled(false).await.unwrap();
    assert!(!server.control.enabled());
}

#[tokio::test]
async fn a_body_without_the_setting_is_a_400_and_changes_nothing() {
    let server = server().await;
    let (status, body) = raw_put(&server, "{}").await;
    assert_eq!(status, 400);
    assert!(body["error"].is_string(), "{body}");
    assert!(server.control.enabled());
}

#[tokio::test]
async fn a_setting_that_cannot_be_persisted_is_a_500_and_changes_nothing() {
    // The state file's parent is a regular file, so the write fails.
    let server = server_at("blocker/state.json").await;
    std::fs::write(server.state_path.parent().unwrap(), "").unwrap();

    let err = ApiClient::new(&server.url)
        .unwrap()
        .set_enabled(false)
        .await
        .expect_err("the write must fail");
    assert!(
        matches!(
            err,
            ClientError::Status {
                status: 500,
                error: Some(_),
                ..
            }
        ),
        "{err:?}"
    );
    assert!(server.control.enabled());
}

#[tokio::test]
async fn an_unreachable_service_is_reported_with_its_url() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    let url = format!("http://{addr}");
    let err = ApiClient::new(&url)
        .unwrap()
        .set_enabled(false)
        .await
        .expect_err("nothing is listening");
    assert!(matches!(err, ClientError::Unreachable { .. }), "{err:?}");
    assert!(err.to_string().contains(&url), "{err}");
}
