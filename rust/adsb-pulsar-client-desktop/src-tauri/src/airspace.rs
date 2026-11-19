//! OpenAIP airspaces: fetched per country, cached per AIRAC cycle.
//!
//! Rust only fetches and caches; the webview interprets and draws. The cache
//! holds OpenAIP's raw `items` untouched, so a change in how the UI reads them
//! never needs a new download.
//!
//! Airspace data is published on the 28-day AIRAC cycle, and an outdated copy
//! is a safety issue rather than a cosmetic one. Each file is therefore named
//! after its cycle, a new cycle triggers a download, and when that download
//! fails the newest older file is served **marked expired** instead of nothing.

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};

/// Effective date of AIRAC cycle 2001, the epoch every cycle is counted from.
const AIRAC_EPOCH: (i32, u32, u32) = (2020, 1, 2);
const AIRAC_DAYS: i64 = 28;

/// Country used when `ADSB_OPENAIP_COUNTRIES` is unset or holds nothing valid.
pub const DEFAULT_COUNTRY: &str = "CA";

/// Environment variables, exported by `scripts/stack.sh` from `[desktop]`.
pub const KEY_ENV: &str = "ADSB_OPENAIP_API_KEY";
pub const COUNTRIES_ENV: &str = "ADSB_OPENAIP_COUNTRIES";

/// Shown when no key is configured and nothing is cached.
pub const NO_KEY_ERROR: &str =
    "No OpenAIP API key: set [desktop] openaip_api_key (free, from your openaip.net profile)";

/// Guard against a server that keeps announcing pages.
const MAX_PAGES: u32 = 50;

/// One AIRAC cycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiracCycle {
    /// `YYNN`: two-digit year of the effective date, then the cycle's number in that year.
    pub ident: String,
    pub effective: NaiveDate,
    /// First day of the next cycle.
    pub expires: NaiveDate,
}

/// The AIRAC cycle in force on `date`.
pub fn airac_cycle(date: NaiveDate) -> AiracCycle {
    let (y, m, d) = AIRAC_EPOCH;
    let epoch = NaiveDate::from_ymd_opt(y, m, d).expect("valid epoch");
    let n = (date - epoch).num_days().div_euclid(AIRAC_DAYS);
    let effective = epoch + Duration::days(n * AIRAC_DAYS);
    // Cycles are 28 days apart, so the k-th of a year starts on day 28(k-1)..28k.
    let number = effective.ordinal0() / 28 + 1;
    AiracCycle {
        ident: format!("{:02}{number:02}", effective.year().rem_euclid(100)),
        effective,
        expires: effective + Duration::days(AIRAC_DAYS),
    }
}

/// `ADSB_OPENAIP_COUNTRIES` → upper-case ISO alpha-2 codes, deduplicated.
pub fn parse_countries(raw: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for code in raw.unwrap_or("").split(',').map(str::trim) {
        // Codes end up in a file name and a URL: two ASCII letters, nothing else.
        if code.len() == 2 && code.bytes().all(|b| b.is_ascii_alphabetic()) {
            let code = code.to_ascii_uppercase();
            if !out.contains(&code) {
                out.push(code);
            }
        }
    }
    if out.is_empty() {
        out.push(DEFAULT_COUNTRY.to_string());
    }
    out
}

/// One page of `GET /api/airspaces`.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub items: Vec<Value>,
    pub total_pages: u32,
}

/// Parse one page of the list response.
pub fn parse_page(bytes: &[u8]) -> Result<Page, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        items: Vec<Value>,
        total_pages: u32,
    }
    let raw: Raw =
        serde_json::from_slice(bytes).map_err(|e| format!("unexpected OpenAIP response: {e}"))?;
    Ok(Page {
        items: raw.items,
        total_pages: raw.total_pages,
    })
}

const API_BASE: &str = "https://api.core.openaip.net/api/airspaces";

/// The API filters by country only (no bbox), so a whole country is fetched
/// and the webview keeps what is near the receiver.
pub fn page_url(country: &str, page: u32) -> String {
    format!("{API_BASE}?country={country}&page={page}&limit=1000")
}

/// A non-2xx answer as a message the Filters panel can show as is.
pub fn http_error(status: u16, body: &str) -> String {
    if status == 401 || status == 403 {
        return format!(
            "OpenAIP refused the request (HTTP {status}): set a valid key in [desktop] openaip_api_key \
             (free, from your openaip.net profile)"
        );
    }
    let snippet: String = body.chars().take(200).collect();
    format!("OpenAIP answered HTTP {status}: {snippet}")
}

