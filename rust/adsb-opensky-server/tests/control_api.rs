//! The control API over real HTTP, driven through the client the desktop uses.

use adsb_opensky_server::api::{Area, WatchRequest};
use adsb_opensky_server::api_client::{ApiClient, ClientError};
use adsb_opensky_server::api_server::{ApiState, router};
use adsb_opensky_server::control::{Budget, Control};
use adsb_opensky_server::credits::{Bucket, Ledger};
use adsb_opensky_server::provider::{OpenSkyProvider, ProviderError, Reply};
use adsb_opensky_server::states::{OpenSkyTrack, StatesResponse, Waypoint};
use adsb_opensky_server::status::OpenSkyStatus;
use adsb_opensky_server::watch::{WatchLimits, WatchSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

struct Fake {
    authenticated: bool,
}

#[async_trait::async_trait]
impl OpenSkyProvider for Fake {
    fn authenticated(&self) -> bool {
        self.authenticated
    }
    async fn states_by_icao(&self, _: &[String]) -> Result<Reply<StatesResponse>, ProviderError> {
        Err(ProviderError::Transient("unused".into()))
    }
    async fn states_in_area(&self, _: &Area) -> Result<Reply<StatesResponse>, ProviderError> {
        Err(ProviderError::Transient("unused".into()))
    }
    async fn track(
        &self,
        icao24: &str,
        time: Option<i64>,
    ) -> Result<Reply<OpenSkyTrack>, ProviderError> {
        if icao24 == "000000" {
            return Err(ProviderError::NotFound);
        }
        Ok(Reply {
            value: OpenSkyTrack {
                icao24: icao24.into(),
                callsign: Some("DLH9LF".into()),
                // Echo the asked time so a test can see it arrived.
                start_time: time.unwrap_or(1),
                end_time: 2,
                path: vec![Waypoint {
                    time: 1,
                    latitude: 47.0,
                    longitude: -1.0,
                    altitude_ft: Some(3_000.0),
                    track_deg: Some(90.0),
                    on_ground: false,
                }],
            },
            remaining: Some(3_996),
        })
    }
}

const NOW: i64 = 1_764_000_000_000;

struct Server {
    client: ApiClient,
    control: Arc<Control>,
    _status: watch::Sender<OpenSkyStatus>,
}

async fn server(authenticated: bool) -> Server {
    let control = Arc::new(Control::new(
        WatchSet::new(WatchLimits::default(), 60_000),
        Ledger::default(),
        None,
        Budget {
            daily_credits: 4_000,
            min_interval: Duration::from_secs(10),
        },
        Arc::new(Fake { authenticated }),
        Arc::new(|| NOW),
    ));
    let (status_tx, status) =
        watch::channel(OpenSkyStatus::initial(true, authenticated, 4_000, NOW));
    let app = router(ApiState {
        control: control.clone(),
        status,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        client: ApiClient::new(format!("http://{addr}")).unwrap(),
        control,
        _status: status_tx,
    }
}

fn watch_of(icao: &[&str]) -> WatchRequest {
    WatchRequest {
        icao24: icao.iter().map(|s| s.to_string()).collect(),
        areas: vec![],
    }
}

#[tokio::test]
async fn the_status_is_served() {
    let s = server(true).await;
    let status = s.client.status().await.unwrap();
    assert!(status.enabled);
    assert!(status.authenticated);
}

#[tokio::test]
async fn a_watch_is_leased_and_reaches_the_union() {
    let s = server(true).await;
    let accepted = s
        .client
        .put_watch("laptop-dev", &watch_of(&["3C6444"]))
        .await
        .unwrap();
    assert_eq!(accepted.icao24, 1);
    assert_eq!(accepted.lease_seconds, 60);
    assert_eq!(accepted.interval_seconds, Some(24.0));
    assert_eq!(s.control.union(NOW).icao24, ["3c6444"]);

    s.client.delete_watch("laptop-dev").await.unwrap();
    assert!(s.control.union(NOW).is_empty());
}

#[tokio::test]
async fn an_invalid_watch_is_a_400_with_the_reason() {
    let s = server(true).await;
    let err = s
        .client
        .put_watch("laptop", &watch_of(&["SIM-0001"]))
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(400));
    assert!(err.to_string().contains("SIM-0001"), "{err}");
}

#[tokio::test]
async fn a_bad_client_id_is_refused() {
    let s = server(true).await;
    let err = s
        .client
        .put_watch("has space", &watch_of(&["3c6444"]))
        .await
        .unwrap_err();
    assert_eq!(err.status(), Some(400));
}

#[tokio::test]
async fn disabling_is_accepted() {
    let s = server(true).await;
    s.client.set_enabled(false).await.unwrap();
    assert!(!s.control.enabled());
}

#[tokio::test]
async fn credits_cover_24_hours() {
    let s = server(true).await;
    s.control.record(Bucket::States, 3, None, NOW - 60_000);
    let report = s.client.credits().await.unwrap();
    assert_eq!(report.hours.len(), 24);
    assert_eq!(report.daily_limit, 4_000);
    assert_eq!(report.hours.iter().map(|h| h.states).sum::<u32>(), 3);
}

#[tokio::test]
async fn a_track_is_served_and_charged() {
    let s = server(true).await;
    let t = s.client.track("3c6444", None).await.unwrap().unwrap();
    assert_eq!(t.path.len(), 1);
    assert_eq!(s.control.used_last_24h(Bucket::Tracks, NOW), 4);
    // No live flight: None, not an error.
    assert_eq!(s.client.track("000000", None).await.unwrap(), None);
}

#[tokio::test]
async fn a_past_track_is_asked_for_at_its_time() {
    let s = server(true).await;
    let yesterday = NOW / 1_000 - 20 * 3_600;
    let t = s
        .client
        .track("3c6444", Some(yesterday))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(t.start_time, yesterday);
}

#[tokio::test]
async fn a_track_time_outside_30_days_is_422() {
    let s = server(true).await;
    let too_old = NOW / 1_000 - 31 * 86_400;
    let err = s.client.track("3c6444", Some(too_old)).await.unwrap_err();
    assert_eq!(err.status(), Some(422));
    assert_eq!(s.control.used_last_24h(Bucket::Tracks, NOW), 0);
}

#[tokio::test]
async fn an_anonymous_service_answers_409_for_tracks() {
    let s = server(false).await;
    let err = s.client.track("3c6444", None).await.unwrap_err();
    assert_eq!(err.status(), Some(409));
}

#[tokio::test]
async fn an_unreachable_service_is_reported_as_such() {
    let client = ApiClient::new("http://127.0.0.1:9").unwrap();
    assert!(matches!(
        client.status().await,
        Err(ClientError::Unreachable { .. })
    ));
}
