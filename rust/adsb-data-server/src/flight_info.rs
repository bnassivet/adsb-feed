//! Flight info from the web: airframe and route for one aircraft, from the
//! public adsbdb.com database, cached in DuckDB.
//!
//! Not a filed flight plan — those are not public. adsbdb knows the scheduled
//! origin and destination for a callsign, and type, registration, owner and a
//! photo link for a hex.
//!
//! Shaped like the desktop's other web lookups: the core is pure and takes the
//! fetch as a closure, so it is tested without a network, and the real HTTP
//! call (`fetch_adsbdb`) sits behind the `web-lookup` feature. Only the desktop
//! enables it; the edge recorder never carries a TLS stack for this.
//!
//! One lookup never fails as a whole: a failed fetch falls back to the cached
//! row with `stale` set, or to an `error` with nothing to show.

use adsb_data_engine::{AircraftInfo, Airport, FlightRoute, SharedStorage, StorageHandle};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use tracing::warn;

pub const ADSBDB_BASE: &str = "https://api.adsbdb.com/v0";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// An airframe's type and registration change rarely.
pub const AIRCRAFT_TTL_MS: i64 = 30 * DAY_MS;
/// A callsign can be reassigned to another route between seasons.
pub const ROUTE_TTL_MS: i64 = DAY_MS;
/// "Unknown" answers are retried after a day, not on every click.
pub const NEGATIVE_TTL_MS: i64 = DAY_MS;

/// What a fetch returned: the HTTP status and the body as text.
#[derive(Debug, Clone)]
pub struct FetchResponse {
    pub status: u16,
    pub body: String,
}

/// Where the answer came from. `Web` if any part was fetched just now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InfoSource {
    Cache,
    Web,
    None,
}

/// The answer to one lookup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlightInfo {
    pub hex_ident: String,
    pub callsign: Option<String>,
    /// `found == false` inside means the source does not know this airframe.
    pub aircraft: Option<AircraftInfo>,
    /// `None` when no callsign was given; `found == false` when unknown.
    pub route: Option<FlightRoute>,
    pub source: InfoSource,
    /// A fetch failed and a cached row older than its TTL is shown instead.
    pub stale: bool,
    pub error: Option<String>,
    /// The aircraft is simulated: nothing was sent to the web.
    pub simulated: bool,
}

impl FlightInfo {
    fn empty(hex_ident: String, callsign: Option<String>) -> Self {
        Self {
            hex_ident,
            callsign,
            aircraft: None,
            route: None,
            source: InfoSource::None,
            stale: false,
            error: None,
            simulated: false,
        }
    }

    /// The answer for a simulated aircraft: refused without any request.
    pub fn simulated(hex_ident: &str, callsign: Option<&str>) -> Self {
        Self {
            simulated: true,
            error: Some("Simulated aircraft: no web lookup".into()),
            ..Self::empty(
                hex_ident.trim().to_uppercase(),
                normalize_callsign(callsign).ok().flatten(),
            )
        }
    }
}

/// A 24-bit ICAO address as six upper-case hex digits.
pub fn normalize_hex(hex: &str) -> Result<String, String> {
    let h = hex.trim().to_uppercase();
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(h)
    } else {
        Err(format!("Invalid ICAO hex '{hex}'"))
    }
}

/// A callsign as 1–8 upper-case letters and digits; `None` when blank.
/// Rejecting anything else also keeps it safe to put in a URL path.
pub fn normalize_callsign(callsign: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = callsign else { return Ok(None) };
    let cs = raw.trim().to_uppercase();
    if cs.is_empty() {
        return Ok(None);
    }
    if cs.len() <= 8 && cs.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(Some(cs))
    } else {
        Err(format!("Invalid callsign '{raw}'"))
    }
}

pub fn aircraft_url(hex: &str) -> String {
    format!("{ADSBDB_BASE}/aircraft/{hex}")
}

