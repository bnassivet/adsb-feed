//! Flight info from the web: airframe and route for one aircraft, from the
//! public adsbdb.com database, cached in DuckDB.
//!
//! Not a filed flight plan — those are not public. adsbdb knows the scheduled
//! origin and destination for a callsign, and type, registration, owner and a
//! photo link for a hex.
//!
//! When adsbdb answers "unknown" (404) for one part, that part is asked of
//! hexdb.io instead. Only "unknown" falls back: an adsbdb error (timeout, 429,
//! 5xx) is reported as before. Each cached row records its `provider`.
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
/// Fallback source, asked only for what adsbdb does not know.
pub const HEXDB_BASE: &str = "https://hexdb.io";

const ADSBDB: &str = "adsbdb";
const HEXDB: &str = "hexdb";

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
    /// Every source asked to produce this answer (`adsbdb`, `hexdb`), in that
    /// order, whether or not it knew anything: also right for cached answers,
    /// since each row records which source answered.
    #[serde(default)]
    pub sources: Vec<String>,
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
            sources: Vec::new(),
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

/// hexdb API v2: the airframe, with its photo links.
pub fn hexdb_aircraft_url(hex: &str) -> String {
    format!("{HEXDB_BASE}/api/v2/aircraft/{hex}")
}

/// hexdb API v2: the route, with every airport described in full.
pub fn hexdb_route_url(callsign: &str) -> String {
    format!("{HEXDB_BASE}/api/v2/routes/{callsign}")
}

/// hexdb API v2: one airport, for a route stop that came without coordinates.
pub fn hexdb_airport_url(icao: &str) -> String {
    format!("{HEXDB_BASE}/api/v2/airports/{icao}")
}

/// Which source to ask first, per part. adsbdb knows more airframes; hexdb's
/// routes list every stop and say how recent they are.
const AIRFRAME_SOURCES: [&str; 2] = [ADSBDB, HEXDB];
const ROUTE_SOURCES: [&str; 2] = [HEXDB, ADSBDB];
/// Looked-up airports move less often than anything else here.
pub const AIRPORT_TTL_MS: i64 = 30 * DAY_MS;

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
        provider: Some(ADSBDB.into()),
        operator_icao: None,
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
    info.operator_icao = text(a, "registered_owner_operator_flag_code");
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
        stops: Vec::new(),
        updated_at: None,
        provider: Some(ADSBDB.into()),
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
    route.stops = parse_airport(r.get("midpoint")).into_iter().collect();
    route.destination = parse_airport(r.get("destination"));
    Ok(route)
}

/// A hexdb v2 body as a JSON object, or why there is none. 404 (with an
/// `{"error": {...}}` body) is "unknown".
fn hexdb_object(status: u16, body: &str) -> Result<Option<Value>, String> {
    match status {
        200 => {
            let v: Value =
                serde_json::from_str(body).map_err(|e| format!("hexdb: bad JSON ({e})"))?;
            Ok(v.is_object().then_some(v))
        }
        404 => Ok(None),
        429 => Err("hexdb: rate limited, try again later".into()),
        s => Err(format!("hexdb: HTTP {s}")),
    }
}

/// A photo link from hexdb, kept only if it is https on hexdb itself (the
/// photo loader's allow-list), with nothing odd in it.
fn hexdb_image(images: Option<&Value>, key: &str) -> Option<String> {
    text(images?, key).filter(|url| {
        url.starts_with("https://hexdb.io/")
            && !url.chars().any(|c| c.is_whitespace() || c.is_control())
    })
}

/// Parse hexdb `/api/v2/aircraft/{hex}`. A body with neither type nor
/// registration counts as unknown.
pub fn parse_hexdb_aircraft(
    hex: &str,
    status: u16,
    body: &str,
    now_ms: i64,
) -> Result<AircraftInfo, String> {
    let a = hexdb_object(status, body)?.unwrap_or(Value::Null);
    let images = a.get("images");
    let mut info = AircraftInfo {
        hex_ident: hex.to_string(),
        found: false,
        icao_type: text(&a, "icao_type_code"),
        type_name: text(&a, "type"),
        manufacturer: text(&a, "manufacturer"),
        registration: text(&a, "registration"),
        owner: text(&a, "registered_owner"),
        owner_country: None,
        photo_url: hexdb_image(images, "full"),
        photo_thumb_url: hexdb_image(images, "thumbnail"),
        provider: Some(HEXDB.into()),
        operator_icao: text(&a, "operator_flag_code"),
        fetched_at_ms: now_ms,
    };
    info.found =
        info.registration.is_some() || info.icao_type.is_some() || info.type_name.is_some();
    Ok(info)
}

/// One airport of a hexdb v2 route. `country` is the ISO code; hexdb's
/// `region` is a state or province, not a city, so `city` stays empty.
fn parse_hexdb_airport(v: Option<&Value>) -> Option<Airport> {
    let v = v?;
    Some(Airport {
        icao: text(v, "icao")?.to_uppercase(),
        iata: text(v, "iata"),
        name: text(v, "name"),
        city: None,
        country: text(v, "country_code"),
        latitude: v.get("latitude").and_then(Value::as_f64),
        longitude: v.get("longitude").and_then(Value::as_f64),
    })
}

/// Parse hexdb `/api/v2/routes/{callsign}`. `airports` lists every airport
/// in order; `origin` and `destination` repeat its ends and win when present.
/// Everything in between is a stop. hexdb names no airline.
pub fn parse_hexdb_route(
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
        stops: Vec::new(),
        updated_at: None,
        provider: Some(HEXDB.into()),
        fetched_at_ms: now_ms,
    };
    let Some(v) = hexdb_object(status, body)? else {
        return Ok(route);
    };
    let airports: Vec<Airport> = v
        .get("airports")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|a| parse_hexdb_airport(Some(a)))
                .collect()
        })
        .unwrap_or_default();
    route.origin = parse_hexdb_airport(v.get("origin")).or_else(|| airports.first().cloned());
    route.destination =
        parse_hexdb_airport(v.get("destination")).or_else(|| airports.last().cloned());
    if airports.len() > 2 {
        let ends = [route.origin.as_ref(), route.destination.as_ref()].map(|a| a.map(|a| &a.icao));
        route.stops = airports[1..airports.len() - 1]
            .iter()
            .filter(|a| !ends.contains(&Some(&a.icao)))
            .cloned()
            .collect();
    }
    route.updated_at = text(&v, "updated_at");
    route.found = route.origin.is_some() || route.destination.is_some();
    Ok(route)
}

