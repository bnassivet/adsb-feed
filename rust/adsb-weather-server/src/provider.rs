//! Weather providers: where a snapshot comes from.
//!
//! One implementation today ([`OpenMeteoProvider`]). The trait is the seam that
//! lets the refresh loop be tested with a fake, and a second source (an offline
//! GRIB reader, say) be added without touching the loop or the publisher.

use crate::budget::{self, TokenBucket};
use crate::grid::GridSpec;
use crate::open_meteo::{self, LocationResponse, OpenMeteoError};
use crate::snapshot::WeatherSnapshot;
use crate::status::RateLimitScope;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tracing::debug;

const HOUR_MS: i64 = 3_600_000;

/// The model hour a fetch at `now_ms` asks for: the nearest one, the same
/// rule [`open_meteo::select_hour`] applies to the response.
fn nearest_hour(now_ms: i64) -> i64 {
    (now_ms + HOUR_MS / 2).div_euclid(HOUR_MS)
}

/// Chunks that a fetch which failed part-way had already paid for.
///
/// Keyed by request URL, which encodes the coordinates, the variables and the
/// model, and valid for one model hour: a retry in a later hour wants newer
/// data, so it fetches everything again.
#[derive(Debug, Default)]
struct PartialFetch {
    hour: i64,
    chunks: HashMap<String, Vec<LocationResponse>>,
}

impl PartialFetch {
    fn get(&self, hour: i64, url: &str) -> Option<Vec<LocationResponse>> {
        if self.hour == hour {
            self.chunks.get(url).cloned()
        } else {
            None
        }
    }

    fn insert(&mut self, hour: i64, url: &str, locations: Vec<LocationResponse>) {
        if self.hour != hour {
            self.chunks.clear();
            self.hour = hour;
        }
        self.chunks.insert(url.to_string(), locations);
    }

    fn clear(&mut self) {
        self.chunks.clear();
    }
}

/// Per-request timeout. A grid is a handful of requests; one that hangs must
/// fail the refresh rather than stall it until the next hour.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Longest `Retry-After` honoured. Past a day it is more likely a
/// misconfigured proxy than advice, and the daily window has rolled over.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(24 * 3600);

/// Why a fetch failed.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("request to {base_url} failed: {message}")]
    Http { base_url: String, message: String },
    #[error("{base_url} answered HTTP {status}{}", reason_suffix(.reason))]
    Status {
        base_url: String,
        status: u16,
        /// The API's own explanation, when the body carried one.
        reason: Option<String>,
        /// The server's `Retry-After`, in its delta-seconds form.
        retry_after: Option<Duration>,
    },
    #[error(transparent)]
    Decode(#[from] OpenMeteoError),
}

fn reason_suffix(reason: &Option<String>) -> String {
    reason
        .as_deref()
        .map(|r| format!(": {r}"))
        .unwrap_or_default()
}

/// What a failure means for when to ask again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// Network, timeout, 408, 5xx, or a body that is not the API's own: the
    /// next attempt may well work, so retry soon and back off.
    Transient,
    /// 429: the quota for `scope` is spent, and asking before that window
    /// rolls over only gets refused again.
    RateLimited {
        scope: RateLimitScope,
        retry_after: Option<Duration>,
    },
    /// The API refused the request itself (a bad model, a bad coordinate).
    /// The configuration is read once, so asking again cannot fix it.
    Rejected,
}

impl ProviderError {
    /// Classifies the failure by the HTTP status first and the body second:
    /// Open-Meteo sends the same `{"error", "reason"}` body with a 400 and a
    /// 429, and only the status says whether retrying can help.
    pub fn class(&self) -> ErrorClass {
        match self {
            Self::Http { .. } => ErrorClass::Transient,
            Self::Status {
                status: 429,
                reason,
                retry_after,
                ..
            } => ErrorClass::RateLimited {
                scope: reason
                    .as_deref()
                    .map_or(RateLimitScope::Unknown, open_meteo::rate_limit_scope),
                retry_after: *retry_after,
            },
            Self::Status { status: 408, .. } => ErrorClass::Transient,
            Self::Status { status, .. } if (400..500).contains(status) => ErrorClass::Rejected,
            Self::Status { .. } => ErrorClass::Transient,
            Self::Decode(OpenMeteoError::Api(_)) => ErrorClass::Rejected,
            Self::Decode(_) => ErrorClass::Transient,
        }
    }

    /// Whether the provider asked us to slow down.
    pub fn is_rate_limited(&self) -> bool {
        matches!(self.class(), ErrorClass::RateLimited { .. })
    }
}

