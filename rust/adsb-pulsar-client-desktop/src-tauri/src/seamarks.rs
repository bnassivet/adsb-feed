//! Seamark descriptions (name, type, light, …) for the seamark tooltip.
//!
//! The OpenSeaMap tiles are images only; the text is in OpenStreetMap tags,
//! read from the Overpass API. Overpass is slow (~20-50 s a query, mostly fixed
//! overhead) and asks for fair use, so seamarks are fetched by 2° × 2° cell,
//! only for the cells under the view, one query at a time, and each cell is
//! kept on disk for a week (`<stack data dir>/seamarks/<cell>.json`). A failed
//! refresh serves the old file. The main server is tried first, then a mirror.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;

/// Cell side, degrees.
pub const CELL_DEG: i32 = 2;
/// A view needing more cells than this is not described (zoom in).
pub const MAX_CELLS: usize = 6;
pub const MAX_AGE_DAYS: i64 = 7;
pub const ENDPOINTS: [&str; 2] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];
pub const USER_AGENT: &str = "adsb-pulsar-client-desktop (seamark descriptions)";

/// A cell by its south-west corner, both multiples of `CELL_DEG`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Cell {
    pub lat: i32,
    pub lon: i32,
}

impl Cell {
    /// `N46W006`, `S02E010`: also the file name.
    pub fn name(self) -> String {
        format!(
            "{}{:02}{}{:03}",
            if self.lat < 0 { 'S' } else { 'N' },
            self.lat.abs(),
            if self.lon < 0 { 'W' } else { 'E' },
            self.lon.abs()
        )
    }

    /// The Overpass query: every element tagged `seamark:type` in the cell,
    /// with a centre for ways and relations.
    pub fn query(self) -> String {
        format!(
            "[out:json][timeout:180];nwr[\"seamark:type\"]({},{},{},{});out center tags;",
            self.lat,
            self.lon,
            self.lat + CELL_DEG,
            self.lon + CELL_DEG
        )
    }
}

fn floor_cell(deg: f64) -> i32 {
    (deg / CELL_DEG as f64).floor() as i32 * CELL_DEG
}

/// The cells a view touches, south-west first; an error when there are too many.
pub fn cells_for(south: f64, west: f64, north: f64, east: f64) -> Result<Vec<Cell>, String> {
    if ![south, west, north, east].iter().all(|v| v.is_finite()) || south > north || west > east {
        return Err(format!("Invalid view {south}, {west}, {north}, {east}"));
    }
    let (s, n) = (floor_cell(south.max(-90.0)), floor_cell(north.min(89.999)));
    let (w, e) = (floor_cell(west.max(-180.0)), floor_cell(east.min(179.999)));
    let count = (((n - s) / CELL_DEG + 1) * ((e - w) / CELL_DEG + 1)) as usize;
    if count > MAX_CELLS {
        return Err("Zoom in to describe seamarks".into());
    }
    let mut cells = Vec::with_capacity(count);
    for lat in (s..=n).step_by(CELL_DEG as usize) {
        for lon in (w..=e).step_by(CELL_DEG as usize) {
            cells.push(Cell { lat, lon });
        }
    }
    Ok(cells)
}

/// One seamark: position and its `seamark:*` and `name` tags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Seamark {
    /// `n123`, `w45`, `r6`: the OSM element.
    pub id: String,
    pub lat: f64,
    pub lon: f64,
    pub tags: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct OverpassBody {
    elements: Vec<Element>,
}

#[derive(Deserialize)]
struct Element {
    #[serde(rename = "type")]
    kind: String,
    id: u64,
    lat: Option<f64>,
    lon: Option<f64>,
    center: Option<Center>,
    #[serde(default)]
    tags: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Center {
    lat: f64,
    lon: f64,
}

/// Overpass JSON to seamarks; only the tags the tooltip reads are kept.
pub fn parse_overpass(body: &[u8]) -> Result<Vec<Seamark>, String> {
    let parsed: OverpassBody =
        serde_json::from_slice(body).map_err(|e| format!("Overpass answer: {e}"))?;
    Ok(parsed
        .elements
        .into_iter()
        .filter_map(|e| {
            let (lat, lon) = match (e.lat, e.lon, &e.center) {
                (Some(lat), Some(lon), _) => (lat, lon),
                (_, _, Some(c)) => (c.lat, c.lon),
                _ => return None,
            };
            let tags: BTreeMap<_, _> = e
                .tags
                .into_iter()
                .filter(|(k, _)| k.starts_with("seamark:") || k == "name")
                .collect();
            tags.contains_key("seamark:type").then(|| Seamark {
                id: format!("{}{}", e.kind.chars().next().unwrap_or('x'), e.id),
                lat,
                lon,
                tags,
            })
        })
        .collect())
}

/// What is kept on disk for one cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellFile {
    pub fetched_at_ms: i64,
    pub items: Vec<Seamark>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Cache,
    Download,
    StaleCache,
    None,
}