/// The sources a cached "unknown" already speaks for. An unknown that the
/// lookup stores always comes after asking every source, and is tagged with
/// the last of `order`. Any other tag is older: an untagged row predates the
/// fallback and came from adsbdb alone, and a tagged one only from that source.
fn already_asked(order: [&'static str; 2], provider: Option<&str>) -> Vec<&'static str> {
    match provider {
        Some(p) if p == order[1] => order.to_vec(),
        Some(p) => order.into_iter().filter(|s| *s == p).collect(),
        None => vec![ADSBDB],
    }
}

/// The sources to ask for one part, in order. A cached "unknown" under a day
/// old skips the sources that gave it; anything else asks them all.
fn sources_to_ask(
    order: [&'static str; 2],
    cached_unknown: Option<(Option<&str>, i64)>,
    now_ms: i64,
) -> Vec<&'static str> {
    match cached_unknown {
        Some((provider, at_ms)) if now_ms - at_ms < NEGATIVE_TTL_MS => {
            let asked = already_asked(order, provider);
            order.into_iter().filter(|s| !asked.contains(s)).collect()
        }
        _ => order.to_vec(),
    }
}

/// Whether a cached row answers without asking anyone: a known row within
/// its TTL, or an "unknown" that every source has given within a day.
fn fresh(
    order: [&'static str; 2],
    found: bool,
    provider: Option<&str>,
    at_ms: i64,
    ttl_ms: i64,
    now_ms: i64,
) -> bool {
    if found {
        now_ms - at_ms < ttl_ms
    } else {
        sources_to_ask(order, Some((provider, at_ms)), now_ms).is_empty()
    }
}

/// Ask `sources` in turn until one knows the part. When none does, the last
/// "unknown" is the answer, tagged with the last source of `order` to record
/// that every source has now said so. An error from any source is an error,
/// never cached as "unknown".
async fn ask_in_turn<T, Fut>(
    sources: &[&'static str],
    order: [&'static str; 2],
    mut ask: impl FnMut(&'static str) -> Fut,
    found: impl Fn(&T) -> bool,
    tag: impl FnOnce(&mut T, String),
) -> Result<T, String>
where
    Fut: Future<Output = Result<T, String>>,
{
    let mut last = None;
    for src in sources {
        let v = ask(src).await?;
        if found(&v) {
            return Ok(v);
        }
        last = Some(v);
    }
    let mut v = last.ok_or("flight info: no source to ask")?;
    tag(&mut v, order[1].to_string());
    Ok(v)
}

async fn load_aircraft<F, Fut>(
    hex: &str,
    now_ms: i64,
    sources: &[&'static str],
    fetch: &F,
) -> Result<AircraftInfo, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<FetchResponse, String>>,
{
    ask_in_turn(
        sources,
        AIRFRAME_SOURCES,
        |src| async move {
            if src == HEXDB {
                let r = fetch(hexdb_aircraft_url(hex)).await?;
                parse_hexdb_aircraft(hex, r.status, &r.body, now_ms)
            } else {
                let r = fetch(aircraft_url(hex)).await?;
                parse_aircraft(hex, r.status, &r.body, now_ms)
            }
        },
        |a: &AircraftInfo| a.found,
        |a, p| a.provider = Some(p),
    )
    .await
}

async fn load_route<F, Fut>(
    storage: &SharedStorage,
    callsign: &str,
    now_ms: i64,
    sources: &[&'static str],
    fetch: &F,
) -> Result<FlightRoute, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<FetchResponse, String>>,
{
    let mut route = ask_in_turn(
        sources,
        ROUTE_SOURCES,
        |src| async move {
            if src == HEXDB {
                let r = fetch(hexdb_route_url(callsign)).await?;
                parse_hexdb_route(callsign, r.status, &r.body, now_ms)
            } else {
                let r = fetch(callsign_url(callsign)).await?;
                parse_route(callsign, r.status, &r.body, now_ms)
            }
        },
        |r: &FlightRoute| r.found,
        |r, p| r.provider = Some(p),
    )
    .await?;
    if let Some(a) = route.origin.take() {
        route.origin = Some(place_airport(storage, a, now_ms, fetch).await);
    }
    for a in std::mem::take(&mut route.stops) {
        route
            .stops
            .push(place_airport(storage, a, now_ms, fetch).await);
    }
    if let Some(a) = route.destination.take() {
        route.destination = Some(place_airport(storage, a, now_ms, fetch).await);
    }
    Ok(route)
}

/// An airport with coordinates, so it can be drawn: as given when it has
/// them, else from the `airports` cache, else from hexdb (and cached). On
/// any failure, the airport as given: a missing position is not an error.
async fn place_airport<F, Fut>(
    storage: &SharedStorage,
    airport: Airport,
    now_ms: i64,
    fetch: &F,
) -> Airport
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<FetchResponse, String>>,
{
    if airport.latitude.is_some() && airport.longitude.is_some() {
        return airport;
    }
    let key = airport.icao.clone();
    if let Some((a, _)) = with_storage(storage, move |s| s.get_airport_sync(&key))
        .await
        .flatten()
        .filter(|(_, at)| now_ms - at < AIRPORT_TTL_MS)
    {
        return a;
    }
    let looked_up = fetch(hexdb_airport_url(&airport.icao))
        .await
        .and_then(|r| hexdb_object(r.status, &r.body))
        .map(|v| v.and_then(|v| parse_hexdb_airport(Some(&v))));
    match looked_up {
        Ok(Some(found)) if found.latitude.is_some() && found.longitude.is_some() => {
            let row = found.clone();
            with_storage(storage, move |s| s.upsert_airport_sync(&row, now_ms)).await;
            Airport {
                // Keep what the route said; take the rest from the lookup.
                iata: airport.iata.or(found.iata),
                name: airport.name.or(found.name),
                city: airport.city.or(found.city),
                country: airport.country.or(found.country),
                ..found
            }
        }
        Ok(_) => airport,
        Err(e) => {
            warn!("hexdb airport {}: {e}", airport.icao);
            airport
        }
    }
}

/// A route without an airline takes the airframe's operator when the
/// callsign is that operator's (`EZY12AB` flown by an `EZY` airframe). Done
/// per answer and never stored: the route and the airframe are cached apart.
fn borrow_airline(route: &mut FlightRoute, aircraft: Option<&AircraftInfo>) {
    let Some(a) = aircraft.filter(|a| a.found) else {
        return;
    };
    let (Some(op), Some(owner)) = (a.operator_icao.as_deref(), a.owner.as_deref()) else {
        return;
    };
    if route.found && route.airline_name.is_none() && route.callsign.starts_with(op) {
        route.airline_name = Some(owner.to_string());
        route.airline_icao = Some(op.to_string());
    }
}

fn aircraft_fresh(a: &AircraftInfo, now_ms: i64) -> bool {
    let p = a.provider.as_deref();
    fresh(
        AIRFRAME_SOURCES,
        a.found,
        p,
        a.fetched_at_ms,
        AIRCRAFT_TTL_MS,
        now_ms,
    )
}

fn route_fresh(r: &FlightRoute, now_ms: i64) -> bool {
    let p = r.provider.as_deref();
    fresh(
        ROUTE_SOURCES,
        r.found,
        p,
        r.fetched_at_ms,
        ROUTE_TTL_MS,
        now_ms,
    )
}

/// The sources that were asked to produce a row. A known row: every source
/// before its provider in `order`, and the provider. An unknown row: see
/// [`already_asked`]. Untagged rows predate hexdb and came from adsbdb alone.
fn sources_behind(
    order: [&'static str; 2],
    found: bool,
    provider: Option<&str>,
) -> Vec<&'static str> {
    if !found {
        return already_asked(order, provider);
    }
    match provider {
        Some(p) => match order.iter().position(|s| *s == p) {
            Some(i) => order[..=i].to_vec(),
            None => Vec::new(),
        },
        None => vec![ADSBDB],
    }
}

/// `(provider, fetched_at)` of a cached "unknown", for [`sources_to_ask`].
fn unknown_of(found: bool, provider: &Option<String>, at_ms: i64) -> Option<(Option<&str>, i64)> {
    (!found).then_some((provider.as_deref(), at_ms))
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

/// The cached value while fresh, else whatever `load` (not polled unless
/// needed) returns, falling back to the expired cached value on error.
async fn refresh<T: Clone>(
    cached: Option<T>,
    fresh: impl Fn(&T) -> bool,
    load: impl Future<Output = Result<T, String>>,
) -> Outcome<T> {
    if let Some(c) = cached.as_ref().filter(|c| fresh(c)) {
        return Outcome::Cached(c.clone());
    }
    match load.await {
        Ok(v) => Outcome::Fetched(v),
        Err(e) => match cached {
            Some(c) => Outcome::Stale(c, e),
            None => Outcome::Failed(e),
        },
    }
}

/// Airframe and route for one aircraft: from the cache while fresh, else
/// from the web via `fetch(url)`, writing the answer back to the cache. The
/// airframe is asked of adsbdb then hexdb, the route of hexdb then adsbdb;
/// the second source only when the first does not know.
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
    let sources = sources_to_ask(
        AIRFRAME_SOURCES,
        cached
            .as_ref()
            .and_then(|a| unknown_of(a.found, &a.provider, a.fetched_at_ms)),
        now_ms,
    );
    match refresh(
        cached,
        |a| aircraft_fresh(a, now_ms),
        load_aircraft(&hex, now_ms, &sources, &fetch),
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
        let sources = sources_to_ask(
            ROUTE_SOURCES,
            cached
                .as_ref()
                .and_then(|r| unknown_of(r.found, &r.provider, r.fetched_at_ms)),
            now_ms,
        );
        match refresh(
            cached,
            |r| route_fresh(r, now_ms),
            load_route(storage, &cs, now_ms, &sources, &fetch),
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

    let mut asked: Vec<&str> = Vec::new();
    if let Some(a) = info.aircraft.as_ref() {
        asked.extend(sources_behind(
            AIRFRAME_SOURCES,
            a.found,
            a.provider.as_deref(),
        ));
    }
    if let Some(r) = info.route.as_ref() {
        asked.extend(sources_behind(
            ROUTE_SOURCES,
            r.found,
            r.provider.as_deref(),
        ));
    }
    info.sources = [ADSBDB, HEXDB]
        .into_iter()
        .filter(|s| asked.contains(s))
        .map(String::from)
        .collect();
    if let Some(route) = info.route.as_mut() {
        borrow_airline(route, info.aircraft.as_ref());
    }
    if !errors.is_empty() {
        errors.dedup();
        info.error = Some(errors.join("; "));
    }
    info
}

/// The source named in error messages: `adsbdb` or `hexdb`, else the host.
pub fn source_name(url: &str) -> &str {
    if url.starts_with(ADSBDB_BASE) {
        ADSBDB
    } else if url.starts_with(HEXDB_BASE) {
        HEXDB
    } else {
        url.split("://")
            .nth(1)
            .and_then(|r| r.split(['/', '?', '#']).next())
            .unwrap_or(url)
    }
}

/// The real fetch, for adsbdb and hexdb alike: one GET with a short timeout
/// and an identifying agent.
#[cfg(feature = "web-lookup")]
pub async fn fetch_adsbdb(client: &reqwest::Client, url: String) -> Result<FetchResponse, String> {
    let src = source_name(&url);
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("{src} unreachable ({e})"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("{src}: unreadable body ({e})"))?;
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

    // hexdb v2 bodies, shaped as the live API answered on 2026-11-24.
    const HEXDB_AIRCRAFT_200: &str = r#"{"hex": "4CA87C", "registration": "EI-DCL", "manufacturer": "Boeing", "type": "737-8AS", "icao_type_code": "B738", "registered_owner": "Ryanair", "operator_flag_code": "RYR", "images": {"full": "https://hexdb.io/static/aircraft-images/EI-DCL.jpg", "thumbnail": "https://hexdb.io/static/aircraft-images/EI-DCL-thumb.jpg"}, "links": {"self": "/api/v2/aircraft/4CA87C"}}"#;
    const HEXDB_FULL: &str = "https://hexdb.io/static/aircraft-images/EI-DCL.jpg";
    const HEXDB_THUMB: &str = "https://hexdb.io/static/aircraft-images/EI-DCL-thumb.jpg";
    const HEXDB_ROUTE_200: &str = r#"{"callsign": "EZY12AB", "origin": {"icao": "LFRS", "iata": "NTE", "name": "Nantes Atlantique Airport", "country_code": "FR", "region": "Pays de la Loire", "latitude": 47.1532, "longitude": -1.61073}, "destination": {"icao": "EDDF", "iata": "FRA", "name": "Frankfurt Airport", "country_code": "DE", "region": "Hessen", "latitude": 50.0333, "longitude": 8.57056}, "airports": [{"icao": "LFRS", "iata": "NTE", "name": "Nantes Atlantique Airport", "country_code": "FR", "region": "Pays de la Loire", "latitude": 47.1532, "longitude": -1.61073}, {"icao": "EDDF", "iata": "FRA", "name": "Frankfurt Airport", "country_code": "DE", "region": "Hessen", "latitude": 50.0333, "longitude": 8.57056}], "updated_at": "2026-10-24T16:43:07Z"}"#;
    // Multi-stop: hexdb lists every stop; adsbdb only knows the first leg.
    const HEXDB_QFA1: &str = r#"{"callsign": "QFA1", "origin": {"icao": "YSSY", "iata": "SYD", "name": "Sydney Kingsford Smith International Airport", "country_code": "AU", "region": "New South Wales", "latitude": -33.9461, "longitude": 151.177}, "destination": {"icao": "EGLL", "iata": "LHR", "name": "London Heathrow Airport", "country_code": "GB", "region": "England", "latitude": 51.4775, "longitude": -0.461389}, "airports": [{"icao": "YSSY", "iata": "SYD", "name": "Sydney Kingsford Smith International Airport", "country_code": "AU", "region": "New South Wales", "latitude": -33.9461, "longitude": 151.177}, {"icao": "WSSS", "iata": "SIN", "name": "Singapore Changi Airport", "country_code": "SG", "region": "Singapore", "latitude": 1.35019, "longitude": 103.994}, {"icao": "EGLL", "iata": "LHR", "name": "London Heathrow Airport", "country_code": "GB", "region": "England", "latitude": 51.4775, "longitude": -0.461389}], "updated_at": "2026-08-30T17:07:13Z"}"#;
    const ADSBDB_QFA1: &str = r#"{"response":{"flightroute":{"callsign":"QFA1","airline":{"name":"Qantas","icao":"QFA","iata":"QF"},"origin":{"icao_code":"YSSY","name":"Sydney"},"destination":{"icao_code":"WSSS","name":"Singapore"}}}}"#;
    const ADSBDB_QFA9_MIDPOINT: &str = r#"{"response":{"flightroute":{"callsign":"QFA9","airline":{"name":"Qantas","icao":"QFA","iata":"QF"},"origin":{"icao_code":"YMML","name":"Melbourne Airport","latitude":-37.67,"longitude":144.84},"midpoint":{"country_name":"Singapore","iata_code":"SIN","icao_code":"WSSS","latitude":1.35019,"longitude":103.994,"municipality":"Singapore","name":"Singapore Changi Airport"},"destination":{"icao_code":"EGLL","name":"London Heathrow Airport","latitude":51.47,"longitude":-0.46}}}}"#;
    const HEXDB_RYR12AB: &str = r#"{"callsign": "RYR12AB", "origin": {"icao": "LFRS", "name": "Nantes Atlantique Airport", "latitude": 47.1532, "longitude": -1.61073}, "destination": {"icao": "EIDW", "name": "Dublin Airport", "latitude": 53.4213, "longitude": -6.27007}}"#;
    // Airports given by code only, as the airports list can be.
    const HEXDB_BARE_EGLL_TO_WSSS: &str = r#"{"callsign": "BAW15X", "airports": [{"icao": "EGLL"}, {"icao": "WSSS", "name": "Singapore Changi Airport", "latitude": 1.35019, "longitude": 103.994}]}"#;
    const HEXDB_BARE_EGLL_TO_ZZZZ: &str =
        r#"{"callsign": "BAW16X", "airports": [{"icao": "EGLL"}, {"icao": "ZZZZ"}]}"#;
    const HEXDB_AIRPORT_EGLL: &str = r#"{"icao": "EGLL", "iata": "LHR", "name": "London Heathrow Airport", "country_code": "GB", "region": "England", "latitude": 51.4775, "longitude": -0.461389}"#;
    const HEXDB_AIRPORT_404: &str = r#"{"error": {"status": 404, "code": "airport_not_found", "message": "No airport with ICAO code ZZZZ."}}"#;
    const HEXDB_AIRCRAFT_404: &str = r#"{"error": {"status": 404, "code": "aircraft_not_found", "message": "No aircraft with hex code 000000."}}"#;
    const HEXDB_ROUTE_404: &str = r#"{"error": {"status": 404, "code": "route_not_found", "message": "No route for callsign ZZZ9999."}}"#;

    /// A fake fetch answering by URL, recording every URL asked. adsbdb knows
    /// 3C6444 / DLH400; hexdb knows 4CA87C / EZY12AB; everything else is 404.
    #[derive(Clone, Default)]
    struct FakeWeb {
        asked: Arc<Mutex<Vec<String>>>,
        fail: bool,
        hexdb_down: bool,
        adsbdb_status: Option<u16>,
    }

    impl FakeWeb {
        fn failing() -> Self {
            Self {
                fail: true,
                ..Self::default()
            }
        }
        fn hexdb_down() -> Self {
            Self {
                hexdb_down: true,
                ..Self::default()
            }
        }
        /// adsbdb answers every request with this status and an empty body.
        fn adsbdb_status(status: u16) -> Self {
            Self {
                adsbdb_status: Some(status),
                ..Self::default()
            }
        }
        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
        fn asked_hexdb(&self) -> usize {
            self.asked()
                .iter()
                .filter(|u| u.starts_with(HEXDB_BASE))
                .count()
        }
        fn fetch(&self) -> impl Fn(String) -> std::future::Ready<Result<FetchResponse, String>> {
            let me = self.clone();
            move |url: String| {
                me.asked.lock().unwrap().push(url.clone());
                let hexdb = url.starts_with(HEXDB_BASE);
                if me.fail || (hexdb && me.hexdb_down) {
                    return std::future::ready(Err("offline".to_string()));
                }
                let (status, body) = if let (false, Some(st)) = (hexdb, me.adsbdb_status) {
                    (st, "")
                } else if url.ends_with("/v0/aircraft/3C6444") {
                    (200, AIRCRAFT_200)
                } else if url.ends_with("/v0/callsign/DLH400") {
                    (200, ROUTE_200)
                } else if url.ends_with("/v0/callsign/QFA1") {
                    (200, ADSBDB_QFA1)
                } else if url.contains("/v0/aircraft/") {
                    (404, UNKNOWN_AIRCRAFT)
                } else if url.contains("/v0/callsign/") {
                    (404, UNKNOWN_CALLSIGN)
                } else if url.ends_with("/api/v2/aircraft/4CA87C") {
                    (200, HEXDB_AIRCRAFT_200)
                } else if url.ends_with("/api/v2/routes/EZY12AB") {
                    (200, HEXDB_ROUTE_200)
                } else if url.ends_with("/api/v2/routes/QFA1") {
                    (200, HEXDB_QFA1)
                } else if url.ends_with("/api/v2/routes/RYR12AB") {
                    (200, HEXDB_RYR12AB)
                } else if url.ends_with("/api/v2/routes/BAW15X") {
                    (200, HEXDB_BARE_EGLL_TO_WSSS)
                } else if url.ends_with("/api/v2/routes/BAW16X") {
                    (200, HEXDB_BARE_EGLL_TO_ZZZZ)
                } else if url.ends_with("/api/v2/airports/EGLL") {
                    (200, HEXDB_AIRPORT_EGLL)
                } else if url.contains("/api/v2/airports/") {
                    (404, HEXDB_AIRPORT_404)
                } else if url.contains("/api/v2/routes/") {
                    (404, HEXDB_ROUTE_404)
                } else {
                    (404, HEXDB_AIRCRAFT_404)
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
    fn errors_name_the_source() {
        assert_eq!(source_name(&aircraft_url("3C6444")), "adsbdb");
        assert_eq!(source_name(&hexdb_route_url("DLH400")), "hexdb");
        assert_eq!(source_name("https://example.test/x?y"), "example.test");
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
                format!("{HEXDB_BASE}/api/v2/routes/DLH400"),
                format!("{ADSBDB_BASE}/callsign/DLH400")
            ],
            "routes: hexdb first, adsbdb when hexdb does not know the callsign"
        );

        // Second ask: served from DuckDB, no request.
        let again = lookup(&storage, "3C6444", Some("DLH400"), NOW + 1000, web.fetch()).await;
        assert_eq!(again.source, InfoSource::Cache);
        assert!(again.route.unwrap().found);
        assert_eq!(web.asked().len(), 3);
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
        assert_eq!(asked.len(), 5);
        assert!(asked[4].ends_with("/callsign/DLH400"));
    }

    #[tokio::test]
    async fn unknown_answers_are_negative_cached() {
        let storage = shared();
        let web = FakeWeb::default();
        let info = lookup(&storage, "000000", Some("ZZZ9999"), NOW, web.fetch()).await;
        assert!(!info.aircraft.unwrap().found);
        assert!(!info.route.unwrap().found);
        assert_eq!(info.error, None);
        assert_eq!(web.asked().len(), 4, "adsbdb then hexdb, for each part");
        let row = cached_aircraft(&storage, "000000").unwrap();
        assert!(!row.found);
        assert_eq!(
            row.provider.as_deref(),
            Some("hexdb"),
            "an unknown row from hexdb means both sources were asked"
        );
        lookup(&storage, "000000", Some("ZZZ9999"), NOW + 1, web.fetch()).await;
        assert_eq!(web.asked().len(), 4, "negative rows must stop re-asking");
        lookup(
            &storage,
            "000000",
            Some("ZZZ9999"),
            NOW + NEGATIVE_TTL_MS,
            web.fetch(),
        )
        .await;
        assert_eq!(web.asked().len(), 8, "negative rows expire after a day");
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

    fn cached_aircraft(storage: &SharedStorage, hex: &str) -> Option<AircraftInfo> {
        let guard = storage.try_read().unwrap();
        guard.as_ref().unwrap().get_aircraft_info_sync(hex).unwrap()
    }

    /// Cache what adsbdb said before the fallback existed: unknown, no tag.
    fn cache_adsbdb_unknown(storage: &SharedStorage, hex: &str, cs: &str, at: i64) {
        let guard = storage.try_read().unwrap();
        let s = guard.as_ref().unwrap();
        let mut a = parse_aircraft(hex, 404, UNKNOWN_AIRCRAFT, at).unwrap();
        a.provider = None;
        s.upsert_aircraft_info_sync(&a).unwrap();
        let mut r = parse_route(cs, 404, UNKNOWN_CALLSIGN, at).unwrap();
        r.provider = None;
        s.upsert_flight_route_sync(&r).unwrap();
    }

    #[test]
    fn parses_hexdb_aircraft() {
        let a = parse_hexdb_aircraft("4CA87C", 200, HEXDB_AIRCRAFT_200, NOW).unwrap();
        assert!(a.found);
        assert_eq!(a.icao_type.as_deref(), Some("B738"));
        assert_eq!(a.type_name.as_deref(), Some("737-8AS"));
        assert_eq!(a.manufacturer.as_deref(), Some("Boeing"));
        assert_eq!(a.registration.as_deref(), Some("EI-DCL"));
        assert_eq!(a.owner.as_deref(), Some("Ryanair"));
        assert_eq!(a.owner_country, None);
        assert_eq!(a.photo_url.as_deref(), Some(HEXDB_FULL));
        assert_eq!(a.photo_thumb_url.as_deref(), Some(HEXDB_THUMB));
        assert_eq!(a.provider.as_deref(), Some("hexdb"));
        assert_eq!(a.fetched_at_ms, NOW);
    }

    /// A real answer (French Air Force A330 MRTT), as hexdb returned it.
    const HEXDB_MRTT: &str = r#"{"hex": "3B7568", "registration": "047", "manufacturer": "Airbus", "type": "Phenix 243MRTT", "icao_type_code": "A332", "registered_owner": "French Air Force", "operator_flag_code": "CTM", "images": {"full": "https://hexdb.io/static/aircraft-images/047.jpg", "thumbnail": "https://hexdb.io/static/aircraft-images/047-thumb.jpg"}, "links": {"self": "/api/v2/aircraft/3B7568"}}"#;

    #[test]
    fn parses_a_real_hexdb_answer() {
        let a = parse_hexdb_aircraft("3B7568", 200, HEXDB_MRTT, NOW).unwrap();
        assert!(a.found);
        assert_eq!(a.registration.as_deref(), Some("047"));
        assert_eq!(a.type_name.as_deref(), Some("Phenix 243MRTT"));
        assert_eq!(a.icao_type.as_deref(), Some("A332"));
        assert_eq!(a.owner.as_deref(), Some("French Air Force"));
        assert_eq!(
            a.photo_thumb_url.as_deref(),
            Some("https://hexdb.io/static/aircraft-images/047-thumb.jpg")
        );
    }

    #[test]
    fn hexdb_unknown_and_errors() {
        let unknown = parse_hexdb_aircraft("000000", 404, HEXDB_AIRCRAFT_404, NOW).unwrap();
        assert!(!unknown.found);
        assert_eq!(unknown.provider.as_deref(), Some("hexdb"));
        let empty = parse_hexdb_aircraft("000000", 200, r#"{"hex": "000000"}"#, NOW).unwrap();
        assert!(!empty.found, "no type and no registration is no answer");
        assert!(parse_hexdb_aircraft("4CA87C", 200, "<html>", NOW).is_err());
        assert!(
            parse_hexdb_aircraft("4CA87C", 429, "", NOW)
                .unwrap_err()
                .contains("rate limited")
        );
        assert!(
            parse_hexdb_route("X1", 503, "", NOW)
                .unwrap_err()
                .contains("HTTP 503")
        );
    }

    #[test]
    fn hexdb_images_must_be_https_on_hexdb() {
        let body = |full: &str, thumb: &str| {
            format!(
                r#"{{"registration": "EI-DCL", "images": {{"full": {full}, "thumbnail": {thumb}}}}}"#
            )
        };
        let a = parse_hexdb_aircraft(
            "4CA87C",
            200,
            &body(r#""https://evil.test/x.jpg""#, r#""http://hexdb.io/t.jpg""#),
            NOW,
        )
        .unwrap();
        assert!(a.found);
        assert_eq!((a.photo_url, a.photo_thumb_url), (None, None));
        let a = parse_hexdb_aircraft("4CA87C", 200, &body("null", "null"), NOW).unwrap();
        assert_eq!((a.photo_url, a.photo_thumb_url), (None, None));
        let a = parse_hexdb_aircraft("4CA87C", 200, r#"{"registration": "EI-DCL"}"#, NOW).unwrap();
        assert_eq!(a.photo_thumb_url, None);
    }

    #[test]
    fn adsbdb_answers_are_tagged() {
        let a = parse_aircraft("3C6444", 200, AIRCRAFT_200, NOW).unwrap();
        assert_eq!(a.provider.as_deref(), Some("adsbdb"));
        let r = parse_route("DLH400", 200, ROUTE_200, NOW).unwrap();
        assert_eq!(r.provider.as_deref(), Some("adsbdb"));
    }

    #[test]
    fn parses_hexdb_route_with_its_airports() {
        let r = parse_hexdb_route("EZY12AB", 200, HEXDB_ROUTE_200, NOW).unwrap();
        assert!(r.found);
        assert_eq!(r.airline_name, None, "hexdb has no airline");
        assert_eq!(r.provider.as_deref(), Some("hexdb"));
        let o = r.origin.unwrap();
        assert_eq!(o.icao, "LFRS");
        assert_eq!(o.iata.as_deref(), Some("NTE"));
        assert_eq!(o.name.as_deref(), Some("Nantes Atlantique Airport"));
        assert_eq!(o.country.as_deref(), Some("FR"));
        assert_eq!(o.city, None);
        assert_eq!(o.latitude, Some(47.1532));
        assert_eq!(r.destination.unwrap().icao, "EDDF");
    }

    #[test]
    fn hexdb_route_falls_back_to_the_airport_list() {
        let body = r#"{"callsign": "X1", "airports": [{"icao": "LFRS"}, {"icao": "EGKK"}, {"icao": "EDDF", "name": "Frankfurt Airport"}]}"#;
        let r = parse_hexdb_route("X1", 200, body, NOW).unwrap();
        assert!(r.found);
        assert_eq!(r.origin.unwrap().icao, "LFRS");
        assert_eq!(
            r.destination.unwrap().name.as_deref(),
            Some("Frankfurt Airport")
        );
        for body in [
            r#"{"callsign": "X1"}"#,
            r#"{"callsign": "X1", "origin": {"name": "no code"}}"#,
        ] {
            assert!(
                !parse_hexdb_route("X1", 200, body, NOW).unwrap().found,
                "{body}"
            );
        }
        assert!(
            !parse_hexdb_route("X1", 404, HEXDB_ROUTE_404, NOW)
                .unwrap()
                .found
        );
    }

    #[tokio::test]
    async fn airframe_known_to_adsbdb_never_asks_hexdb() {
        let web = FakeWeb::default();
        lookup(&shared(), "3C6444", None, NOW, web.fetch()).await;
        assert_eq!(web.asked_hexdb(), 0);
    }

    #[tokio::test]
    async fn route_known_to_hexdb_never_asks_adsbdb() {
        let storage = shared();
        let web = FakeWeb::default();
        let info = lookup(&storage, "3C6444", Some("QFA1"), NOW, web.fetch()).await;
        assert!(
            !web.asked().iter().any(|u| u.contains("/v0/callsign/")),
            "hexdb answered: adsbdb's shorter route is not asked"
        );
        let r = info.route.unwrap();
        assert_eq!(r.provider.as_deref(), Some("hexdb"));
        assert_eq!(r.origin.as_ref().unwrap().icao, "YSSY");
        assert_eq!(r.destination.as_ref().unwrap().icao, "EGLL");
        let stops: Vec<&str> = r.stops.iter().map(|a| a.icao.as_str()).collect();
        assert_eq!(stops, ["WSSS"]);
        let cached = lookup(&storage, "3C6444", Some("QFA1"), NOW + 1, web.fetch()).await;
        assert_eq!(
            cached.route.unwrap().stops.len(),
            1,
            "stops survive the cache"
        );
    }

    #[tokio::test]
    async fn unknown_to_adsbdb_falls_back_to_hexdb_and_caches_it() {
        let storage = shared();
        let web = FakeWeb::default();
        let info = lookup(&storage, "4ca87c", Some("ezy12ab"), NOW, web.fetch()).await;
        assert_eq!(info.error, None);
        assert_eq!(info.source, InfoSource::Web);
        let a = info.aircraft.unwrap();
        assert!(a.found);
        assert_eq!(a.registration.as_deref(), Some("EI-DCL"));
        assert_eq!(a.provider.as_deref(), Some("hexdb"));
        assert_eq!(a.photo_thumb_url.as_deref(), Some(HEXDB_THUMB));
        let r = info.route.unwrap();
        assert!(r.found);
        assert_eq!(r.provider.as_deref(), Some("hexdb"));
        assert_eq!(
            r.origin.unwrap().name.as_deref(),
            Some("Nantes Atlantique Airport")
        );
        assert_eq!(
            web.asked(),
            vec![
                format!("{ADSBDB_BASE}/aircraft/4CA87C"),
                format!("{HEXDB_BASE}/api/v2/aircraft/4CA87C"),
                format!("{HEXDB_BASE}/api/v2/routes/EZY12AB"),
            ],
            "photo and airports come inline: one hexdb request per part"
        );

        let again = lookup(&storage, "4CA87C", Some("EZY12AB"), NOW + 1, web.fetch()).await;
        assert_eq!(again.source, InfoSource::Cache);
        assert_eq!(again.aircraft.unwrap().provider.as_deref(), Some("hexdb"));
        assert_eq!(again.route.unwrap().destination.unwrap().icao, "EDDF");
        assert_eq!(web.asked().len(), 3, "served from DuckDB");
    }

    #[tokio::test]
    async fn cached_adsbdb_unknown_asks_hexdb_at_once() {
        let storage = shared();
        cache_adsbdb_unknown(&storage, "4CA87C", "EZY12AB", NOW - 1000);
        let web = FakeWeb::default();
        let info = lookup(&storage, "4CA87C", Some("EZY12AB"), NOW, web.fetch()).await;
        assert!(info.aircraft.unwrap().found);
        assert!(info.route.unwrap().found);
        assert_eq!(info.source, InfoSource::Web);
        assert_eq!(
            web.asked(),
            vec![
                format!("{HEXDB_BASE}/api/v2/aircraft/4CA87C"),
                format!("{HEXDB_BASE}/api/v2/routes/EZY12AB"),
            ],
            "adsbdb already said unknown today: only hexdb is asked"
        );
        assert_eq!(
            cached_aircraft(&storage, "4CA87C")
                .unwrap()
                .provider
                .as_deref(),
            Some("hexdb")
        );
    }

    #[tokio::test]
    async fn cached_adsbdb_unknown_then_hexdb_unknown_stops_asking() {
        let storage = shared();
        cache_adsbdb_unknown(&storage, "000000", "ZZZ9999", NOW - 1000);
        let web = FakeWeb::default();
        let info = lookup(&storage, "000000", Some("ZZZ9999"), NOW, web.fetch()).await;
        assert!(!info.aircraft.unwrap().found);
        assert_eq!(web.asked().len(), 2, "hexdb only");
        lookup(&storage, "000000", Some("ZZZ9999"), NOW + 1, web.fetch()).await;
        assert_eq!(web.asked().len(), 2, "both unknown: cached for a day");
    }

    #[tokio::test]
    async fn expired_adsbdb_unknown_asks_both_again() {
        let storage = shared();
        cache_adsbdb_unknown(&storage, "4CA87C", "EZY12AB", NOW - NEGATIVE_TTL_MS);
        let web = FakeWeb::default();
        lookup(&storage, "4CA87C", Some("EZY12AB"), NOW, web.fetch()).await;
        assert_eq!(web.asked().len(), 3, "airframe: both; route: hexdb knew it");
        assert_eq!(web.asked_hexdb(), 2);
    }

    #[tokio::test]
    async fn a_first_source_error_does_not_fall_back() {
        // Airframe: adsbdb first.
        for web in [FakeWeb::adsbdb_status(429), FakeWeb::adsbdb_status(503)] {
            let info = lookup(&shared(), "4CA87C", None, NOW, web.fetch()).await;
            assert_eq!(info.aircraft, None);
            assert!(info.error.is_some());
            assert_eq!(web.asked_hexdb(), 0);
        }
        // Route: hexdb first; adsbdb knows DLH400 but is not asked.
        let web = FakeWeb::hexdb_down();
        let info = lookup(&shared(), "3C6444", Some("DLH400"), NOW, web.fetch()).await;
        assert_eq!(info.route, None);
        assert_eq!(info.error.as_deref(), Some("offline"));
        assert!(!web.asked().iter().any(|u| u.contains("/v0/callsign/")));
    }

    #[tokio::test]
    async fn hexdb_failure_is_reported_and_not_cached() {
        let storage = shared();
        let web = FakeWeb::hexdb_down();
        let info = lookup(&storage, "4CA87C", Some("EZY12AB"), NOW, web.fetch()).await;
        assert_eq!(info.aircraft, None);
        assert_eq!(info.route, None);
        assert_eq!(info.error.as_deref(), Some("offline"));
        assert_eq!(
            web.asked().len(),
            3,
            "airframe: adsbdb then hexdb; route: hexdb"
        );

        // hexdb back: the next click asks again rather than serving "unknown".
        let web = FakeWeb::default();
        let info = lookup(&storage, "4CA87C", Some("EZY12AB"), NOW + 1, web.fetch()).await;
        assert!(info.aircraft.unwrap().found);
        assert!(info.route.unwrap().found);
    }

    #[tokio::test]
    async fn hexdb_failure_over_a_cached_unknown_keeps_retrying_hexdb() {
        let storage = shared();
        cache_adsbdb_unknown(&storage, "4CA87C", "EZY12AB", NOW - 1000);
        let web = FakeWeb::hexdb_down();
        let info = lookup(&storage, "4CA87C", Some("EZY12AB"), NOW, web.fetch()).await;
        assert!(!info.aircraft.unwrap().found);
        assert!(info.stale);
        assert_eq!(info.error.as_deref(), Some("offline"));
        let web = FakeWeb::default();
        lookup(&storage, "4CA87C", Some("EZY12AB"), NOW + 1, web.fetch()).await;
        assert_eq!(web.asked_hexdb(), 2, "the adsbdb row was not overwritten");
    }

    #[test]
    fn operators_are_parsed_from_both_sources() {
        let a = parse_aircraft("3C6444", 200, AIRCRAFT_200, NOW).unwrap();
        assert_eq!(a.operator_icao.as_deref(), Some("DLH"));
        let h = parse_hexdb_aircraft("4CA87C", 200, HEXDB_AIRCRAFT_200, NOW).unwrap();
        assert_eq!(h.operator_icao.as_deref(), Some("RYR"));
    }

    #[test]
    fn adsbdb_midpoint_is_a_stop() {
        let r = parse_route("QFA9", 200, ADSBDB_QFA9_MIDPOINT, NOW).unwrap();
        assert_eq!(r.origin.unwrap().icao, "YMML");
        assert_eq!(r.stops.len(), 1);
        assert_eq!(r.stops[0].icao, "WSSS");
        assert_eq!(r.stops[0].latitude, Some(1.35019));
        assert_eq!(r.destination.unwrap().icao, "EGLL");
        assert!(
            parse_route("DLH400", 200, ROUTE_200, NOW)
                .unwrap()
                .stops
                .is_empty()
        );
    }

    #[test]
    fn hexdb_route_keeps_every_stop_and_its_date() {
        let r = parse_hexdb_route("QFA1", 200, HEXDB_QFA1, NOW).unwrap();
        assert_eq!(r.origin.unwrap().icao, "YSSY");
        assert_eq!(r.destination.unwrap().icao, "EGLL");
        let stops: Vec<&str> = r.stops.iter().map(|a| a.icao.as_str()).collect();
        assert_eq!(stops, ["WSSS"]);
        assert_eq!(r.stops[0].name.as_deref(), Some("Singapore Changi Airport"));
        assert_eq!(r.updated_at.as_deref(), Some("2026-08-30T17:07:13Z"));
        // Two airports: no stop.
        assert!(
            parse_hexdb_route("EZY12AB", 200, HEXDB_ROUTE_200, NOW)
                .unwrap()
                .stops
                .is_empty()
        );
    }

    #[tokio::test]
    async fn unknown_to_both_route_sources_is_cached_as_both_asked() {
        let storage = shared();
        let web = FakeWeb::default();
        lookup(&storage, "3C6444", Some("ZZZ9999"), NOW, web.fetch()).await;
        let n = web.asked().len();
        let info = lookup(&storage, "3C6444", Some("ZZZ9999"), NOW + 1, web.fetch()).await;
        assert!(!info.route.unwrap().found);
        assert_eq!(
            web.asked().len(),
            n,
            "hexdb and adsbdb both said unknown today"
        );
    }

    #[tokio::test]
    async fn airports_without_coordinates_are_filled_and_cached() {
        let storage = shared();
        let web = FakeWeb::default();
        let info = lookup(&storage, "3C6444", Some("BAW15X"), NOW, web.fetch()).await;
        let r = info.route.unwrap();
        let egll = r.origin.unwrap();
        assert_eq!(egll.name.as_deref(), Some("London Heathrow Airport"));
        assert_eq!(egll.latitude, Some(51.4775));
        assert_eq!(
            web.asked()
                .iter()
                .filter(|u| u.contains("/api/v2/airports/"))
                .count(),
            1,
            "only the airport without coordinates is looked up"
        );

        // Another route through EGLL: from the airports cache. ZZZZ is unknown
        // to hexdb: it keeps its code, and that is not an error.
        let info = lookup(&storage, "3C6444", Some("BAW16X"), NOW + 1, web.fetch()).await;
        assert_eq!(info.error, None);
        let r = info.route.unwrap();
        assert_eq!(r.origin.unwrap().latitude, Some(51.4775));
        let zzzz = r.destination.unwrap();
        assert_eq!((zzzz.icao.as_str(), zzzz.latitude), ("ZZZZ", None));
        let airport_asks: Vec<String> = web
            .asked()
            .into_iter()
            .filter(|u| u.contains("/api/v2/airports/"))
            .collect();
        assert_eq!(
            airport_asks,
            [
                format!("{HEXDB_BASE}/api/v2/airports/EGLL"),
                format!("{HEXDB_BASE}/api/v2/airports/ZZZZ")
            ]
        );
    }

    #[tokio::test]
    async fn route_without_airline_borrows_the_operator() {
        let storage = shared();
        let web = FakeWeb::default();
        let info = lookup(&storage, "4CA87C", Some("RYR12AB"), NOW, web.fetch()).await;
        let r = info.route.unwrap();
        assert_eq!(r.airline_name.as_deref(), Some("Ryanair"));
        assert_eq!(r.airline_icao.as_deref(), Some("RYR"));
        // Derived per lookup, never stored on the route.
        let guard = storage.try_read().unwrap();
        let stored = guard
            .as_ref()
            .unwrap()
            .get_flight_route_sync("RYR12AB")
            .unwrap()
            .unwrap();
        assert_eq!(stored.airline_name, None);
    }

    #[tokio::test]
    async fn operator_is_not_borrowed_for_another_airlines_callsign() {
        let web = FakeWeb::default();
        let info = lookup(&shared(), "4CA87C", Some("EZY12AB"), NOW, web.fetch()).await;
        assert_eq!(
            info.route.unwrap().airline_name,
            None,
            "RYR airframe, EZY flight"
        );
    }

    #[tokio::test]
    async fn sources_name_every_source_asked() {
        let cases: [(&str, Option<&str>, &[&str]); 6] = [
            ("3C6444", None, &["adsbdb"]), // adsbdb knew the airframe
            ("3C6444", Some("QFA1"), &["adsbdb", "hexdb"]), // + hexdb knew the route
            ("4CA87C", None, &["adsbdb", "hexdb"]), // airframe from hexdb
            ("000000", Some("DLH400"), &["adsbdb", "hexdb"]), // route via adsbdb
            ("000000", Some("ZZZ9999"), &["adsbdb", "hexdb"]), // nobody knew
            ("3C6444", Some("EZY12AB"), &["adsbdb", "hexdb"]),
        ];
        for (hex, cs, want) in cases {
            let storage = shared();
            let web = FakeWeb::default();
            let info = lookup(&storage, hex, cs, NOW, web.fetch()).await;
            assert_eq!(info.sources, want, "{hex} {cs:?}");
            let cached = lookup(&storage, hex, cs, NOW + 1, web.fetch()).await;
            assert_eq!(cached.source, InfoSource::Cache);
            assert_eq!(cached.sources, want, "from the cache: {hex} {cs:?}");
        }
    }

    #[tokio::test]
    async fn route_known_to_hexdb_alone_names_hexdb() {
        let web = FakeWeb::default();
        let info = lookup(&shared(), "000000", Some("EZY12AB"), NOW, web.fetch()).await;
        // Airframe unknown to both; route answered by hexdb first.
        assert_eq!(info.sources, ["adsbdb", "hexdb"]);
        let storage = shared();
        {
            let guard = storage.try_read().unwrap();
            let s = guard.as_ref().unwrap();
            let a = parse_aircraft("3C6444", 200, AIRCRAFT_200, NOW).unwrap();
            s.upsert_aircraft_info_sync(&a).unwrap();
        }
        let info = lookup(&storage, "3C6444", Some("EZY12AB"), NOW, web.fetch()).await;
        assert_eq!(info.sources, ["adsbdb", "hexdb"]);
        let only_route = lookup(&shared(), "nope", Some("EZY12AB"), NOW, web.fetch()).await;
        assert!(only_route.sources.is_empty(), "invalid hex: nothing asked");
    }

    #[test]
    fn sources_behind_a_row() {
        assert_eq!(
            sources_behind(AIRFRAME_SOURCES, true, Some("adsbdb")),
            ["adsbdb"]
        );
        assert_eq!(
            sources_behind(AIRFRAME_SOURCES, true, Some("hexdb")),
            ["adsbdb", "hexdb"]
        );
        assert_eq!(
            sources_behind(AIRFRAME_SOURCES, false, Some("hexdb")),
            ["adsbdb", "hexdb"]
        );
        assert_eq!(
            sources_behind(ROUTE_SOURCES, true, Some("hexdb")),
            ["hexdb"]
        );
        assert_eq!(
            sources_behind(ROUTE_SOURCES, true, Some("adsbdb")),
            ["hexdb", "adsbdb"]
        );
        // Rows from before hexdb: adsbdb alone.
        assert_eq!(sources_behind(ROUTE_SOURCES, true, None), ["adsbdb"]);
        assert_eq!(sources_behind(AIRFRAME_SOURCES, false, None), ["adsbdb"]);
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
            position_timestamp: None,
            position_time_ms: None,
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
        assert_eq!(web.asked().len(), 3);
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