/// Parses a `Retry-After` header in its delta-seconds form, capped at
/// [`MAX_RETRY_AFTER`]. The HTTP-date form is legal but rare, and returns
/// `None`: the rate-limit scope still decides the wait.
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    let seconds: u64 = value.trim().parse().ok()?;
    Some(Duration::from_secs(seconds).min(MAX_RETRY_AFTER))
}

/// A source of weather snapshots.
#[async_trait::async_trait]
pub trait WeatherProvider: Send + Sync {
    /// Short identifier for logs.
    fn name(&self) -> &str;

    /// Fetches the snapshot for `grid` at the model hour nearest `now_ms`.
    async fn fetch(
        &self,
        grid: GridSpec,
        levels: &[u16],
        now_ms: i64,
    ) -> Result<WeatherSnapshot, ProviderError>;
}

/// Open-Meteo over HTTPS.
pub struct OpenMeteoProvider {
    client: reqwest::Client,
    base_url: String,
    model: String,
    chunk: usize,
    /// Spreads requests across the per-minute limit. Lives for the provider's
    /// whole life: successive refreshes and retries share the same minutes.
    pacer: Mutex<TokenBucket>,
    started: tokio::time::Instant,
    partial: Mutex<PartialFetch>,
}

impl OpenMeteoProvider {
    /// Creates a provider for `base_url` (normally
    /// [`open_meteo::DEFAULT_BASE_URL`]) requesting `model`.
    pub fn new(
        base_url: impl Into<String>,
        model: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        let base_url = base_url.into();
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("adsb-weather-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| ProviderError::Http {
                base_url: base_url.clone(),
                message: error_chain(&e),
            })?;
        Ok(Self {
            client,
            base_url,
            model: model.into(),
            chunk: open_meteo::MAX_LOCATIONS_PER_REQUEST,
            pacer: Mutex::new(TokenBucket::open_meteo_minutely()),
            started: tokio::time::Instant::now(),
            partial: Mutex::default(),
        })
    }

    /// Never held across an await.
    fn partial(&self) -> MutexGuard<'_, PartialFetch> {
        self.partial.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Overrides the number of locations per request.
    pub fn with_chunk(mut self, chunk: usize) -> Self {
        self.chunk = chunk.max(1);
        self
    }

    /// Overrides the request pacer.
    pub fn with_pacer(mut self, pacer: TokenBucket) -> Self {
        self.pacer = Mutex::new(pacer);
        self
    }

    /// Waits until `calls` fit the per-minute allowance, and charges them.
    ///
    /// The charge stands even if the fetch is cancelled while waiting: that
    /// errs towards spending less of the quota, never more.
    async fn pace(&self, calls: f64) {
        let wait = {
            let mut pacer = self.pacer.lock().unwrap_or_else(|e| e.into_inner());
            pacer.reserve(calls, self.started.elapsed())
        };
        if !wait.is_zero() {
            debug!(
                "Pacing Open-Meteo requests: waiting {} ms for {calls:.0} calls",
                wait.as_millis()
            );
            tokio::time::sleep(wait).await;
        }
    }

    /// One request, decoded into its locations.
    async fn get(&self, url: &str) -> Result<Vec<LocationResponse>, ProviderError> {
        let http_error = |e: reqwest::Error| ProviderError::Http {
            base_url: self.base_url.clone(),
            message: error_chain(&e),
        };

        let response = self.client.get(url).send().await.map_err(http_error)?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after);
        let body = response.bytes().await.map_err(http_error)?;

        if !status.is_success() {
            // Open-Meteo explains a refusal in the body, 400 and 429 alike.
            // Keep the reason, but never in place of the status: turning a 429
            // into a plain rejection once hid every rate limit from the retry
            // logic.
            let reason = match open_meteo::parse_body(&body) {
                Err(OpenMeteoError::Api(reason)) => Some(reason),
                _ => None,
            };
            return Err(ProviderError::Status {
                base_url: self.base_url.clone(),
                status: status.as_u16(),
                reason,
                retry_after,
            });
        }

        Ok(open_meteo::parse_body(&body)?)
    }
}

#[async_trait::async_trait]
impl WeatherProvider for OpenMeteoProvider {
    fn name(&self) -> &str {
        open_meteo::SOURCE
    }

