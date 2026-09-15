//! A thin client for the weather service's control API.
//!
//! What the desktop uses to enable or disable fetching. A successful command
//! returns nothing on purpose: its effect is observed on the status topic. A
//! caller that took the reply for the new status would hold two sources of
//! truth, and the reply only says the setting was accepted.

use crate::api::{ApiError, ENABLED_PATH, EnabledSetting, STATUS_PATH};
use crate::status::WeatherStatus;
use std::time::Duration;

/// Per-request timeout. A command is a few bytes to a nearby host; one that
/// takes longer is a problem to report, not to wait out.
pub const TIMEOUT: Duration = Duration::from_secs(5);

/// Why a call to the control API failed.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error(
        "weather service at {url} is unreachable: {message}. Is it running with its \
         control API enabled (http_port), and bound where this machine can reach it \
         ([weather] http_bind)?"
    )]
    Unreachable { url: String, message: String },
    #[error("weather service at {url} answered HTTP {status}{}", error_suffix(.error))]
    Status {
        url: String,
        status: u16,
        error: Option<String>,
    },
    #[error("unexpected reply from the weather service at {url}: {message}")]
    Decode { url: String, message: String },
}

fn error_suffix(error: &Option<String>) -> String {
    error
        .as_deref()
        .map(|e| format!(": {e}"))
        .unwrap_or_default()
}

/// A client for one weather service.
#[derive(Debug, Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    base_url: String,
}

impl ApiClient {
    /// A client for the service at `base_url`, e.g. `http://pi-roof:8789`.
    pub fn new(base_url: impl Into<String>) -> Result<Self, ClientError> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .map_err(|e| unreachable(&base_url, &e))?;
        Ok(Self { http, base_url })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The service's current status.
    pub async fn status(&self) -> Result<WeatherStatus, ClientError> {
        let url = format!("{}{STATUS_PATH}", self.base_url);
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| unreachable(&url, &e))?;
        let bytes = check(&url, response).await?;
        WeatherStatus::from_json(&bytes).map_err(|e| ClientError::Decode {
            url,
            message: e.to_string(),
        })
    }

    /// Asks the service to enable or disable fetching. Idempotent.
    ///
    /// `Ok` means the setting was accepted and persisted, not that the service
    /// has acted on it: watch the status for that.
    pub async fn set_enabled(&self, enabled: bool) -> Result<(), ClientError> {
        let url = format!("{}{ENABLED_PATH}", self.base_url);
        let body =
            serde_json::to_vec(&EnabledSetting { enabled }).map_err(|e| ClientError::Decode {
                url: url.clone(),
                message: e.to_string(),
            })?;
        let response = self
            .http
            .put(&url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| unreachable(&url, &e))?;
        check(&url, response).await.map(|_| ())
    }
}

/// The body of a successful reply, or the error it describes.
async fn check(url: &str, response: reqwest::Response) -> Result<Vec<u8>, ClientError> {
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

/// An unreachable error carrying the whole cause chain: reqwest's own message
/// ("error sending request") hides "connection refused".
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
    fn a_trailing_slash_is_dropped_from_the_base_url() {
        let client = ApiClient::new("http://pi-roof:8789/").unwrap();
        assert_eq!(client.base_url(), "http://pi-roof:8789");
    }

    #[test]
    fn an_unreachable_service_points_at_the_bind_setting() {
        let err = ClientError::Unreachable {
            url: "http://pi-roof:8789/v1/enabled".into(),
            message: "connection refused".into(),
        };
        let text = err.to_string();
        assert!(text.contains("http://pi-roof:8789"), "{text}");
        assert!(text.contains("http_bind"), "{text}");
    }

    #[test]
    fn a_status_error_carries_the_services_reason() {
        let err = ClientError::Status {
            url: "u".into(),
            status: 500,
            error: Some("state file is read-only".into()),
        };
        assert!(
            err.to_string()
                .ends_with("HTTP 500: state file is read-only")
        );
    }
}
