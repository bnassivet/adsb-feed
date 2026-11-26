//! A thin client for the OpenSky service's control API: what the desktop
//! uses. Commands return what the service accepted; what it then does is
//! observed on the status topic.

use crate::api::{
    ApiError, CREDITS_PATH, CreditsReport, ENABLED_PATH, EnabledSetting, STATUS_PATH,
    WatchAccepted, WatchRequest, track_path, watch_path,
};
use crate::states::OpenSkyTrack;
use crate::status::OpenSkyStatus;
use serde::de::DeserializeOwned;
use std::time::Duration;

/// Per-request timeout for commands and status. A track waits on OpenSky
/// itself, so it gets [`TRACK_TIMEOUT`].
pub const TIMEOUT: Duration = Duration::from_secs(5);
pub const TRACK_TIMEOUT: Duration = Duration::from_secs(40);

/// Why a call to the control API failed.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error(
        "OpenSky service at {url} is unreachable: {message}. Is it running ([opensky] \
         enabled), with its control API on (http_port) and bound where this machine can \
         reach it (http_bind)?"
    )]
    Unreachable { url: String, message: String },
    #[error("OpenSky service at {url} answered HTTP {status}{}", suffix(.error))]
    Status {
        url: String,
        status: u16,
        error: Option<String>,
    },
    #[error("unexpected reply from the OpenSky service at {url}: {message}")]
    Decode { url: String, message: String },
}

impl ClientError {
    /// The HTTP status, when the service answered.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(*status),
            _ => None,
        }
    }
}

fn suffix(error: &Option<String>) -> String {
    error
        .as_deref()
        .map(|e| format!(": {e}"))
        .unwrap_or_default()
}

/// A client for one OpenSky service.
#[derive(Debug, Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    base_url: String,
}

impl ApiClient {
    /// A client for the service at `base_url`, e.g. `http://127.0.0.1:8791`.
    pub fn new(base_url: impl Into<String>) -> Result<Self, ClientError> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| unreachable(&base_url, &e))?;
        Ok(Self { http, base_url })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn status(&self) -> Result<OpenSkyStatus, ClientError> {
        let url = format!("{}{STATUS_PATH}", self.base_url);
        let bytes = self
            .send(self.http.get(&url).timeout(TIMEOUT), &url)
            .await?;
        OpenSkyStatus::from_json(&bytes).map_err(|e| decode(&url, e))
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<(), ClientError> {
        let url = format!("{}{ENABLED_PATH}", self.base_url);
        let request = self
            .http
            .put(&url)
            .timeout(TIMEOUT)
            .json(&EnabledSetting { enabled });
        self.send(request, &url).await.map(|_| ())
    }

    /// Sets and renews `client_id`'s watch list.
    pub async fn put_watch(
        &self,
        client_id: &str,
        request: &WatchRequest,
    ) -> Result<WatchAccepted, ClientError> {
        let url = format!("{}{}", self.base_url, watch_path(client_id));
        let bytes = self
            .send(self.http.put(&url).timeout(TIMEOUT).json(request), &url)
            .await?;
        parse(&url, &bytes)
    }

    pub async fn delete_watch(&self, client_id: &str) -> Result<(), ClientError> {
        let url = format!("{}{}", self.base_url, watch_path(client_id));
        self.send(self.http.delete(&url).timeout(TIMEOUT), &url)
            .await
            .map(|_| ())
    }

    pub async fn credits(&self) -> Result<CreditsReport, ClientError> {
        let url = format!("{}{CREDITS_PATH}", self.base_url);
        let bytes = self
            .send(self.http.get(&url).timeout(TIMEOUT), &url)
            .await?;
        parse(&url, &bytes)
    }

    /// The flight the aircraft was on at `time` (epoch seconds), or its live
    /// flight for `None`; `Ok(None)` when OpenSky has none (404).
    pub async fn track(
        &self,
        icao24: &str,
        time: Option<i64>,
    ) -> Result<Option<OpenSkyTrack>, ClientError> {
        let mut url = format!("{}{}", self.base_url, track_path(icao24));
        if let Some(t) = time {
            url.push_str(&format!("?time={t}"));
        }
        match self
            .send(self.http.get(&url).timeout(TRACK_TIMEOUT), &url)
            .await
        {
            Ok(bytes) => parse(&url, &bytes).map(Some),
            Err(e) if e.status() == Some(404) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        url: &str,
    ) -> Result<Vec<u8>, ClientError> {
        let response = request.send().await.map_err(|e| unreachable(url, &e))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|e| unreachable(url, &e))?;
        if status.is_success() {
            return Ok(bytes.to_vec());
        }
        Err(ClientError::Status {
            url: url.to_string(),
            status: status.as_u16(),
            error: serde_json::from_slice::<ApiError>(&bytes)
                .ok()
                .map(|e| e.error),
        })
    }
}

fn parse<T: DeserializeOwned>(url: &str, bytes: &[u8]) -> Result<T, ClientError> {
    serde_json::from_slice(bytes).map_err(|e| decode(url, e))
}

fn decode(url: &str, e: impl std::fmt::Display) -> ClientError {
    ClientError::Decode {
        url: url.to_string(),
        message: e.to_string(),
    }
}

fn unreachable(url: &str, err: &dyn std::error::Error) -> ClientError {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    ClientError::Unreachable {
        url: url.to_string(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trailing_slash_is_dropped() {
        assert_eq!(
            ApiClient::new("http://127.0.0.1:8791/").unwrap().base_url(),
            "http://127.0.0.1:8791"
        );
    }

    #[test]
    fn an_unreachable_service_points_at_the_settings() {
        let text = ClientError::Unreachable {
            url: "u".into(),
            message: "connection refused".into(),
        }
        .to_string();
        assert!(text.contains("[opensky] enabled"), "{text}");
        assert!(text.contains("http_bind"), "{text}");
    }

    #[test]
    fn a_status_error_carries_the_reason() {
        let e = ClientError::Status {
            url: "u".into(),
            status: 409,
            error: Some("tracks need OpenSky credentials".into()),
        };
        assert_eq!(e.status(), Some(409));
        assert!(
            e.to_string()
                .ends_with("HTTP 409: tracks need OpenSky credentials")
        );
    }
}
