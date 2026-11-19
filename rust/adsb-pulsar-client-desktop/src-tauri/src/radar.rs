//! Météo-France rain radar: key check, freshness check, download, cache.
//!
//! The 500 m rainfall mosaic is 2.6 MB and changes every 5 minutes. The small
//! description JSON says which 5-minute image is current (`validity_time`), so
//! the mosaic is only downloaded when that changes. The current image lives
//! in memory; the last hour is also kept on disk for the animation
//! (`radar_history`).

use crate::radar_grid::RainField;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use std::future::Future;
use std::sync::Arc;

pub const KEY_ENV: &str = "ADSB_METEOFRANCE_API_KEY";
const API: &str = "https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU";

/// The description is asked at most this often while the layer is on.
pub const CHECK_SECONDS: i64 = 150;
/// Even an explicit refresh waits this long between two checks.
pub const MIN_CHECK_SECONDS: i64 = 30;

pub fn description_url() -> String {
    API.to_string()
}

/// The 500 m product is the HDF5 one (1 km is BUFR).
pub fn product_url() -> String {
    format!("{API}/produit?maille=500")
}

pub const NO_KEY_ERROR: &str = "No Météo-France API key: set [desktop] meteofrance_api_key (free, portail-api.meteofrance.fr → Données Publiques Radar)";

/// The `exp` claim of a portal key (a JWT), epoch seconds; None if it has none.
pub fn key_expiry(key: &str) -> Option<i64> {
    use base64::Engine;
    let payload = key.trim().split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .get("exp")?
        .as_i64()
}

/// Why a key cannot work, before spending a request on it.
pub fn key_problem(key: Option<&str>, now: DateTime<Utc>) -> Option<String> {
    let key = key.map(str::trim).filter(|k| !k.is_empty());
    let Some(key) = key else {
        return Some(NO_KEY_ERROR.to_string());
    };
    let exp = key_expiry(key).and_then(|e| DateTime::from_timestamp(e, 0))?;
    (exp <= now).then(|| {
        format!(
            "Météo-France API key expired on {} UTC: generate a new one (validity -1 = no expiry) and update [desktop] meteofrance_api_key",
            exp.format("%Y-%m-%d %H:%M")
        )
    })
}

/// `validity_time` of the current image, from the description JSON.
pub fn parse_validity(body: &[u8]) -> Result<DateTime<Utc>, String> {
    let v: serde_json::Value = serde_json::from_slice(body)
        .map_err(|e| format!("unexpected Météo-France response: {e}"))?;
    let links = v
        .get("links")
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();
    // Prefer the HDF5 link's time; all links of one description share it.
    let time = links
        .iter()
        .filter(|l| l.get("type").and_then(|t| t.as_str()) == Some("application/x-hdf"))
        .chain(links.iter())
        .find_map(|l| l.get("validity_time").and_then(|t| t.as_str()))
        .ok_or("Météo-France description has no validity_time")?;
    DateTime::parse_from_rfc3339(time)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|e| format!("bad validity_time {time:?}: {e}"))
}

/// A non-2xx answer, phrased for the panel.
pub fn http_error(status: u16, body: &str) -> String {
    match status {
        401 => "Météo-France rejected the key (HTTP 401): check [desktop] meteofrance_api_key".to_string(),
        403 => "Météo-France refused access (HTTP 403): subscribe the key's application to Données Publiques Radar".to_string(),
        _ => {
            let snippet: String = body.chars().take(200).collect();
            format!("Météo-France answered HTTP {status}: {snippet}")
        }
    }
}

/// GET with the key; the body on 2xx, a phrased error otherwise.
pub async fn get(client: &reqwest::Client, key: &str, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header("apikey", key)
        .send()
        .await
        .map_err(|e| format!("Météo-France unreachable: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Météo-France read failed: {e}"))?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &String::from_utf8_lossy(&body)));
    }
    Ok(body.to_vec())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Cache,
    Download,
    StaleCache,
    None,
}

/// What the webview receives: the image is already coloured and in Web
/// Mercator, so the map only places it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarSnapshot {
    /// PNG, base64.
    pub png_base64: Option<String>,
    /// [south, west, north, east] of the image.
    pub bounds: Option<[f64; 4]>,
    /// End of the accumulation window: the time the image shows.
    pub valid_time_ms: Option<i64>,
    pub accumulation_minutes: Option<f64>,
    pub origin: Origin,
    pub error: Option<String>,
    /// The colour scale the image was drawn with, for the legend.
    pub scale: Vec<RadarBand>,
}

