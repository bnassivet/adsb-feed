//! The recorder's `/metrics` endpoint over real HTTP.
//!
//! The point of these, over the unit tests on the projection: that the scrape
//! surface and the tool surface really do share one listener, and that a
//! scrape answers immediately — before any storage query has completed, and
//! without waiting on one.

use adsb_data_engine::SharedStorage;
use adsb_data_server::metrics_export::StatsCache;
use adsb_data_server::server::{MetricsState, router, router_with_metrics};
use std::sync::Arc;
use tokio::sync::RwLock;

fn in_memory_storage() -> SharedStorage {
    let handle = adsb_data_engine::StorageHandle::open(adsb_data_engine::StorageConfig {
        db_path: None,
        source_id: "test".to_string(),
        gap_threshold_ms: 3_600_000,
        share: None,
        remote: None,
    })
    .expect("open in-memory storage");
    Arc::new(RwLock::new(Some(handle)))
}

struct Server {
    url: String,
    cache: StatsCache,
    storage: SharedStorage,
}

async fn server() -> Server {
    let storage = in_memory_storage();
    let cache = StatsCache::new();
    let app = router_with_metrics(
        storage.clone(),
        MetricsState {
            version: "0.1.0".to_string(),
            source_id: "pi-kitchen-prod".to_string(),
            cache: cache.clone(),
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        url: format!("http://{addr}"),
        cache,
        storage,
    }
}

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

#[tokio::test]
async fn metrics_and_tools_share_one_listener() {
    let server = server().await;

    let (status, content_type, body) = get(&format!("{}/metrics", server.url)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(content_type, "text/plain; version=0.0.4");

    let tool = reqwest::Client::new()
        .post(format!("{}/tools/getStorageStats", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(tool.status().as_u16(), 200);
}

#[tokio::test]
async fn a_scrape_before_any_stats_query_reports_storage_down() {
    // Nothing has refreshed the cache yet. The endpoint must still answer --
    // "up but degraded" is a different fact from "process gone", and only the
    // first one can be reported at all.
    let (_, _, body) = get(&format!("{}/metrics", server().await.url)).await;
    assert!(body.contains("adsb_recorder_storage_up 0"), "{body}");
    assert!(body.contains(r#"service="recorder""#), "{body}");
    assert!(!body.contains("adsb_recorder_positions_rows"), "{body}");
}

#[tokio::test]
async fn a_refreshed_cache_shows_up_in_the_next_scrape() {
    let server = server().await;
    // One refresh cycle, driven directly rather than waiting 15 s for the
    // background ticker.
    let cache = server.cache.clone();
    let storage = server.storage.clone();
    tokio::spawn(cache.run(storage, std::time::Duration::from_millis(10)));
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let (_, _, body) = get(&format!("{}/metrics", server.url)).await;
    assert!(body.contains("adsb_recorder_storage_up 1"), "{body}");
    // An empty in-memory database: zero rows, and therefore no oldest record.
    assert!(body.contains("adsb_recorder_positions_rows 0"), "{body}");
    assert!(
        !body.contains("adsb_recorder_oldest_record_timestamp_seconds"),
        "{body}"
    );
    assert!(body.contains("adsb_recorder_stats_age_seconds"), "{body}");
}

#[tokio::test]
async fn the_plain_router_serves_no_metrics() {
    // The desktop embeds exactly this router. If /metrics ever appears here,
    // the Tauri app has quietly become a scrape target.
    let storage = in_memory_storage();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(storage)).await.unwrap() });

    let (status, _, _) = get(&format!("http://{addr}/metrics")).await;
    assert_eq!(status, 404);
}