pub fn callsign_url(callsign: &str) -> String {
    format!("{ADSBDB_BASE}/callsign/{callsign}")
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The `response` object of a body, or why there is none. A 404 is the
/// source's "unknown" answer and maps to `Ok(None)`.
fn response_object(status: u16, body: &str) -> Result<Option<Value>, String> {
    match status {
        200 => {
            let v: Value =
                serde_json::from_str(body).map_err(|e| format!("adsbdb: bad JSON ({e})"))?;
            Ok(Some(v.get("response").cloned().unwrap_or(Value::Null)))
        }
        404 => Ok(None),
        429 => Err("adsbdb: rate limited, try again later".into()),
        s => Err(format!("adsbdb: HTTP {s}")),
    }
}

/// Parse `/v0/aircraft/{hex}`.
pub fn parse_aircraft(
    hex: &str,
    status: u16,
    body: &str,
    now_ms: i64,
) -> Result<AircraftInfo, String> {
    let mut info = AircraftInfo {
        hex_ident: hex.to_string(),
        found: false,
        icao_type: None,
        type_name: None,
        manufacturer: None,
        registration: None,
        owner: None,
        owner_country: None,
        photo_url: None,
        photo_thumb_url: None,
        fetched_at_ms: now_ms,
    };
    let Some(resp) = response_object(status, body)? else {
        return Ok(info);
    };
    let a = resp
        .get("aircraft")
        .filter(|a| a.is_object())
        .ok_or("adsbdb: response has no aircraft")?;
    info.found = true;
    info.icao_type = text(a, "icao_type");
    info.type_name = text(a, "type");
    info.manufacturer = text(a, "manufacturer");
    info.registration = text(a, "registration");
    info.owner = text(a, "registered_owner");
    info.owner_country = text(a, "registered_owner_country_name");
    info.photo_url = text(a, "url_photo");
    info.photo_thumb_url = text(a, "url_photo_thumbnail");
    Ok(info)
}

fn parse_airport(v: Option<&Value>) -> Option<Airport> {
    let v = v?;
    Some(Airport {
        icao: text(v, "icao_code")?,
        iata: text(v, "iata_code"),
        name: text(v, "name"),
        city: text(v, "municipality"),
        country: text(v, "country_name"),
        latitude: v.get("latitude").and_then(Value::as_f64),
        longitude: v.get("longitude").and_then(Value::as_f64),
    })
}

/// Parse `/v0/callsign/{callsign}`.
pub fn parse_route(
    callsign: &str,
    status: u16,
    body: &str,
    now_ms: i64,
) -> Result<FlightRoute, String> {
    let mut route = FlightRoute {
        callsign: callsign.to_string(),
        found: false,
        airline_name: None,
        airline_icao: None,
        airline_iata: None,
        origin: None,
        destination: None,
        fetched_at_ms: now_ms,
    };
    let Some(resp) = response_object(status, body)? else {
        return Ok(route);
    };
    let r = resp
        .get("flightroute")
        .filter(|r| r.is_object())
        .ok_or("adsbdb: response has no flightroute")?;
    route.found = true;
    if let Some(airline) = r.get("airline") {
        route.airline_name = text(airline, "name");
        route.airline_icao = text(airline, "icao");
        route.airline_iata = text(airline, "iata");
    }
    route.origin = parse_airport(r.get("origin"));
    route.destination = parse_airport(r.get("destination"));
    Ok(route)
}

fn aircraft_fresh(a: &AircraftInfo, now_ms: i64) -> bool {
    let ttl = if a.found {
        AIRCRAFT_TTL_MS
    } else {
        NEGATIVE_TTL_MS
    };
    now_ms - a.fetched_at_ms < ttl
}

fn route_fresh(r: &FlightRoute, now_ms: i64) -> bool {
    let ttl = if r.found {
        ROUTE_TTL_MS
    } else {
        NEGATIVE_TTL_MS
    };
    now_ms - r.fetched_at_ms < ttl
}

/// Run a sync storage call off the async runtime. `None` when storage is
/// released or unavailable, or the call failed: the cache is an optimisation,
/// never a reason for a lookup to fail.
async fn with_storage<T, F>(storage: &SharedStorage, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(&StorageHandle) -> Result<T, adsb_data_engine::StorageError> + Send + 'static,
{
    let handle = storage.read().await.as_ref()?.clone();
    match tokio::task::spawn_blocking(move || f(&handle)).await {
        Ok(Ok(v)) => Some(v),
        Ok(Err(e)) => {
            warn!("flight info cache: {e}");
            None
        }
        Err(e) => {
            warn!("flight info cache task: {e}");
            None
        }
    }
}

enum Outcome<T> {
    Cached(T),
    Fetched(T),
    Stale(T, String),
    Failed(String),
}

async fn refresh<T: Clone, Fut>(
    cached: Option<T>,
    fresh: impl Fn(&T) -> bool,
    url: String,
    fetch: impl FnOnce(String) -> Fut,
    parse: impl FnOnce(FetchResponse) -> Result<T, String>,
) -> Outcome<T>
where
    Fut: Future<Output = Result<FetchResponse, String>>,
{
    if let Some(c) = cached.as_ref().filter(|c| fresh(c)) {
        return Outcome::Cached(c.clone());
    }
    match fetch(url).await.and_then(parse) {
        Ok(v) => Outcome::Fetched(v),
        Err(e) => match cached {
            Some(c) => Outcome::Stale(c, e),
            None => Outcome::Failed(e),
        },
    }
}

/// Airframe and route for one aircraft: from the cache while fresh, else
/// from adsbdb via `fetch(url)`, writing the answer back to the cache.
///
/// The caller decides whether the aircraft is simulated; this function
/// assumes it is not.
pub async fn lookup<F, Fut>(
    storage: &SharedStorage,
    hex: &str,
    callsign: Option<&str>,
    now_ms: i64,
    fetch: F,
) -> FlightInfo
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<FetchResponse, String>>,
{
    let hex = match normalize_hex(hex) {
        Ok(h) => h,
        Err(e) => {
            return FlightInfo {
                error: Some(e),
                ..FlightInfo::empty(hex.to_string(), None)
            };
        }
    };
    let (callsign, callsign_error) = match normalize_callsign(callsign) {
        Ok(cs) => (cs, None),
        Err(e) => (None, Some(e)),
    };
    let mut info = FlightInfo::empty(hex.clone(), callsign.clone());
    let mut errors: Vec<String> = callsign_error.into_iter().collect();

    // Airframe.
    let key = hex.clone();
    let cached = with_storage(storage, move |s| s.get_aircraft_info_sync(&key))
        .await
        .flatten();
    let h = hex.clone();
    match refresh(
        cached,
        |a| aircraft_fresh(a, now_ms),
        aircraft_url(&hex),
        &fetch,
        |r| parse_aircraft(&h, r.status, &r.body, now_ms),
    )
    .await
    {
        Outcome::Cached(a) => {
            info.aircraft = Some(a);
            info.source = InfoSource::Cache;
        }
        Outcome::Fetched(a) => {
            let row = a.clone();
            with_storage(storage, move |s| s.upsert_aircraft_info_sync(&row)).await;
            info.aircraft = Some(a);
            info.source = InfoSource::Web;
        }
        Outcome::Stale(a, e) => {
            info.aircraft = Some(a);
            info.source = InfoSource::Cache;
            info.stale = true;
            errors.push(e);
        }
        Outcome::Failed(e) => errors.push(e),
    }

    // Route.
    if let Some(cs) = callsign {
        let key = cs.clone();
        let cached = with_storage(storage, move |s| s.get_flight_route_sync(&key))
            .await
            .flatten();
        let c = cs.clone();
        match refresh(
            cached,
            |r| route_fresh(r, now_ms),
            callsign_url(&cs),
            &fetch,
            |r| parse_route(&c, r.status, &r.body, now_ms),
        )
        .await
        {
            Outcome::Cached(r) => {
                info.route = Some(r);
                if info.source == InfoSource::None {
                    info.source = InfoSource::Cache;
                }
            }
            Outcome::Fetched(r) => {
                let row = r.clone();
                with_storage(storage, move |s| s.upsert_flight_route_sync(&row)).await;
                info.route = Some(r);
                info.source = InfoSource::Web;
            }
            Outcome::Stale(r, e) => {
                info.route = Some(r);
                if info.source == InfoSource::None {
                    info.source = InfoSource::Cache;
                }
                info.stale = true;
                errors.push(e);
            }
            Outcome::Failed(e) => errors.push(e),
        }
    }

    if !errors.is_empty() {
        errors.dedup();
        info.error = Some(errors.join("; "));
    }
    info
}

/// The real fetch: one GET with a short timeout and an identifying agent.
#[cfg(feature = "web-lookup")]
pub async fn fetch_adsbdb(client: &reqwest::Client, url: String) -> Result<FetchResponse, String> {
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("adsbdb unreachable ({e})"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("adsbdb: unreadable body ({e})"))?;
    Ok(FetchResponse { status, body })
}

/// Sent with every request, so the source can tell who is asking.
pub const USER_AGENT: &str = concat!("adsb-desktop/", env!("CARGO_PKG_VERSION"));

/// A client for `fetch_adsbdb` with the timeout every lookup uses.
#[cfg(feature = "web-lookup")]
pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())
}

