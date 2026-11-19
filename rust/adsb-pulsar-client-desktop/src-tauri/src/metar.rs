//! METAR reports from the AviationWeather.gov Data API.
//!
//! Like `airspace.rs`, Rust only fetches and caches; the webview interprets.
//! Unlike airspaces, the cache lives **in memory only**: an observation is
//! stale within the hour, so there is nothing worth keeping offline (cache
//! policy in MAP_ENGINES.md). A failed refresh serves the last snapshot with
//! its age and the error, never nothing.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use std::future::Future;

const API: &str = "https://aviationweather.gov/api/data/metar";

/// AWC asks API clients to identify themselves.
pub const USER_AGENT: &str = "adsb-pulsar-client-desktop (METAR layer)";

/// A snapshot younger than this, for the same box, is served as is.
pub const TTL_SECONDS: i64 = 300;
/// Never download twice within this, even on an explicit reload.
pub const MIN_INTERVAL_SECONDS: i64 = 60;

/// A lat/lng box, rounded to 0.1° so a receiver moving by metres reuses the cache.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bbox {
    pub min_lat: f64,
    pub min_lon: f64,
    pub max_lat: f64,
    pub max_lon: f64,
}

/// The box `radius_nm` around a point, rounded outwards to 0.1°, clamped to the world.
pub fn bbox_around(lat: f64, lng: f64, radius_nm: f64) -> Bbox {
    let d_lat = radius_nm / 60.0;
    let d_lon = d_lat / lat.to_radians().cos().max(0.01);
    let down = |v: f64| (v * 10.0).floor() / 10.0;
    let up = |v: f64| (v * 10.0).ceil() / 10.0;
    Bbox {
        min_lat: down(lat - d_lat).max(-90.0),
        min_lon: down(lng - d_lon).max(-180.0),
        max_lat: up(lat + d_lat).min(90.0),
        max_lon: up(lng + d_lon).min(180.0),
    }
}

pub fn metar_url(b: &Bbox) -> String {
    format!(
        "{API}?bbox={},{},{},{}&format=json",
        b.min_lat, b.min_lon, b.max_lat, b.max_lon
    )
}

/// The response body → raw items. 204 means "no reports in the box".
pub fn parse_response(status: u16, body: &[u8]) -> Result<Vec<Value>, String> {
    if status == 204 {
        return Ok(Vec::new());
    }
    if !(200..300).contains(&status) {
        let snippet: String = String::from_utf8_lossy(body).chars().take(200).collect();
        return Err(format!(
            "AviationWeather.gov answered HTTP {status}: {snippet}"
        ));
    }
    serde_json::from_slice::<Vec<Value>>(body)
        .map_err(|e| format!("unexpected AviationWeather.gov response: {e}"))
}

/// Fetch the box's latest reports.
pub async fn fetch(client: &reqwest::Client, bbox: Bbox) -> Result<Vec<Value>, String> {
    let response = client
        .get(metar_url(&bbox))
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("AviationWeather.gov unreachable: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("AviationWeather.gov read failed: {e}"))?;
    parse_response(status, &body)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Cache,
    Download,
    StaleCache,
    None,
}

/// What the webview receives.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetarSnapshot {
    pub items: Vec<Value>,
    /// When the items were downloaded, epoch ms; None when there are none.
    pub fetched_at_ms: Option<i64>,
    pub origin: Origin,
    pub error: Option<String>,
}

/// The last download.
#[derive(Debug, Clone)]
pub struct MetarCache {
    pub fetched_at: DateTime<Utc>,
    pub bbox: Bbox,
    pub items: Vec<Value>,
}

/// Serve, refresh or fall back; see the module comment.
pub async fn load_metars<F, Fut>(
    cache: &mut Option<MetarCache>,
    now: DateTime<Utc>,
    bbox: Bbox,
    force: bool,
    fetch: F,
) -> MetarSnapshot
where
    F: FnOnce(Bbox) -> Fut,
    Fut: Future<Output = Result<Vec<Value>, String>>,
{
    let same_box = cache.as_ref().filter(|c| c.bbox == bbox);
    if let Some(c) = same_box {
        let age = now - c.fetched_at;
        if age < Duration::seconds(MIN_INTERVAL_SECONDS)
            || (!force && age < Duration::seconds(TTL_SECONDS))
        {
            return snapshot(c, Origin::Cache, None);
        }
    }
    let has_fallback = same_box.is_some();
    match fetch(bbox).await {
        Ok(items) => {
            let c = cache.insert(MetarCache {
                fetched_at: now,
                bbox,
                items,
            });
            snapshot(c, Origin::Download, None)
        }
        Err(error) => match cache.as_ref().filter(|_| has_fallback) {
            Some(c) => snapshot(c, Origin::StaleCache, Some(error)),
            None => MetarSnapshot {
                items: Vec::new(),
                fetched_at_ms: None,
                origin: Origin::None,
                error: Some(error),
            },
        },
    }
}