/// Fetch one page with the API key.
pub async fn fetch_page(
    client: &reqwest::Client,
    key: &str,
    country: &str,
    page: u32,
) -> Result<Page, String> {
    let response = client
        .get(page_url(country, page))
        .header("x-openaip-api-key", key)
        .send()
        .await
        .map_err(|e| format!("OpenAIP unreachable: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("OpenAIP read failed: {e}"))?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &String::from_utf8_lossy(&body)));
    }
    parse_page(&body)
}

/// Where the data for one country came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    /// The file for the current cycle was already on disk.
    Cache,
    /// Downloaded now, and written for the rest of the cycle.
    Download,
    /// The download failed; this is an older cycle's file.
    StaleCache,
    /// Nothing usable: see `error`.
    None,
}

/// What the webview receives for one country.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountryAirspaces {
    pub country: String,
    /// The cycle the data belongs to (an older one when `origin` is `StaleCache`).
    pub cycle: Option<AiracCycle>,
    /// True once the data's cycle is no longer in force.
    pub expired: bool,
    pub origin: Origin,
    pub items: Vec<Value>,
    /// Why the current cycle could not be downloaded, if it could not.
    pub error: Option<String>,
}

/// On-disk form of one country's cycle.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    cycle: AiracCycle,
    items: Vec<Value>,
}

fn cache_path(dir: &Path, country: &str, ident: &str) -> PathBuf {
    dir.join(format!("{country}-{ident}.json"))
}

/// Airspaces for `country` on `today`: the cycle's file if present, else a
/// download (every page) written for the rest of the cycle, else the newest
/// older file marked expired.
pub async fn load_country<F, Fut>(
    dir: &Path,
    country: &str,
    today: NaiveDate,
    fetch: F,
) -> CountryAirspaces
where
    F: Fn(u32) -> Fut,
    Fut: Future<Output = Result<Page, String>>,
{
    let current = airac_cycle(today);
    let path = cache_path(dir, country, &current.ident);
    if let Some(file) = read_cache(&path) {
        return result(country, file, today, Origin::Cache, None);
    }

    match fetch_all(&fetch).await {
        Ok(items) => {
            let file = CacheFile {
                cycle: current,
                items,
            };
            if let Err(e) = write_cache(dir, country, &path, &file) {
                // Still serve what was downloaded; the next start will try again.
                tracing::warn!("Could not cache airspaces for {country}: {e}");
            }
            result(country, file, today, Origin::Download, None)
        }
        Err(error) => match newest_cache(dir, country) {
            Some(file) => result(country, file, today, Origin::StaleCache, Some(error)),
            None => CountryAirspaces {
                country: country.to_string(),
                cycle: None,
                expired: false,
                origin: Origin::None,
                items: Vec::new(),
                error: Some(error),
            },
        },
    }
}

fn result(
    country: &str,
    file: CacheFile,
    today: NaiveDate,
    origin: Origin,
    error: Option<String>,
) -> CountryAirspaces {
    CountryAirspaces {
        country: country.to_string(),
        expired: file.cycle.expires <= today,
        cycle: Some(file.cycle),
        origin,
        items: file.items,
        error,
    }
}

/// Every page, or the first error: a partial country must never be cached.
async fn fetch_all<F, Fut>(fetch: &F) -> Result<Vec<Value>, String>
where
    F: Fn(u32) -> Fut,
    Fut: Future<Output = Result<Page, String>>,
{
    let first = fetch(1).await?;
    let pages = first.total_pages.clamp(1, MAX_PAGES);
    let mut items = first.items;
    for n in 2..=pages {
        items.extend(fetch(n).await?.items);
    }
    Ok(items)
}

fn read_cache(path: &Path) -> Option<CacheFile> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Cycle files for `country`, as `(ident, path)`.
fn cycle_files(dir: &Path, country: &str) -> Vec<(String, PathBuf)> {
    let prefix = format!("{country}-");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let ident = name.strip_prefix(&prefix)?.strip_suffix(".json")?;
            (ident.len() == 4 && ident.bytes().all(|b| b.is_ascii_digit()))
                .then(|| (ident.to_string(), e.path()))
        })
        .collect()
}

/// The newest readable cycle file. `YYNN` sorts chronologically as text.
fn newest_cache(dir: &Path, country: &str) -> Option<CacheFile> {
    let mut files = cycle_files(dir, country);
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.iter().find_map(|(_, p)| read_cache(p))
}

