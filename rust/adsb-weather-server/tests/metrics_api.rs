//! The Prometheus endpoint over real HTTP, on the control API's own listener.
//!
//! What matters to a scraper: it is reachable where the control API is, it
//! answers the exposition content type, and what it reports tracks the status
//! the service is actually publishing -- including a change made through the
//! control API itself.

use adsb_weather_server::api::METRICS_PATH;
use adsb_weather_server::api_client::ApiClient;
use adsb_weather_server::api_server::{ApiState, router_with_metrics};
use adsb_weather_server::control::Control;
use adsb_weather_server::projection::project;
use adsb_weather_server::refresh::ReportedState;
use adsb_weather_server::state_file::StateStore;
use adsb_weather_server::status::{ServiceState, WeatherStatus};
use std::sync::Arc;
use tokio::sync::watch;

struct Server {
    url: String,
    status: watch::Sender<WeatherStatus>,
}

async fn server() -> Server {
    let control = Arc::new(Control::new(Arc::new(StateStore::in_memory())));
    let (status_tx, status) =
        watch::channel(project(control.enabled(), &ReportedState::default(), 1));
    let app = router_with_metrics(ApiState { control, status }, "pi-kitchen-prod");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        url: format!("http://{addr}"),
        status: status_tx,
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

async fn scrape(server: &Server) -> String {
    let (status, content_type, body) = get(&format!("{}{METRICS_PATH}", server.url)).await;
    assert_eq!(status, 200, "{body}");
    assert!(
        content_type.starts_with("text/plain"),
        "a scrape must not be served as {content_type}"
    );
    body
}

#[tokio::test]
async fn metrics_are_served_on_the_same_port_as_the_control_api() {
    let server = server().await;
    // Same origin, both answering: one listener, two surfaces.
    let body = scrape(&server).await;
    assert!(body.contains("adsb_weather_state{"), "{body}");
    assert!(ApiClient::new(&server.url).unwrap().status().await.is_ok());
}

#[tokio::test]
async fn the_body_declares_the_prometheus_exposition_version() {
    let server = server().await;
    let (_, content_type, _) = get(&format!("{}{METRICS_PATH}", server.url)).await;
    assert_eq!(content_type, "text/plain; version=0.0.4");
}

#[tokio::test]
async fn the_exposition_carries_the_configured_identity() {
    let body = scrape(&server().await).await;
    assert!(body.contains(r#"service="weather""#), "{body}");
    assert!(body.contains(r#"source_id="pi-kitchen-prod""#), "{body}");
    assert!(body.contains(r#"stage="prod""#), "{body}");
}

#[tokio::test]
async fn a_status_pushed_through_the_channel_shows_up_in_the_next_scrape() {
    let server = server().await;
    assert!(
        scrape(&server)
            .await
            .contains(r#"adsb_weather_state{state="idle"} 1"#)
    );

    let reported = ReportedState {
        state: ServiceState::RateLimited,
        consecutive_failures: 4,
        ..Default::default()
    };
    server.status.send(project(true, &reported, 2)).unwrap();

    let body = scrape(&server).await;
    assert!(
        body.contains(r#"adsb_weather_state{state="rate_limited"} 1"#),
        "{body}"
    );
    assert!(
        body.contains(r#"adsb_weather_state{state="idle"} 0"#),
        "the previous state must drop to zero, not vanish: {body}"
    );
    assert!(
        body.contains("adsb_weather_consecutive_failures 4"),
        "{body}"
    );
}

#[tokio::test]
async fn an_unknown_path_on_the_metrics_listener_is_still_a_404() {
    let (status, _, _) = get(&format!("{}/nope", server().await.url)).await;
    assert_eq!(status, 404);
}
