//! Weather providers: where a snapshot comes from.
//!
//! One implementation today ([`OpenMeteoProvider`]). The trait is the seam that
//! lets the refresh loop be tested with a fake, and a second source (an offline
//! GRIB reader, say) be added without touching the loop or the publisher.

use crate::grid::GridSpec;
use crate::open_meteo::{self, LocationResponse, OpenMeteoError};
use crate::snapshot::WeatherSnapshot;
use std::time::Duration;

/// Per-request timeout. A grid is a handful of requests; one that hangs must
/// fail the refresh rather than stall it until the next hour.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a fetch failed.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("request to {base_url} failed: {message}")]
    Http { base_url: String, message: String },
    #[error("{base_url} answered HTTP {status}")]
    Status { base_url: String, status: u16 },
    #[error(transparent)]
    Decode(#[from] OpenMeteoError),
}

impl ProviderError {
    /// Whether the provider asked us to slow down. The refresh loop waits far
    /// longer after this than after a transient network error.
    pub fn is_rate_limited(&self) -> bool {
        matches!(self, Self::Status { status: 429, .. })
    }
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
        })
    }

    /// Overrides the number of locations per request.
    pub fn with_chunk(mut self, chunk: usize) -> Self {
        self.chunk = chunk.max(1);
        self
    }

    /// One request, decoded into its locations.
    async fn get(&self, url: &str) -> Result<Vec<LocationResponse>, ProviderError> {
        let http_error = |e: reqwest::Error| ProviderError::Http {
            base_url: self.base_url.clone(),
            message: error_chain(&e),
        };

        let response = self.client.get(url).send().await.map_err(http_error)?;
        let status = response.status();
        let body = response.bytes().await.map_err(http_error)?;

        if !status.is_success() {
            // Open-Meteo explains a rejected request in the body. Keep that
            // reason when there is one; fall back to the bare status.
            if let Err(OpenMeteoError::Api(reason)) = open_meteo::parse_body(&body) {
                return Err(OpenMeteoError::Api(reason).into());
            }
            return Err(ProviderError::Status {
                base_url: self.base_url.clone(),
                status: status.as_u16(),
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
        // from concurrency but a 429.
        let mut locations = Vec::with_capacity(points.len());
        for url in &urls {
            locations.extend(self.get(url).await?);
        }

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