/// Write through a temporary file, then drop the other cycles' files.
fn write_cache(dir: &Path, country: &str, path: &Path, file: &CacheFile) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(file)?)?;
    std::fs::rename(&tmp, path)?;
    for (_, other) in cycle_files(dir, country) {
        if other != path {
            let _ = std::fs::remove_file(other);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    // --- AIRAC ------------------------------------------------------------

    #[test]
    fn airac_known_first_cycles_of_the_year() {
        for (date, ident) in [
            (d(2024, 1, 25), "2401"),
            (d(2025, 1, 23), "2501"),
            (d(2026, 1, 22), "2601"),
        ] {
            let c = airac_cycle(date);
            assert_eq!(c.ident, ident);
            assert_eq!(c.effective, date);
            assert_eq!(c.expires, date + Duration::days(28));
        }
    }

    #[test]
    fn airac_mid_cycle_and_the_day_before_a_new_year_cycle() {
        let c = airac_cycle(d(2026, 11, 19));
        assert_eq!(
            (c.ident.as_str(), c.effective, c.expires),
            ("2611", d(2026, 10, 29), d(2026, 11, 26))
        );
        // The day before 2601 still belongs to the last cycle of 2025.
        let c = airac_cycle(d(2026, 1, 21));
        assert_eq!((c.ident.as_str(), c.effective), ("2513", d(2025, 12, 25)));
    }

    #[test]
    fn airac_year_with_fourteen_cycles() {
        // 2020 started on 2 January, leaving room for a 14th cycle on 31 December.
        assert_eq!(airac_cycle(d(2020, 12, 31)).ident, "2014");
        assert_eq!(airac_cycle(d(2020, 1, 2)).ident, "2001");
    }

    #[test]
    fn airac_before_the_epoch_counts_backwards() {
        let c = airac_cycle(d(2019, 12, 31));
        assert_eq!(c.effective, d(2019, 12, 5));
        assert_eq!(c.ident, "1913");
    }

    // --- Countries --------------------------------------------------------

    #[test]
    fn countries_default_to_canada() {
        assert_eq!(parse_countries(None), vec!["CA"]);
        assert_eq!(parse_countries(Some("  ")), vec!["CA"]);
    }

    #[test]
    fn countries_are_upper_cased_deduplicated_and_validated() {
        // Codes end up in a file name and a URL, so anything but two letters is dropped.
        assert_eq!(
            parse_countries(Some("ca, us,CA, ../x, usa, f1")),
            vec!["CA", "US"]
        );
        assert_eq!(parse_countries(Some("nope")), vec!["CA"]);
    }

    // --- Page parsing -----------------------------------------------------

    #[test]
    fn page_keeps_items_verbatim() {
        let body = json!({"page": 1, "limit": 1000, "totalCount": 2, "totalPages": 3,
                          "items": [{"_id": "a", "name": "MONTREAL TMA"}, {"_id": "b"}]});
        let p = parse_page(body.to_string().as_bytes()).unwrap();
        assert_eq!(p.total_pages, 3);
        assert_eq!(p.items[0]["name"], "MONTREAL TMA");
    }

    #[test]
    fn page_without_items_is_an_error() {
        assert!(parse_page(br#"{"message":"No authenticated user found"}"#).is_err());
        assert!(parse_page(b"<html>").is_err());
    }

    // --- Cache ------------------------------------------------------------

    fn page(ids: &[&str], total_pages: u32) -> Page {
        Page {
            items: ids.iter().map(|i| json!({ "_id": i })).collect(),
            total_pages,
        }
    }

    fn ids(r: &CountryAirspaces) -> Vec<String> {
        r.items
            .iter()
            .map(|i| i["_id"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn downloads_every_page_and_writes_the_cycle_file() {
        let dir = tempfile::tempdir().unwrap();
        let today = d(2026, 11, 19);
        let calls = Cell::new(0);
        let r = load_country(dir.path(), "CA", today, |n| {
            calls.set(calls.get() + 1);
            let p = match n {
                1 => page(&["a", "b"], 2),
                2 => page(&["c"], 2),
                _ => unreachable!(),
            };
            async move { Ok(p) }
        })
        .await;
        assert_eq!(calls.get(), 2);
        assert_eq!(r.origin, Origin::Download);
        assert_eq!(ids(&r), ["a", "b", "c"]);
        assert_eq!(r.cycle.as_ref().unwrap().ident, "2611");
        assert!(!r.expired && r.error.is_none());
        assert!(dir.path().join("CA-2611.json").exists());
    }

    #[tokio::test]
    async fn serves_the_current_cycle_from_disk_without_fetching() {
        let dir = tempfile::tempdir().unwrap();
        let today = d(2026, 11, 19);
        load_country(dir.path(), "CA", today, |_| async { Ok(page(&["a"], 1)) }).await;
        let r = load_country(dir.path(), "CA", today, |_| async {
            panic!("must not fetch")
        })
        .await;
        assert_eq!(r.origin, Origin::Cache);
        assert_eq!(ids(&r), ["a"]);
    }

    #[tokio::test]
    async fn new_cycle_replaces_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        load_country(dir.path(), "CA", d(2026, 11, 19), |_| async {
            Ok(page(&["old"], 1))
        })
        .await;
        let r = load_country(dir.path(), "CA", d(2026, 11, 26), |_| async {
            Ok(page(&["new"], 1))
        })
        .await;
        assert_eq!(
            (r.origin, ids(&r)),
            (Origin::Download, vec!["new".to_string()])
        );
        assert!(dir.path().join("CA-2612.json").exists());
        assert!(!dir.path().join("CA-2611.json").exists());
    }

    #[tokio::test]
    async fn failed_download_falls_back_to_the_newest_older_cycle_marked_expired() {
        let dir = tempfile::tempdir().unwrap();
        load_country(dir.path(), "CA", d(2026, 9, 3), |_| async {
            Ok(page(&["2609"], 1))
        })
        .await;
        load_country(dir.path(), "CA", d(2026, 11, 19), |_| async {
            Ok(page(&["2611"], 1))
        })
        .await;
        // A stray file for another country must not be picked.
        std::fs::write(dir.path().join("US-2612.json"), "{}").unwrap();
        let r = load_country(dir.path(), "CA", d(2026, 12, 1), |_| async {
            Err("HTTP 403".to_string())
        })
        .await;
        assert_eq!(r.origin, Origin::StaleCache);
        assert_eq!(ids(&r), ["2611"]);
        assert_eq!(r.cycle.as_ref().unwrap().ident, "2611");
        assert!(r.expired);
        assert_eq!(r.error.as_deref(), Some("HTTP 403"));
    }

    #[tokio::test]
    async fn failed_download_with_nothing_on_disk_reports_the_error() {
        let dir = tempfile::tempdir().unwrap();
        let r = load_country(dir.path(), "CA", d(2026, 11, 19), |_| async {
            Err("no key".to_string())
        })
        .await;
        assert_eq!(r.origin, Origin::None);
        assert!(r.items.is_empty() && r.cycle.is_none());
        assert_eq!(r.error.as_deref(), Some("no key"));
    }

    #[tokio::test]
    async fn a_failed_later_page_writes_nothing() {
        // A half-downloaded country would look complete for the rest of the cycle.
        let dir = tempfile::tempdir().unwrap();
        let r = load_country(dir.path(), "CA", d(2026, 11, 19), |n| async move {
            if n == 1 {
                Ok(page(&["a"], 2))
            } else {
                Err("timeout".to_string())
            }
        })
        .await;
        assert_eq!(r.origin, Origin::None);
        assert!(!dir.path().join("CA-2611.json").exists());
    }

    #[tokio::test]
    async fn creates_the_cache_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("airspaces");
        let r = load_country(&nested, "CA", d(2026, 11, 19), |_| async {
            Ok(page(&["a"], 1))
        })
        .await;
        assert_eq!(r.origin, Origin::Download);
        assert!(nested.join("CA-2611.json").exists());
    }

    #[tokio::test]
    async fn a_corrupt_current_file_is_downloaded_again() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CA-2611.json"), "not json").unwrap();
        let r = load_country(dir.path(), "CA", d(2026, 11, 19), |_| async {
            Ok(page(&["a"], 1))
        })
        .await;
        assert_eq!(r.origin, Origin::Download);
    }

    // --- HTTP -------------------------------------------------------------

    #[test]
    fn page_url_asks_for_one_country_a_thousand_at_a_time() {
        assert_eq!(
            page_url("CA", 2),
            "https://api.core.openaip.net/api/airspaces?country=CA&page=2&limit=1000"
        );
    }

    #[test]
    fn http_errors_say_what_to_do() {
        assert!(http_error(403, "{}").contains("openaip_api_key"));
        assert!(http_error(401, "").contains("openaip_api_key"));
        let e = http_error(
            500,
            "upstream exploded and kept talking for a very long time "
                .repeat(10)
                .as_str(),
        );
        assert!(e.starts_with("OpenAIP answered HTTP 500"));
        assert!(e.len() < 260, "body is truncated: {}", e.len());
    }

    #[test]
    fn serialises_for_the_webview_in_camel_case() {
        let r = CountryAirspaces {
            country: "CA".into(),
            cycle: Some(airac_cycle(d(2026, 11, 19))),
            expired: false,
            origin: Origin::StaleCache,
            items: vec![],
            error: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["origin"], "stale-cache");
        assert_eq!(v["cycle"]["effective"], "2026-10-29");
        assert!(v.get("items").is_some());
    }
}