    async fn fetch(
        &self,
        grid: GridSpec,
        levels: &[u16],
        now_ms: i64,
    ) -> Result<WeatherSnapshot, ProviderError> {
        let points = grid.points();
        let urls = open_meteo::build_urls(&self.base_url, &self.model, levels, &points, self.chunk);

        // Sequential on purpose: the per-minute limit is shared by every
        // location in every request, and a few requests an hour gain nothing
        // from concurrency but a 429. Each chunk is paced by what it costs.
        let calls_per_location = budget::call_weight(budget::variables_per_location(levels.len()));
        let hour = nearest_hour(now_ms);
        let mut locations = Vec::with_capacity(points.len());
        for (chunk, url) in points.chunks(self.chunk).zip(&urls) {
            // A retry within the same model hour reuses what an attempt that
            // failed part-way already paid for, instead of buying it again.
            let held = self.partial().get(hour, url);
            if let Some(held) = held {
                locations.extend(held);
                continue;
            }
            self.pace(chunk.len() as f64 * calls_per_location).await;
            let fetched = self.get(url).await?;
            self.partial().insert(hour, url, fetched.clone());
            locations.extend(fetched);
        }
        // Every chunk is in hand: nothing is left to resume.
        self.partial().clear();

        Ok(open_meteo::assemble_snapshot(
            grid,
            levels,
            &self.model,
            &locations,
            now_ms,
            now_ms,
        )?)
    }
}

/// Renders an error with its whole `source()` chain.
///
/// `reqwest::Error` displays only its outermost layer ("error sending request
/// for url"), which hides what an operator needs: connection refused, a DNS
/// failure, a certificate problem.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(status: u16, reason: Option<&str>) -> ProviderError {
        ProviderError::Status {
            base_url: "fake".into(),
            status,
            reason: reason.map(String::from),
            retry_after: None,
        }
    }

    fn location(first_hour_s: i64) -> Vec<LocationResponse> {
        vec![LocationResponse {
            hourly: open_meteo::Hourly {
                time: vec![first_hour_s],
                series: HashMap::new(),
            },
        }]
    }

    #[test]
    fn a_fetch_asks_for_the_nearest_hour() {
        let noon = 12 * HOUR_MS;
        assert_eq!(nearest_hour(noon + 29 * 60_000), 12);
        assert_eq!(nearest_hour(noon + 31 * 60_000), 13);
    }

    #[test]
    fn a_chunk_is_reused_within_the_same_hour() {
        let mut partial = PartialFetch::default();
        partial.insert(12, "a", location(7));
        let held = partial.get(12, "a").expect("held");
        assert_eq!(held[0].hourly.time, vec![7]);
        assert!(partial.get(12, "b").is_none());
    }

    #[test]
    fn a_chunk_from_another_hour_is_not_reused() {
        let mut partial = PartialFetch::default();
        partial.insert(12, "a", location(7));
        assert!(partial.get(13, "a").is_none());
    }

    #[test]
    fn a_new_hour_discards_the_old_chunks() {
        let mut partial = PartialFetch::default();
        partial.insert(12, "a", location(7));
        partial.insert(13, "b", location(8));
        assert!(partial.get(13, "a").is_none());
        assert!(partial.get(13, "b").is_some());
    }

    #[test]
    fn retry_after_in_seconds_is_parsed() {
        assert_eq!(parse_retry_after("120"), Some(Duration::from_secs(120)));
        assert_eq!(parse_retry_after(" 5 "), Some(Duration::from_secs(5)));
    }

    #[test]
    fn a_retry_after_date_or_garbage_is_ignored() {
        // The HTTP-date form is legal but rare; the scope rules cover it.
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after("soon"), None);
        assert_eq!(parse_retry_after("-3"), None);
    }

    #[test]
    fn an_absurd_retry_after_is_capped_at_a_day() {
        assert_eq!(parse_retry_after("99999999"), Some(MAX_RETRY_AFTER));
    }

    #[test]
    fn a_429_is_rate_limited_with_the_scope_its_reason_names() {
        assert_eq!(
            status(429, Some("Hourly API request limit exceeded.")).class(),
            ErrorClass::RateLimited {
                scope: RateLimitScope::Hourly,
                retry_after: None
            }
        );
    }

    #[test]
    fn timeouts_and_server_errors_are_transient() {
        for code in [408, 500, 502, 503, 504] {
            assert_eq!(status(code, None).class(), ErrorClass::Transient, "{code}");
        }
    }

    #[test]
    fn other_client_errors_are_rejected() {
        for code in [400, 401, 403, 404] {
            assert_eq!(status(code, None).class(), ErrorClass::Rejected, "{code}");
        }
    }

    #[test]
    fn a_rejection_inside_a_success_body_is_rejected() {
        let err = ProviderError::Decode(OpenMeteoError::Api("bad model".into()));
        assert_eq!(err.class(), ErrorClass::Rejected);
    }

    #[test]
    fn a_malformed_body_is_transient() {
        // A captive portal or a truncated proxy page, not the API refusing us.
        let json = serde_json::from_slice::<serde_json::Value>(b"<html>").unwrap_err();
        let err = ProviderError::Decode(OpenMeteoError::Json(json));
        assert_eq!(err.class(), ErrorClass::Transient);
    }
}