pub struct CellLoad {
    pub items: Vec<Seamark>,
    pub origin: Origin,
    pub error: Option<String>,
}

fn read_cell(dir: &Path, cell: Cell) -> Option<CellFile> {
    let bytes = std::fs::read(dir.join(format!("{}.json", cell.name()))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_cell(dir: &Path, cell: Cell, file: &CellFile) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("{}.json", cell.name()));
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec(file).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json)
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// The cell from disk while under a week old; otherwise downloaded and kept;
/// on failure the old file, with the error.
pub async fn load_cell<F, Fut>(dir: &Path, cell: Cell, now: DateTime<Utc>, fetch: F) -> CellLoad
where
    F: FnOnce(Cell) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let cached = read_cell(dir, cell);
    if let Some(c) = &cached
        && now.timestamp_millis() - c.fetched_at_ms
            < Duration::days(MAX_AGE_DAYS).num_milliseconds()
    {
        return CellLoad {
            items: c.items.clone(),
            origin: Origin::Cache,
            error: None,
        };
    }
    match fetch(cell).await.and_then(|b| parse_overpass(&b)) {
        Ok(items) => {
            let file = CellFile {
                fetched_at_ms: now.timestamp_millis(),
                items,
            };
            let error = write_cell(dir, cell, &file).err();
            CellLoad {
                items: file.items,
                origin: Origin::Download,
                error,
            }
        }
        Err(e) => match cached {
            Some(c) => CellLoad {
                items: c.items,
                origin: Origin::StaleCache,
                error: Some(e),
            },
            None => CellLoad {
                items: vec![],
                origin: Origin::None,
                error: Some(e),
            },
        },
    }
}

/// `data=<query>`, percent-encoded as a form body.
pub fn form_body(query: &str) -> String {
    let mut out = String::from("data=");
    for b in query.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Asks each endpoint in turn; the first good answer wins.
pub async fn fetch(client: &reqwest::Client, cell: Cell) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for url in ENDPOINTS {
        let sent = client
            .post(url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(form_body(&cell.query()))
            .send()
            .await;
        match sent {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => return Ok(b.to_vec()),
                Err(e) => last = format!("Overpass {url}: {e}"),
            },
            Ok(r) => last = format!("Overpass {url}: HTTP {}", r.status().as_u16()),
            Err(e) => last = format!("Overpass {url}: {e}"),
        }
    }
    Err(last)
}