/// One band of the colour scale: rates from `from_mm_h` up to the next band.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadarBand {
    pub from_mm_h: f64,
    pub color: &'static str,
}

/// `radar_grid::SCALE` for the webview: the legend can never disagree with the image.
pub fn legend() -> Vec<RadarBand> {
    crate::radar_grid::SCALE
        .iter()
        .map(|&(from_mm_h, color)| RadarBand { from_mm_h, color })
        .collect()
}

/// Rendered image side, in pixels: ~0.9 km per pixel over a 300 NM radius,
/// against the mosaic's 500 m cells.
pub const IMAGE_PX: usize = 1200;

/// The last decoded mosaic.
pub struct RadarCache {
    pub validity: DateTime<Utc>,
    pub field: Arc<RainField>,
    /// Last time the description was asked, successfully or not.
    pub checked_at: DateTime<Utc>,
}

/// What `load_radar` decided; the command renders `field` for the webview.
pub struct RadarLoad {
    pub field: Option<Arc<RainField>>,
    pub validity: Option<DateTime<Utc>>,
    pub origin: Origin,
    pub error: Option<String>,
}

/// Serve, check, download or fall back; see the module comment.
pub async fn load_radar<D, DF, P, PF, Decode>(
    cache: &mut Option<RadarCache>,
    now: DateTime<Utc>,
    force: bool,
    describe: D,
    download: P,
    decode: Decode,
) -> RadarLoad
where
    D: FnOnce() -> DF,
    DF: Future<Output = Result<DateTime<Utc>, String>>,
    P: FnOnce() -> PF,
    PF: Future<Output = Result<Vec<u8>, String>>,
    Decode: FnOnce(DateTime<Utc>, Vec<u8>) -> Result<RainField, String>,
{
    if let Some(c) = cache.as_ref() {
        let floor = if force {
            MIN_CHECK_SECONDS
        } else {
            CHECK_SECONDS
        };
        if now - c.checked_at < Duration::seconds(floor) {
            return served(c, Origin::Cache, None);
        }
    }
    let outcome = match describe().await {
        Err(e) => Err(e),
        Ok(validity) if cache.as_ref().is_some_and(|c| c.validity == validity) => Ok(None),
        Ok(validity) => match download().await.and_then(|b| decode(validity, b)) {
            Ok(field) => Ok(Some((validity, field))),
            Err(e) => Err(e),
        },
    };
    match outcome {
        Ok(Some((validity, field))) => {
            let c = cache.insert(RadarCache {
                validity,
                field: Arc::new(field),
                checked_at: now,
            });
            served(c, Origin::Download, None)
        }
        Ok(None) => {
            let c = cache.as_mut().expect("unchanged implies cached");
            c.checked_at = now;
            served(c, Origin::Cache, None)
        }
        Err(error) => match cache.as_mut() {
            Some(c) => {
                // Not retried before the next interval: a dead network must not
                // turn every poll into a request.
                c.checked_at = now;
                served(c, Origin::StaleCache, Some(error))
            }
            None => RadarLoad {
                field: None,
                validity: None,
                origin: Origin::None,
                error: Some(error),
            },
        },
    }
}

