//! OpenSky credentials and the OAuth2 token they buy.
//!
//! OpenSky accepts only the OAuth2 *client credentials* flow: the API client
//! created on the account page has an id and a secret, which are exchanged at
//! the token endpoint for a bearer token valid 30 minutes. The token is cached
//! and reused until shortly before it expires; a 401 from the API means it
//! went stale early, and [`TokenSource::invalidate`] drops it so the next call
//! fetches a fresh one.
//!
//! The secret is never printed: [`Credentials`]'s `Debug` redacts it.

use serde::Deserialize;
use std::path::Path;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::Instant;

/// OpenSky's token endpoint.
pub const DEFAULT_TOKEN_URL: &str =
    "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

/// A token is replaced this long before OpenSky says it expires, so a request
/// never leaves with one that dies in flight.
pub const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

/// Lifetime assumed when the token endpoint does not say (OpenSky's is 30 min).
pub const DEFAULT_LIFETIME: Duration = Duration::from_secs(1_800);

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// An OpenSky API client's id and secret.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub client_id: String,
    pub client_secret: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .finish()
    }
}

/// Why credentials could not be read.
#[derive(Debug, thiserror::Error)]
pub enum CredentialsError {
    #[error("OpenSky credentials file {path}: {message}")]
    File { path: String, message: String },
    #[error("OpenSky client_id is set but client_secret is not (or the reverse)")]
    Incomplete,
}

/// The `credentials.json` OpenSky's account page downloads, and the
/// snake_case spelling an operator might write by hand.
#[derive(Deserialize)]
struct CredentialsFile {
    #[serde(alias = "client_id", rename = "clientId")]
    client_id: String,
    #[serde(alias = "client_secret", rename = "clientSecret")]
    client_secret: String,
}

impl Credentials {
    /// Reads OpenSky's `credentials.json`.
    pub fn from_file(path: &Path) -> Result<Self, CredentialsError> {
        let err = |message: String| CredentialsError::File {
            path: path.display().to_string(),
            message,
        };
        let bytes = std::fs::read(path).map_err(|e| err(e.to_string()))?;
        let file: CredentialsFile =
            serde_json::from_slice(&bytes).map_err(|e| err(e.to_string()))?;
        Self::from_parts(Some(file.client_id), Some(file.client_secret))
            .and_then(|c| c.ok_or(CredentialsError::Incomplete))
            .map_err(|_| err("clientId and clientSecret must both be non-empty".into()))
    }

    /// Credentials from an id and a secret given separately. Both empty or
    /// absent is anonymous (`Ok(None)`); one without the other is an error,
    /// because silently running anonymous would cut the budget tenfold.
    pub fn from_parts(
        client_id: Option<String>,
        client_secret: Option<String>,
    ) -> Result<Option<Self>, CredentialsError> {
        let id = client_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let secret = client_secret
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match (id, secret) {
            (None, None) => Ok(None),
            (Some(client_id), Some(client_secret)) => Ok(Some(Self {
                client_id,
                client_secret,
            })),
            _ => Err(CredentialsError::Incomplete),
        }
    }
}

/// Why a token could not be obtained.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    /// The endpoint refused the credentials themselves (HTTP 400/401).
    /// Retrying will not help.
    #[error("OpenSky refused the credentials (HTTP {status}): {message}")]
    Rejected { status: u16, message: String },
    /// Anything else: network, timeout, a 5xx. Worth retrying.
    #[error("OpenSky token endpoint unavailable: {0}")]
    Transient(String),
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

struct Cached {
    token: String,
    renew_at: Instant,
}

/// Fetches and caches bearer tokens.
pub struct TokenSource {
    http: reqwest::Client,
    url: String,
    credentials: Credentials,
    cached: Mutex<Option<Cached>>,
}

impl TokenSource {
    pub fn new(url: impl Into<String>, credentials: Credentials) -> Result<Self, AuthError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("adsb-opensky-server/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| AuthError::Transient(e.to_string()))?;
        Ok(Self {
            http,
            url: url.into(),
            credentials,
            cached: Mutex::new(None),
        })
    }