fn snapshot(c: &MetarCache, origin: Origin, error: Option<String>) -> MetarSnapshot {
    MetarSnapshot {
        items: c.items.clone(),
        fetched_at_ms: Some(c.fetched_at.timestamp_millis()),
        origin,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_795_000_000 + s, 0).unwrap()
    }

    const MTL: (f64, f64) = (45.47, -73.74);

    fn mtl_box() -> Bbox {
        bbox_around(MTL.0, MTL.1, 300.0)
    }

    fn items(ids: &[&str]) -> Vec<Value> {
        ids.iter().map(|i| json!({ "icaoId": i })).collect()
    }

    fn ids(s: &MetarSnapshot) -> Vec<String> {
        s.items
            .iter()
            .map(|i| i["icaoId"].as_str().unwrap().to_string())
            .collect()
    }

    // --- Box ------------------------------------------------------------------

    #[test]
    fn box_covers_the_radius_and_rounds_outwards() {
        let b = mtl_box();
        // 300 NM = 5° of latitude.
        assert_eq!((b.min_lat, b.max_lat), (40.4, 50.5));
        // Longitude widens with 1/cos(lat): ~7.1° at 45.5°N.
        assert!(
            b.min_lon <= MTL.1 - 7.1 && b.max_lon >= MTL.1 + 7.1,
            "{b:?}"
        );
        for v in [b.min_lat, b.min_lon, b.max_lat, b.max_lon] {
            assert!(
                ((v * 10.0).round() - v * 10.0).abs() < 1e-9,
                "{v} is on the 0.1° grid"
            );
        }
    }

    #[test]
    fn a_receiver_moving_by_metres_keeps_the_same_box() {
        assert_eq!(
            bbox_around(45.4701, -73.7402, 300.0),
            bbox_around(45.4699, -73.7398, 300.0)
        );
    }

    #[test]
    fn box_is_clamped_to_the_world() {
        let b = bbox_around(88.0, 179.0, 300.0);
        assert!(b.max_lat <= 90.0 && b.max_lon <= 180.0 && b.min_lon >= -180.0);
    }

    #[test]
    fn url_lists_the_box_south_west_then_north_east() {
        let b = Bbox {
            min_lat: 40.4,
            min_lon: -80.9,
            max_lat: 50.5,
            max_lon: -66.6,
        };
        assert_eq!(
            metar_url(&b),
            "https://aviationweather.gov/api/data/metar?bbox=40.4,-80.9,50.5,-66.6&format=json"
        );
    }

    // --- Response -------------------------------------------------------------

    #[test]
    fn response_keeps_items_verbatim() {
        let body = json!([{ "icaoId": "CYUL", "rawOb": "METAR CYUL ..." }]).to_string();
        let v = parse_response(200, body.as_bytes()).unwrap();
        assert_eq!(v[0]["rawOb"], "METAR CYUL ...");
    }

    #[test]
    fn no_content_is_an_empty_box_not_an_error() {
        assert_eq!(parse_response(204, b"").unwrap(), Vec::<Value>::new());
    }

    #[test]
    fn errors_name_the_status() {
        assert!(
            parse_response(429, b"slow down")
                .unwrap_err()
                .contains("429")
        );
        assert!(parse_response(200, b"<html>").is_err());
        assert!(parse_response(200, br#"{"error":"x"}"#).is_err());
    }

    // --- Cache ----------------------------------------------------------------

    #[tokio::test]
    async fn first_load_downloads() {
        let mut cache = None;
        let s = load_metars(&mut cache, t(0), mtl_box(), false, |_| async {
            Ok(items(&["CYUL"]))
        })
        .await;
        assert_eq!(
            (s.origin, ids(&s)),
            (Origin::Download, vec!["CYUL".to_string()])
        );
        assert_eq!(s.fetched_at_ms, Some(t(0).timestamp_millis()));
        assert!(s.error.is_none() && cache.is_some());
    }

    #[tokio::test]
    async fn fresh_snapshot_for_the_same_box_is_served_from_memory() {
        let mut cache = None;
        load_metars(&mut cache, t(0), mtl_box(), false, |_| async {
            Ok(items(&["CYUL"]))
        })
        .await;
        let s = load_metars(
            &mut cache,
            t(TTL_SECONDS - 1),
            mtl_box(),
            false,
            |_| async { panic!("must not fetch") },
        )
        .await;
        assert_eq!(s.origin, Origin::Cache);
        assert_eq!(s.fetched_at_ms, Some(t(0).timestamp_millis()));
    }

    #[tokio::test]
    async fn an_old_snapshot_is_refreshed() {
        let mut cache = None;
        load_metars(&mut cache, t(0), mtl_box(), false, |_| async {
            Ok(items(&["OLD"]))
        })
        .await;
        let s = load_metars(&mut cache, t(TTL_SECONDS), mtl_box(), false, |_| async {
            Ok(items(&["NEW"]))
        })
        .await;
        assert_eq!(
            (s.origin, ids(&s)),
            (Origin::Download, vec!["NEW".to_string()])
        );
    }

    #[tokio::test]
    async fn a_new_box_is_downloaded_even_when_fresh() {
        let mut cache = None;
        load_metars(&mut cache, t(0), mtl_box(), false, |_| async {
            Ok(items(&["CYUL"]))
        })
        .await;
        let paris = bbox_around(49.0, 2.5, 300.0);
        let s = load_metars(&mut cache, t(10), paris, false, |b| async move {
            assert_eq!(b, paris);
            Ok(items(&["LFPG"]))
        })
        .await;
        assert_eq!(ids(&s), ["LFPG"]);
    }

    #[tokio::test]
    async fn force_refreshes_but_not_within_the_minimum_interval() {
        let mut cache = None;
        load_metars(&mut cache, t(0), mtl_box(), false, |_| async {
            Ok(items(&["A"]))
        })
        .await;
        let s = load_metars(
            &mut cache,
            t(MIN_INTERVAL_SECONDS - 1),
            mtl_box(),
            true,
            |_| async { panic!("too soon") },
        )
        .await;
        assert_eq!(s.origin, Origin::Cache);
        let s = load_metars(
            &mut cache,
            t(MIN_INTERVAL_SECONDS),
            mtl_box(),
            true,
            |_| async { Ok(items(&["B"])) },
        )
        .await;
        assert_eq!(
            (s.origin, ids(&s)),
            (Origin::Download, vec!["B".to_string()])
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_serves_the_last_snapshot_with_the_error() {
        let mut cache = None;
        load_metars(&mut cache, t(0), mtl_box(), false, |_| async {
            Ok(items(&["CYUL"]))
        })
        .await;
        let s = load_metars(
            &mut cache,
            t(TTL_SECONDS + 5),
            mtl_box(),
            false,
            |_| async { Err("HTTP 503".to_string()) },
        )
        .await;
        assert_eq!(s.origin, Origin::StaleCache);
        assert_eq!(ids(&s), ["CYUL"]);
        assert_eq!(
            s.fetched_at_ms,
            Some(t(0).timestamp_millis()),
            "the age stays honest"
        );
        assert_eq!(s.error.as_deref(), Some("HTTP 503"));
    }

    #[tokio::test]
    async fn a_failure_with_nothing_cached_for_that_box_is_reported() {
        let mut cache = None;
        load_metars(&mut cache, t(0), mtl_box(), false, |_| async {
            Ok(items(&["CYUL"]))
        })
        .await;
        // Another place's reports are not a fallback for this one.
        let s = load_metars(
            &mut cache,
            t(10),
            bbox_around(49.0, 2.5, 300.0),
            false,
            |_| async { Err("offline".to_string()) },
        )
        .await;
        assert_eq!(s.origin, Origin::None);
        assert!(s.items.is_empty() && s.fetched_at_ms.is_none());
        assert_eq!(s.error.as_deref(), Some("offline"));
    }

    #[test]
    fn serialises_for_the_webview_in_camel_case() {
        let s = MetarSnapshot {
            items: vec![],
            fetched_at_ms: Some(5),
            origin: Origin::StaleCache,
            error: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["origin"], "stale-cache");
        assert_eq!(v["fetchedAtMs"], 5);
    }

    /// The real service: `cargo test -p adsb-pulsar-client-desktop metar -- --ignored`.
    #[tokio::test]
    #[ignore = "network: calls aviationweather.gov"]
    async fn live_service_returns_montreal() {
        let client = reqwest::Client::new();
        let v = fetch(&client, mtl_box()).await.expect("live fetch");
        assert!(v.len() > 20, "only {} stations", v.len());
        let cyul = v
            .iter()
            .find(|i| i["icaoId"] == "CYUL")
            .expect("CYUL in the box");
        for field in ["rawOb", "lat", "lon", "obsTime", "altim"] {
            assert!(cyul.get(field).is_some(), "CYUL lacks {field}");
        }
    }

    #[test]
    fn retry_interval_is_shorter_than_the_ttl() {
        assert!(Duration::seconds(MIN_INTERVAL_SECONDS) < Duration::seconds(TTL_SECONDS));
    }
}