fn served(c: &RadarCache, origin: Origin, error: Option<String>) -> RadarLoad {
    RadarLoad {
        field: Some(c.field.clone()),
        validity: Some(c.validity),
        origin,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radar_grid::decode_odim;
    use base64::Engine;
    use std::cell::Cell;

    const TINY: &[u8] = include_bytes!("testdata/odim_acrr_tiny.h5");

    fn t(s: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_795_000_000 + s, 0).unwrap()
    }

    /// An unsigned JWT with the given claims (the app never verifies signatures).
    fn jwt(claims: &str) -> String {
        let b = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        format!("{}.{}.sig", b(r#"{"typ":"JWT","alg":"RS256"}"#), b(claims))
    }

    // --- Key ----------------------------------------------------------------------

    #[test]
    fn reads_the_expiry_of_a_portal_key() {
        assert_eq!(
            key_expiry(&jwt(r#"{"exp":1795057681,"token_type":"apiKey"}"#)),
            Some(1_795_057_681)
        );
        assert_eq!(key_expiry(&jwt(r#"{"token_type":"apiKey"}"#)), None);
        assert_eq!(key_expiry("not-a-jwt"), None);
    }

    #[test]
    fn says_when_a_key_cannot_work() {
        assert_eq!(key_problem(None, t(0)).as_deref(), Some(NO_KEY_ERROR));
        assert_eq!(key_problem(Some("  "), t(0)).as_deref(), Some(NO_KEY_ERROR));
        // The first key generated for this project lived 5 seconds.
        let expired = jwt(&format!(r#"{{"exp":{}}}"#, t(-10).timestamp()));
        let msg = key_problem(Some(&expired), t(0)).unwrap();
        assert!(
            msg.contains("expired") && msg.contains("2026-11-18"),
            "{msg}"
        );
        assert_eq!(
            key_problem(
                Some(&jwt(&format!(r#"{{"exp":{}}}"#, t(3600).timestamp()))),
                t(0)
            ),
            None
        );
        // A key that is not a JWT is left to the server to judge.
        assert_eq!(key_problem(Some("opaque-key"), t(0)), None);
    }

    // --- Description ----------------------------------------------------------------

    #[test]
    fn reads_the_validity_time() {
        let body = br#"{"title":"x","links":[{"rel":"self"},{"rel":"data","type":"application/x-hdf","validity_time":"2026-11-19T03:10:00Z"}]}"#;
        assert_eq!(
            parse_validity(body).unwrap().to_rfc3339(),
            "2026-11-19T03:10:00+00:00"
        );
        assert!(parse_validity(br#"{"links":[]}"#).is_err());
        assert!(parse_validity(b"<html>").is_err());
    }

    #[test]
    fn http_errors_point_at_the_key() {
        assert!(http_error(401, "Invalid Credentials").contains("meteofrance_api_key"));
        assert!(
            http_error(403, "").contains("Données Publiques Radar"),
            "a 403 means not subscribed"
        );
        assert!(http_error(429, "").contains("429"));
    }

    // --- Cache -----------------------------------------------------------------------

    fn decode(_: DateTime<Utc>, b: Vec<u8>) -> Result<RainField, String> {
        decode_odim(b)
    }

    async fn first(cache: &mut Option<RadarCache>, now: DateTime<Utc>) -> RadarLoad {
        load_radar(
            cache,
            now,
            false,
            || async { Ok(t(0)) },
            || async { Ok(TINY.to_vec()) },
            decode,
        )
        .await
    }

    #[tokio::test]
    async fn first_load_downloads_and_decodes() {
        let mut cache = None;
        let r = first(&mut cache, t(10)).await;
        assert_eq!(r.origin, Origin::Download);
        assert_eq!(r.validity, Some(t(0)));
        assert_eq!(r.field.unwrap().xsize, 6);
        assert!(r.error.is_none());
    }

    #[tokio::test]
    async fn decode_is_told_which_image_it_has() {
        let mut cache = None;
        let mut seen = None;
        load_radar(
            &mut cache,
            t(10),
            false,
            || async { Ok(t(5)) },
            || async { Ok(TINY.to_vec()) },
            |v, b| {
                seen = Some(v);
                decode(v, b)
            },
        )
        .await;
        assert_eq!(
            seen,
            Some(t(5)),
            "the history files each mosaic under its time"
        );
    }

    #[tokio::test]
    async fn within_the_check_interval_nothing_is_asked() {
        let mut cache = None;
        first(&mut cache, t(10)).await;
        let r = load_radar(
            &mut cache,
            t(10 + CHECK_SECONDS - 1),
            false,
            || async { panic!("no check") },
            || async { panic!("no download") },
            decode,
        )
        .await;
        assert_eq!(r.origin, Origin::Cache);
        assert!(r.field.is_some());
    }

    #[tokio::test]
    async fn an_unchanged_image_is_not_downloaded_again() {
        let mut cache = None;
        first(&mut cache, t(10)).await;
        let r = load_radar(
            &mut cache,
            t(10 + CHECK_SECONDS),
            false,
            || async { Ok(t(0)) },
            || async { panic!("same image") },
            decode,
        )
        .await;
        assert_eq!(r.origin, Origin::Cache);
    }

    #[tokio::test]
    async fn a_new_image_is_downloaded() {
        let mut cache = None;
        first(&mut cache, t(10)).await;
        let downloads = Cell::new(0);
        let r = load_radar(
            &mut cache,
            t(10 + CHECK_SECONDS),
            false,
            || async { Ok(t(300)) },
            || {
                downloads.set(downloads.get() + 1);
                async { Ok(TINY.to_vec()) }
            },
            decode,
        )
        .await;
        assert_eq!(
            (r.origin, r.validity, downloads.get()),
            (Origin::Download, Some(t(300)), 1)
        );
    }

    #[tokio::test]
    async fn force_checks_early_but_not_within_the_floor() {
        let mut cache = None;
        first(&mut cache, t(10)).await;
        let r = load_radar(
            &mut cache,
            t(10 + MIN_CHECK_SECONDS - 1),
            true,
            || async { panic!("too soon") },
            || async { panic!() },
            decode,
        )
        .await;
        assert_eq!(r.origin, Origin::Cache);
        let r = load_radar(
            &mut cache,
            t(10 + MIN_CHECK_SECONDS),
            true,
            || async { Ok(t(0)) },
            || async { panic!("same image") },
            decode,
        )
        .await;
        assert_eq!(r.origin, Origin::Cache);
    }

    #[tokio::test]
    async fn a_failure_serves_the_last_image_with_the_error() {
        let mut cache = None;
        first(&mut cache, t(10)).await;
        let r = load_radar(
            &mut cache,
            t(10 + CHECK_SECONDS),
            false,
            || async { Err("HTTP 503".to_string()) },
            || async { panic!() },
            decode,
        )
        .await;
        assert_eq!(r.origin, Origin::StaleCache);
        assert_eq!(r.validity, Some(t(0)), "the image keeps its own time");
        assert_eq!(r.error.as_deref(), Some("HTTP 503"));
        // A broken download is a failure too.
        let r = load_radar(
            &mut cache,
            t(10 + 2 * CHECK_SECONDS),
            false,
            || async { Ok(t(300)) },
            || async { Ok(b"garbage".to_vec()) },
            decode,
        )
        .await;
        assert_eq!(r.origin, Origin::StaleCache);
        assert!(r.error.unwrap().contains("radar file"));
    }

    #[tokio::test]
    async fn a_failure_with_nothing_cached_is_reported() {
        let mut cache = None;
        let r = load_radar(
            &mut cache,
            t(0),
            false,
            || async { Err("offline".to_string()) },
            || async { panic!() },
            decode,
        )
        .await;
        assert_eq!(r.origin, Origin::None);
        assert!(r.field.is_none() && r.validity.is_none());
        assert_eq!(r.error.as_deref(), Some("offline"));
    }

    #[tokio::test]
    async fn a_failed_check_is_not_retried_at_once() {
        // Otherwise a dead network means a request on every render.
        let mut cache = None;
        first(&mut cache, t(10)).await;
        load_radar(
            &mut cache,
            t(10 + CHECK_SECONDS),
            false,
            || async { Err("x".to_string()) },
            || async { panic!() },
            decode,
        )
        .await;
        let r = load_radar(
            &mut cache,
            t(10 + CHECK_SECONDS + 1),
            false,
            || async { panic!("retried at once") },
            || async { panic!() },
            decode,
        )
        .await;
        assert_eq!(r.origin, Origin::Cache);
    }

    /// The real service, end to end. Needs a key:
    /// `ADSB_METEOFRANCE_API_KEY=… cargo test -p adsb-pulsar-client-desktop radar -- --ignored`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "network: calls Météo-France with a key"]
    async fn live_service_end_to_end() {
        let key = std::env::var(KEY_ENV).expect("set ADSB_METEOFRANCE_API_KEY");
        assert_eq!(key_problem(Some(&key), Utc::now()), None, "key unusable");
        let client = reqwest::Client::new();
        let validity =
            parse_validity(&get(&client, &key, &description_url()).await.unwrap()).unwrap();
        assert!(
            Utc::now() - validity < Duration::minutes(30),
            "image is {validity}"
        );
        let field = decode_odim(get(&client, &key, &product_url()).await.unwrap()).unwrap();
        assert_eq!((field.xsize, field.ysize), (3472, 3472));
        assert_eq!(
            field.end, validity,
            "the file's window ends at the advertised time"
        );
        let rgba = crate::radar_grid::render(&field, (42.0, -5.0, 51.0, 8.0), 64, 64);
        assert_eq!(rgba.len(), 64 * 64 * 4);
    }

    #[test]
    fn legend_is_the_render_scale() {
        let l = legend();
        assert_eq!(l.len(), crate::radar_grid::SCALE.len());
        for b in &l {
            let [r, g, bl, _] = crate::radar_grid::rate_colour(b.from_mm_h).unwrap();
            assert_eq!(b.color, format!("#{r:02x}{g:02x}{bl:02x}"));
        }
        let v = serde_json::to_value(&l[0]).unwrap();
        assert_eq!(v["fromMmH"], 0.1);
    }

    #[test]
    fn urls() {
        assert!(product_url().ends_with("/LAME_D_EAU/produit?maille=500"));
        assert!(
            description_url().starts_with("https://public-api.meteofrance.fr/public/DPRadar/v1/")
        );
    }
}