    /// A valid token: the cached one, or a fresh one if it is due.
    pub async fn token(&self) -> Result<String, AuthError> {
        let mut cached = self.cached.lock().await;
        if let Some(c) = cached.as_ref()
            && Instant::now() < c.renew_at
        {
            return Ok(c.token.clone());
        }
        let fresh = self.fetch().await?;
        let token = fresh.token.clone();
        *cached = Some(fresh);
        Ok(token)
    }

    /// Drops the cached token: the API said it is no longer valid.
    pub async fn invalidate(&self) {
        *self.cached.lock().await = None;
    }

    async fn fetch(&self) -> Result<Cached, AuthError> {
        let response = self
            .http
            .post(&self.url)
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.credentials.client_id.as_str()),
                ("client_secret", self.credentials.client_secret.as_str()),
            ])
            .send()
            .await
            .map_err(|e| AuthError::Transient(error_chain(&e)))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|e| AuthError::Transient(error_chain(&e)))?;
        if matches!(status.as_u16(), 400 | 401 | 403) {
            return Err(AuthError::Rejected {
                status: status.as_u16(),
                message: oauth_error(&body),
            });
        }
        if !status.is_success() {
            return Err(AuthError::Transient(format!("HTTP {}", status.as_u16())));
        }
        let reply: TokenReply = serde_json::from_slice(&body)
            .map_err(|e| AuthError::Transient(format!("unexpected token reply: {e}")))?;
        let lifetime = reply
            .expires_in
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_LIFETIME);
        Ok(Cached {
            token: reply.access_token,
            renew_at: Instant::now() + lifetime.saturating_sub(EXPIRY_MARGIN),
        })
    }
}

/// The OAuth2 error in a refusal body, without echoing anything else.
fn oauth_error(body: &[u8]) -> String {
    #[derive(Deserialize)]
    struct OAuthError {
        error: String,
        #[serde(default)]
        error_description: Option<String>,
    }
    match serde_json::from_slice::<OAuthError>(body) {
        Ok(e) => match e.error_description {
            Some(d) => format!("{} ({d})", e.error),
            None => e.error,
        },
        Err(_) => "no reason given".into(),
    }
}

/// An error with its whole cause chain: reqwest's own message ("error sending
/// request") hides "connection refused".
pub fn error_chain(err: &dyn std::error::Error) -> String {
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

    #[test]
    fn debug_never_shows_the_secret() {
        let c = Credentials {
            client_id: "me-api-client".into(),
            client_secret: "s3cr3t".into(),
        };
        let text = format!("{c:?}");
        assert!(text.contains("me-api-client"));
        assert!(!text.contains("s3cr3t"), "{text}");
    }

    #[test]
    fn opensky_s_credentials_file_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.json");
        std::fs::write(&path, r#"{"clientId":"me-api-client","clientSecret":"x"}"#).unwrap();
        let c = Credentials::from_file(&path).unwrap();
        assert_eq!(c.client_id, "me-api-client");
        assert_eq!(c.client_secret, "x");
    }

    #[test]
    fn a_hand_written_snake_case_file_is_read_too() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        std::fs::write(&path, r#"{"client_id":"a","client_secret":"b"}"#).unwrap();
        assert_eq!(Credentials::from_file(&path).unwrap().client_id, "a");
    }

    #[test]
    fn a_file_error_never_quotes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        std::fs::write(&path, r#"{"clientId":"a","clientSecret":""}"#).unwrap();
        let err = Credentials::from_file(&path).unwrap_err().to_string();
        assert!(err.contains("non-empty"), "{err}");
    }

    #[test]
    fn neither_part_is_anonymous_and_one_alone_is_an_error() {
        assert_eq!(
            Credentials::from_parts(None, Some("  ".into())).unwrap(),
            None
        );
        assert!(Credentials::from_parts(Some("id".into()), None).is_err());
        assert!(
            Credentials::from_parts(Some("id".into()), Some("s".into()))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn an_oauth_refusal_reports_only_the_oauth_fields() {
        let body =
            br#"{"error":"invalid_client","error_description":"Invalid client credentials"}"#;
        assert_eq!(
            oauth_error(body),
            "invalid_client (Invalid client credentials)"
        );
        assert_eq!(oauth_error(b"<html>"), "no reason given");
    }
}
