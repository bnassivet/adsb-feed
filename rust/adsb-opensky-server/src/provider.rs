//! OpenSky's REST API: the calls this service makes, behind a trait.
//!
//! [`HttpProvider`] is the real one. The trait is the seam that lets the poller
//! be tested with a fake, without a network or a clock.
//!
//! Every reply carries OpenSky's `X-Rate-Limit-Remaining`, when it sent one:
//! that is the account's own count, which the scheduler trusts over ours when
//! it is lower.

use crate::api::Area;
use crate::auth::{AuthError, TokenSource, error_chain};
use crate::states::{self, OpenSkyTrack, StatesResponse};
use std::time::Duration;

/// OpenSky's REST base.
pub const DEFAULT_API_URL: &str = "https://opensky-network.org/api";

/// Per-request timeout. OpenSky can be slow under load; past this the poll is
/// a failure to back off from, not something to wait out.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A `Retry-After` longer than this is treated as this: a misread header must
/// not park the service for a year.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(24 * 3_600);

/// A successful reply and OpenSky's remaining-credit count.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply<T> {
    pub value: T,
    pub remaining: Option<i64>,
}

/// Why a call failed, sorted by what to do about it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    /// The credentials were refused. Retrying is pointless until they change.
    #[error("OpenSky refused the credentials: {0}")]
    Unauthorized(String),
    /// Out of credits (HTTP 429). Wait `retry_after` if OpenSky said.
    #[error("OpenSky rate limit reached{}", retry_suffix(.retry_after))]
    RateLimited { retry_after: Option<Duration> },
    /// Nothing there (a track for an aircraft not flying).
    #[error("not found at OpenSky")]
    NotFound,
    /// OpenSky refused the request itself (a 4xx other than the above).
    #[error("OpenSky refused the request (HTTP {status})")]
    Rejected { status: u16 },
    /// Network, timeout, 5xx, an unreadable body. Worth retrying.
    #[error("OpenSky unavailable: {0}")]
    Transient(String),
}

fn retry_suffix(retry_after: &Option<Duration>) -> String {
    retry_after
        .map(|d| format!("; retry in {} s", d.as_secs()))
        .unwrap_or_default()
}

impl From<AuthError> for ProviderError {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::Rejected { .. } => Self::Unauthorized(e.to_string()),
            AuthError::Transient(m) => Self::Transient(m),
        }
    }
}

/// What the poller and the track endpoint call.
#[async_trait::async_trait]
pub trait OpenSkyProvider: Send + Sync {
    /// Whether calls are authenticated. Anonymous access gets a tenth of the
    /// credits and no tracks.
    fn authenticated(&self) -> bool;

    /// Current states of the named aircraft (lowercase hex), in one call.
    async fn states_by_icao(
        &self,
        icao24: &[String],
    ) -> Result<Reply<StatesResponse>, ProviderError>;

    /// Current states inside `area`.
    async fn states_in_area(&self, area: &Area) -> Result<Reply<StatesResponse>, ProviderError>;

    /// The flight the aircraft was on at `time` (epoch seconds), or its live
    /// flight for `None` (`time=0`).
    async fn track(
        &self,
        icao24: &str,
        time: Option<i64>,
    ) -> Result<Reply<OpenSkyTrack>, ProviderError>;
}

/// OpenSky over HTTPS.
pub struct HttpProvider {
    http: reqwest::Client,
    base_url: String,
    auth: Option<TokenSource>,
}