/// Arguments of the `lookupFlightInfo` agent tool. Either identifier is
/// enough: the other is looked up in recorded flights.
#[derive(Debug, Default, Deserialize)]
pub struct FlightInfoArgs {
    #[serde(default)]
    pub hex_ident: Option<String>,
    #[serde(default)]
    pub callsign: Option<String>,
}

/// The `lookupFlightInfo` tool: refuse simulated aircraft, fill in the
/// missing identifier from recorded flights, then [`lookup`].
pub async fn lookup_for_tool<F, Fut>(
    storage: &SharedStorage,
    args: FlightInfoArgs,
    now_ms: i64,
    fetch: F,
) -> Result<FlightInfo, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<FetchResponse, String>>,
{
    let hex = args
        .hex_ident
        .map(|h| h.trim().to_uppercase())
        .filter(|h| !h.is_empty());
    let callsign = normalize_callsign(args.callsign.as_deref())?;
    if hex.is_none() && callsign.is_none() {
        return Err("Give hex_ident or callsign".into());
    }

    let (h, c) = (hex.clone(), callsign.clone());
    let simulated = with_storage(storage, move |s| {
        s.is_scenario_aircraft_sync(h.as_deref(), c.as_deref())
    })
    .await
    .unwrap_or(false);
    if simulated {
        return Ok(FlightInfo::simulated(
            hex.as_deref().unwrap_or_default(),
            callsign.as_deref(),
        ));
    }

    let (h, c) = (hex.clone(), callsign.clone());
    let recorded = if hex.is_some() && callsign.is_some() {
        None
    } else {
        with_storage(storage, move |s| {
            s.latest_flight_identity_sync(h.as_deref(), c.as_deref())
        })
        .await
        .flatten()
    };
    let hex = match (hex, &recorded) {
        (Some(h), _) => h,
        (None, Some((h, _))) => h.clone(),
        (None, None) => {
            return Err(format!(
                "No recorded aircraft with callsign {}; give its hex_ident",
                callsign.unwrap_or_default()
            ));
        }
    };
    let callsign = callsign.or_else(|| recorded.and_then(|(_, c)| c));
    Ok(lookup(storage, &hex, callsign.as_deref(), now_ms, fetch).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use adsb_data_engine::StorageConfig;
    use std::sync::{Arc, Mutex};
    use tokio::sync::RwLock;

    const AIRCRAFT_200: &str = r#"{"response":{"aircraft":{"type":"A319 112","icao_type":"A319","manufacturer":"Airbus","mode_s":"3C6444","registration":"D-AIBD","registered_owner_country_iso_name":"DE","registered_owner_country_name":"Germany","registered_owner_operator_flag_code":"DLH","registered_owner":"Lufthansa","url_photo":"https://image.airport-data.com/aircraft/001742555.jpg","url_photo_thumbnail":"https://airport-data.com/images/aircraft/thumbnails/001/742/001742555.jpg"}}}"#;
    const ROUTE_200: &str = r#"{"response":{"flightroute":{"callsign":"DLH400","callsign_icao":"DLH400","callsign_iata":"LH400","airline":{"name":"Lufthansa","icao":"DLH","iata":"LH","country":"Germany","country_iso":"DE","callsign":"LUFTHANSA"},"origin":{"country_iso_name":"DE","country_name":"Germany","elevation":364,"iata_code":"FRA","icao_code":"EDDF","latitude":50.03333,"longitude":8.57056,"municipality":"Frankfurt am Main","name":"Frankfurt am Main Airport"},"destination":{"country_iso_name":"US","country_name":"United States","elevation":13,"iata_code":"JFK","icao_code":"KJFK","latitude":40.6398,"longitude":-73.7789,"municipality":"New York","name":"John F Kennedy International Airport"}}}}"#;
    const UNKNOWN_AIRCRAFT: &str = r#"{"response":"unknown aircraft"}"#;
    const UNKNOWN_CALLSIGN: &str = r#"{"response":"unknown callsign"}"#;

    const NOW: i64 = 1_800_000_000_000;

    fn shared() -> SharedStorage {
        Arc::new(RwLock::new(Some(
            StorageHandle::open(StorageConfig::default()).unwrap(),
        )))
    }

    /// A fake fetch answering by URL suffix, recording every URL asked.
    #[derive(Clone, Default)]
    struct FakeWeb {
        asked: Arc<Mutex<Vec<String>>>,
        fail: bool,
    }

    impl FakeWeb {
        fn failing() -> Self {
            Self {
                fail: true,
                ..Self::default()
            }
        }
        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
        fn fetch(&self) -> impl Fn(String) -> std::future::Ready<Result<FetchResponse, String>> {
            let me = self.clone();
            move |url: String| {
                me.asked.lock().unwrap().push(url.clone());
                if me.fail {
                    return std::future::ready(Err("offline".to_string()));
                }
                let (status, body) = if url.ends_with("/aircraft/3C6444") {
                    (200, AIRCRAFT_200)
                } else if url.ends_with("/callsign/DLH400") {
                    (200, ROUTE_200)
                } else if url.contains("/aircraft/") {
                    (404, UNKNOWN_AIRCRAFT)
                } else {
                    (404, UNKNOWN_CALLSIGN)
                };
                std::future::ready(Ok(FetchResponse {
                    status,
                    body: body.to_string(),
                }))
            }
        }
    }

    #[test]
    fn parses_known_aircraft() {
        let a = parse_aircraft("3C6444", 200, AIRCRAFT_200, NOW).unwrap();
        assert!(a.found);
        assert_eq!(a.icao_type.as_deref(), Some("A319"));
        assert_eq!(a.type_name.as_deref(), Some("A319 112"));
        assert_eq!(a.registration.as_deref(), Some("D-AIBD"));
        assert_eq!(a.owner.as_deref(), Some("Lufthansa"));
        assert_eq!(a.owner_country.as_deref(), Some("Germany"));
        assert!(a.photo_thumb_url.unwrap().contains("thumbnails"));
        assert_eq!(a.fetched_at_ms, NOW);
    }

    #[test]
    fn parses_unknown_aircraft_as_negative_row() {
        let a = parse_aircraft("000000", 404, UNKNOWN_AIRCRAFT, NOW).unwrap();
        assert!(!a.found);
        assert_eq!(a.registration, None);
    }

    #[test]
    fn parses_route_with_both_airports() {
        let r = parse_route("DLH400", 200, ROUTE_200, NOW).unwrap();
        assert!(r.found);
        assert_eq!(r.airline_name.as_deref(), Some("Lufthansa"));
        assert_eq!(r.airline_icao.as_deref(), Some("DLH"));
        let o = r.origin.unwrap();
        assert_eq!(o.icao, "EDDF");
        assert_eq!(o.iata.as_deref(), Some("FRA"));
        assert_eq!(o.city.as_deref(), Some("Frankfurt am Main"));
        assert_eq!(r.destination.unwrap().icao, "KJFK");
    }

    #[test]
    fn parse_errors_are_reported_not_cached() {
        assert!(parse_aircraft("3C6444", 200, "not json", NOW).is_err());
        assert!(parse_aircraft("3C6444", 200, r#"{"response":{}}"#, NOW).is_err());
        assert!(parse_route("DLH400", 500, "", NOW).is_err());
        assert!(
            parse_route("DLH400", 429, "", NOW)
                .unwrap_err()
                .contains("rate limited")
        );
    }

    #[test]
    fn identifiers_are_validated_and_normalised() {
        assert_eq!(normalize_hex(" 3c6444 ").unwrap(), "3C6444");
        assert!(normalize_hex("3C64").is_err());
        assert!(normalize_hex("3C644/").is_err());
        assert_eq!(
            normalize_callsign(Some(" dlh400 ")).unwrap(),
            Some("DLH400".into())
        );
        assert_eq!(normalize_callsign(Some("   ")).unwrap(), None);
        assert_eq!(normalize_callsign(None).unwrap(), None);
        assert!(normalize_callsign(Some("DLH/../x")).is_err());
    }

    #[tokio::test]
    async fn fetches_both_parts_and_caches_them() {
        let storage = shared();
        let web = FakeWeb::default();
        let info = lookup(&storage, "3c6444", Some("dlh400 "), NOW, web.fetch()).await;
        assert_eq!(info.source, InfoSource::Web);
        assert_eq!(info.callsign.as_deref(), Some("DLH400"));
        assert!(info.aircraft.unwrap().found);
        assert_eq!(info.route.unwrap().destination.unwrap().icao, "KJFK");
        assert_eq!(info.error, None);
        assert_eq!(
            web.asked(),
            vec![
                format!("{ADSBDB_BASE}/aircraft/3C6444"),
                format!("{ADSBDB_BASE}/callsign/DLH400")
            ]
        );

        // Second ask: served from DuckDB, no request.
        let again = lookup(&storage, "3C6444", Some("DLH400"), NOW + 1000, web.fetch()).await;
        assert_eq!(again.source, InfoSource::Cache);
        assert!(again.route.unwrap().found);
        assert_eq!(web.asked().len(), 2);
    }

    #[tokio::test]
    async fn expired_route_is_refetched_but_airframe_is_not() {
        let storage = shared();
        let web = FakeWeb::default();
        lookup(&storage, "3C6444", Some("DLH400"), NOW, web.fetch()).await;
        let later = NOW + ROUTE_TTL_MS + 1;
        let info = lookup(&storage, "3C6444", Some("DLH400"), later, web.fetch()).await;
        assert_eq!(info.source, InfoSource::Web);
        let asked = web.asked();
        assert_eq!(asked.len(), 3);
        assert!(asked[2].ends_with("/callsign/DLH400"));
    }

    #[tokio::test]
    async fn unknown_answers_are_negative_cached() {
        let storage = shared();
        let web = FakeWeb::default();
        let info = lookup(&storage, "000000", Some("ZZZ9999"), NOW, web.fetch()).await;
        assert!(!info.aircraft.unwrap().found);
        assert!(!info.route.unwrap().found);
        assert_eq!(info.error, None);
        lookup(&storage, "000000", Some("ZZZ9999"), NOW + 1, web.fetch()).await;
        assert_eq!(web.asked().len(), 2, "negative rows must stop re-asking");
        lookup(
            &storage,
            "000000",
            Some("ZZZ9999"),
            NOW + NEGATIVE_TTL_MS,
            web.fetch(),
        )
        .await;
        assert_eq!(web.asked().len(), 4, "negative rows expire after a day");
    }

    #[tokio::test]
    async fn fetch_failure_serves_stale_cache_with_error() {
        let storage = shared();
        lookup(
            &storage,
            "3C6444",
            Some("DLH400"),
            NOW,
            FakeWeb::default().fetch(),
        )
        .await;
        let later = NOW + AIRCRAFT_TTL_MS + 1;
        let info = lookup(
            &storage,
            "3C6444",
            Some("DLH400"),
            later,
            FakeWeb::failing().fetch(),
        )
        .await;
        assert!(info.stale);
        assert_eq!(info.source, InfoSource::Cache);
        assert_eq!(
            info.aircraft.unwrap().registration.as_deref(),
            Some("D-AIBD")
        );
        assert!(info.route.is_some());
        assert_eq!(info.error.as_deref(), Some("offline"));
    }

    #[tokio::test]
    async fn fetch_failure_without_cache_reports_error() {
        let info = lookup(&shared(), "3C6444", None, NOW, FakeWeb::failing().fetch()).await;
        assert_eq!(info.aircraft, None);
        assert_eq!(info.route, None);
        assert_eq!(info.source, InfoSource::None);
        assert_eq!(info.error.as_deref(), Some("offline"));
    }

    #[tokio::test]
    async fn works_without_storage() {
        let storage: SharedStorage = Arc::new(RwLock::new(None));
        let web = FakeWeb::default();
        let info = lookup(&storage, "3C6444", Some("DLH400"), NOW, web.fetch()).await;
        assert_eq!(info.source, InfoSource::Web);
        assert!(info.aircraft.is_some() && info.route.is_some());
    }

    #[tokio::test]
    async fn no_callsign_means_no_route_request() {
        let web = FakeWeb::default();
        let info = lookup(&shared(), "3C6444", Some("  "), NOW, web.fetch()).await;
        assert_eq!(info.route, None);
        assert_eq!(web.asked().len(), 1);
    }

    #[tokio::test]
    async fn invalid_hex_sends_nothing() {
        let web = FakeWeb::default();
        let info = lookup(&shared(), "nope", Some("DLH400"), NOW, web.fetch()).await;
        assert!(info.error.unwrap().contains("Invalid ICAO hex"));
        assert!(web.asked().is_empty());
    }

    #[test]
    fn simulated_answer_carries_no_data() {
        let info = FlightInfo::simulated("f00001", Some("sim01"));
        assert!(info.simulated);
        assert_eq!(info.hex_ident, "F00001");
        assert_eq!(info.callsign.as_deref(), Some("SIM01"));
        assert_eq!(info.aircraft, None);
        assert_eq!(info.source, InfoSource::None);
    }

    fn record(storage: &SharedStorage, hex: &str, callsign: &str) {
        let pos = adsb_data_engine::AircraftPosition {
            hex_ident: hex.into(),
            callsign: Some(callsign.into()),
            altitude: Some(35000.0),
            ground_speed: None,
            track: None,
            latitude: Some(47.0),
            longitude: Some(-1.5),
            vertical_rate: None,
            squawk: None,
            is_on_ground: Some(false),
            timestamp: "2026/11/20 10:30:00.000".into(),
            message_count: 0,
        };
        let guard = storage.try_read().unwrap();
        guard
            .as_ref()
            .unwrap()
            .insert_batch_sync(&[pos], "UTC")
            .unwrap();
    }

    fn args(hex: Option<&str>, callsign: Option<&str>) -> FlightInfoArgs {
        FlightInfoArgs {
            hex_ident: hex.map(Into::into),
            callsign: callsign.map(Into::into),
        }
    }

    #[tokio::test]
    async fn tool_resolves_hex_from_recorded_callsign() {
        let storage = shared();
        record(&storage, "3C6444", "DLH400");
        let web = FakeWeb::default();
        let info = lookup_for_tool(&storage, args(None, Some("dlh400")), NOW, web.fetch())
            .await
            .unwrap();
        assert_eq!(info.hex_ident, "3C6444");
        assert!(info.route.unwrap().found);
    }

    #[tokio::test]
    async fn tool_resolves_callsign_from_recorded_hex() {
        let storage = shared();
        record(&storage, "3C6444", "DLH400");
        let web = FakeWeb::default();
        let info = lookup_for_tool(&storage, args(Some("3c6444"), None), NOW, web.fetch())
            .await
            .unwrap();
        assert_eq!(info.callsign.as_deref(), Some("DLH400"));
        assert_eq!(web.asked().len(), 2);
    }

    #[tokio::test]
    async fn tool_rejects_unknown_callsign_without_hex() {
        let web = FakeWeb::default();
        let err = lookup_for_tool(&shared(), args(None, Some("AFR1")), NOW, web.fetch())
            .await
            .unwrap_err();
        assert!(err.contains("give its hex_ident"));
        assert!(web.asked().is_empty());
        assert!(
            lookup_for_tool(&shared(), args(None, None), NOW, web.fetch())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn tool_never_sends_a_scenario_aircraft_to_the_web() {
        let storage = shared();
        {
            let guard = storage.try_read().unwrap();
            let s = guard.as_ref().unwrap();
            let sc = s
                .insert_scenario_sync(&adsb_data_engine::CreateScenario {
                    name: "sc".into(),
                    ..Default::default()
                })
                .unwrap();
            s.insert_scenario_track_sync(&adsb_data_engine::CreateScenarioTrack {
                scenario_id: sc.id,
                hex_ident: "3C6444".into(),
                callsign: "SIM01".into(),
                category: "airliner".into(),
                start_offset_s: None,
                waypoints_json: "[]".into(),
                request_json: None,
            })
            .unwrap();
        }
        let web = FakeWeb::default();
        for a in [args(Some("3c6444"), None), args(None, Some("sim01"))] {
            let info = lookup_for_tool(&storage, a, NOW, web.fetch())
                .await
                .unwrap();
            assert!(info.simulated);
        }
        assert!(web.asked().is_empty());
    }
}