/// What the webview receives for a view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeamarkSnapshot {
    pub items: Vec<Seamark>,
    /// Some cell came from an old file or failed.
    pub stale: bool,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(days: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 19, 3, 0, 0).unwrap() + Duration::days(days)
    }

    const BODY: &str = r#"{"elements":[
      {"type":"node","id":1,"lat":48.3,"lon":-4.5,"tags":{"seamark:type":"buoy_lateral","seamark:name":"MB1","seamark:light:character":"Fl","source":"survey"}},
      {"type":"way","id":2,"center":{"lat":48.4,"lon":-4.4},"tags":{"seamark:type":"harbour","name":"Port"}},
      {"type":"node","id":3,"lat":48.0,"lon":-4.0,"tags":{"name":"no seamark type"}},
      {"type":"relation","id":4,"tags":{"seamark:type":"anchorage"}}
    ]}"#;

    #[test]
    fn cells_cover_the_view_from_the_south_west() {
        assert_eq!(
            cells_for(47.2, -5.1, 48.9, -3.0).unwrap(),
            vec![
                Cell { lat: 46, lon: -6 },
                Cell { lat: 46, lon: -4 },
                Cell { lat: 48, lon: -6 },
                Cell { lat: 48, lon: -4 },
            ]
        );
        assert_eq!(
            cells_for(47.0, -1.0, 47.5, -0.5).unwrap(),
            vec![Cell { lat: 46, lon: -2 }]
        );
    }

    #[test]
    fn a_wide_view_or_a_bad_one_is_refused() {
        assert!(
            cells_for(40.0, -10.0, 50.0, 0.0)
                .unwrap_err()
                .contains("Zoom in")
        );
        assert!(cells_for(f64::NAN, 0.0, 1.0, 1.0).is_err());
        assert!(cells_for(2.0, 0.0, 1.0, 1.0).is_err());
    }

    #[test]
    fn cells_have_names_and_queries() {
        assert_eq!(Cell { lat: 46, lon: -6 }.name(), "N46W006");
        assert_eq!(Cell { lat: -2, lon: 10 }.name(), "S02E010");
        assert_eq!(
            Cell { lat: 46, lon: -6 }.query(),
            "[out:json][timeout:180];nwr[\"seamark:type\"](46,-6,48,-4);out center tags;"
        );
    }

    #[test]
    fn the_query_is_sent_as_an_encoded_form() {
        assert_eq!(
            form_body("a[\"b\"](1,-2);"),
            "data=a%5B%22b%22%5D%281%2C-2%29%3B"
        );
    }

    #[test]
    fn overpass_answers_become_seamarks_with_only_the_needed_tags() {
        let s = parse_overpass(BODY.as_bytes()).unwrap();
        assert_eq!(s.len(), 2, "no seamark:type or no position: dropped");
        assert_eq!(s[0].id, "n1");
        assert_eq!(
            s[0].tags.get("seamark:name").map(String::as_str),
            Some("MB1")
        );
        assert!(!s[0].tags.contains_key("source"));
        assert_eq!(
            (s[1].id.as_str(), s[1].lat, s[1].lon),
            ("w2", 48.4, -4.4),
            "ways at their centre"
        );
        assert_eq!(s[1].tags.get("name").map(String::as_str), Some("Port"));
        assert!(parse_overpass(b"<html>busy</html>").is_err());
    }

    const CELL: Cell = Cell { lat: 48, lon: -6 };

    #[tokio::test]
    async fn a_cell_is_downloaded_once_a_week() {
        let dir = tempfile::tempdir().unwrap();
        let r = load_cell(dir.path(), CELL, t(0), |_| async {
            Ok(BODY.as_bytes().to_vec())
        })
        .await;
        assert_eq!((r.origin, r.items.len()), (Origin::Download, 2));
        assert!(dir.path().join("N48W006.json").exists());
        let r = load_cell(dir.path(), CELL, t(6), |_| async {
            panic!("fresh: no request")
        })
        .await;
        assert_eq!((r.origin, r.items.len()), (Origin::Cache, 2));
        let r = load_cell(dir.path(), CELL, t(8), |_| async {
            Ok(br#"{"elements":[]}"#.to_vec())
        })
        .await;
        assert_eq!(
            (r.origin, r.items.len()),
            (Origin::Download, 0),
            "refreshed after a week"
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_serves_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        load_cell(dir.path(), CELL, t(0), |_| async {
            Ok(BODY.as_bytes().to_vec())
        })
        .await;
        let r = load_cell(dir.path(), CELL, t(8), |_| async {
            Err("HTTP 504".to_string())
        })
        .await;
        assert_eq!((r.origin, r.items.len()), (Origin::StaleCache, 2));
        assert_eq!(r.error.as_deref(), Some("HTTP 504"));
    }

    #[tokio::test]
    async fn nothing_on_disk_and_a_failure_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let r = load_cell(dir.path(), CELL, t(0), |_| async {
            Ok(b"<html>busy</html>".to_vec())
        })
        .await;
        assert_eq!(r.origin, Origin::None);
        assert!(r.error.unwrap().contains("Overpass"));
        assert!(
            !dir.path().join("N48W006.json").exists(),
            "a bad answer is not kept"
        );
    }

    /// Live: one small cell from the real servers. `cargo test -- --ignored seamark`.
    #[tokio::test]
    #[ignore]
    async fn live_overpass_cell() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(200))
            .build()
            .unwrap();
        let body = fetch(&client, Cell { lat: 48, lon: -6 }).await.unwrap();
        let s = parse_overpass(&body).unwrap();
        assert!(s.len() > 100, "{} seamarks", s.len());
    }
}