impl HttpProvider {
    /// A provider for `base_url` (normally [`DEFAULT_API_URL`]); anonymous
    /// when `auth` is `None`.
    pub fn new(
        base_url: impl Into<String>,
        auth: Option<TokenSource>,
    ) -> Result<Self, ProviderError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("adsb-opensky-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| ProviderError::Transient(error_chain(&e)))?;
        Ok(Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            auth,
        })
    }

    /// One GET, with the bearer token when authenticated. A 401 with a cached
    /// token is retried once with a fresh one: tokens can go stale early.
    async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<(Vec<u8>, Option<i64>), ProviderError> {
        let url = format!("{}{path}", self.base_url);
        for attempt in 0..2 {
            let mut request = self.http.get(&url).query(query);
            if let Some(auth) = &self.auth {
                request = request.bearer_auth(auth.token().await?);
            }
            let response = request
                .send()
                .await
                .map_err(|e| ProviderError::Transient(error_chain(&e)))?;
            let status = response.status().as_u16();
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<i64>().ok())
            };
            let remaining = header("x-rate-limit-remaining");
            let retry_after = header("x-rate-limit-retry-after-seconds")
                .map(|s| Duration::from_secs(s.max(0) as u64).min(MAX_RETRY_AFTER));

            if status == 401 {
                if let Some(auth) = &self.auth {
                    auth.invalidate().await;
                    if attempt == 0 {
                        continue;
                    }
                }
                return Err(ProviderError::Unauthorized(format!("HTTP {status}")));
            }
            let body = response
                .bytes()
                .await
                .map_err(|e| ProviderError::Transient(error_chain(&e)))?;
            return match status {
                200..=299 => Ok((body.to_vec(), remaining)),
                403 => Err(ProviderError::Unauthorized(format!("HTTP {status}"))),
                404 => Err(ProviderError::NotFound),
                429 => Err(ProviderError::RateLimited { retry_after }),
                400..=499 => Err(ProviderError::Rejected { status }),
                _ => Err(ProviderError::Transient(format!("HTTP {status}"))),
            };
        }
        unreachable!("the second attempt always returns")
    }

    async fn states(
        &self,
        query: &[(&str, String)],
    ) -> Result<Reply<StatesResponse>, ProviderError> {
        let (body, remaining) = self.get("/states/all", query).await?;
        let value =
            states::parse_states(&body).map_err(|e| ProviderError::Transient(e.to_string()))?;
        Ok(Reply { value, remaining })
    }
}

#[async_trait::async_trait]
impl OpenSkyProvider for HttpProvider {
    fn authenticated(&self) -> bool {
        self.auth.is_some()
    }

    async fn states_by_icao(
        &self,
        icao24: &[String],
    ) -> Result<Reply<StatesResponse>, ProviderError> {
        // OpenSky takes the parameter repeated, one per aircraft.
        let query: Vec<(&str, String)> = icao24.iter().map(|h| ("icao24", h.clone())).collect();
        self.states(&query).await
    }

    async fn states_in_area(&self, area: &Area) -> Result<Reply<StatesResponse>, ProviderError> {
        self.states(&[
            ("lamin", area.south.to_string()),
            ("lomin", area.west.to_string()),
            ("lamax", area.north.to_string()),
            ("lomax", area.east.to_string()),
        ])
        .await
    }

    async fn track(
        &self,
        icao24: &str,
        time: Option<i64>,
    ) -> Result<Reply<OpenSkyTrack>, ProviderError> {
        let time = time.unwrap_or(0).to_string();
        let (body, remaining) = self
            .get(
                "/tracks/all",
                &[("icao24", icao24.to_string()), ("time", time)],
            )
            .await?;
        // OpenSky answers an unknown flight with 404, but also, at times,
        // with an empty body.
        if body.iter().all(u8::is_ascii_whitespace) {
            return Err(ProviderError::NotFound);
        }
        let value =
            states::parse_track(&body).map_err(|e| ProviderError::Transient(e.to_string()))?;
        Ok(Reply { value, remaining })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rejected_token_is_unauthorized_and_a_failed_one_transient() {
        let rejected: ProviderError = AuthError::Rejected {
            status: 401,
            message: "invalid_client".into(),
        }
        .into();
        assert!(matches!(rejected, ProviderError::Unauthorized(_)));
        let down: ProviderError = AuthError::Transient("timeout".into()).into();
        assert!(matches!(down, ProviderError::Transient(_)));
    }

    #[test]
    fn a_rate_limit_says_when_to_retry() {
        let e = ProviderError::RateLimited {
            retry_after: Some(Duration::from_secs(90)),
        };
        assert!(e.to_string().ends_with("retry in 90 s"), "{e}");
    }
}
