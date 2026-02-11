//! Error types for the ADS-B Pulsar client.
//!
//! This module defines all error types that can occur during client operations.
//! Uses `thiserror` for convenient error derivation and display implementations.
//!
//! # Examples
//!
//! ```rust
//! use adsb_pulsar_client::error::{ClientError, Result};
//!
//! fn do_something() -> Result<()> {
//!     Err(ClientError::Config("Invalid config".into()))
//! }
//!
//! match do_something() {
//!     Ok(_) => println!("Success"),
//!     Err(e) if e.is_recoverable() => println!("Recoverable: {}", e),
//!     Err(e) => println!("Fatal: {}", e),
//! }
//! ```

use thiserror::Error;

/// Result type alias for client operations.
///
/// Convenience alias that defaults to [`ClientError`] as the error type.
pub type Result<T> = std::result::Result<T, ClientError>;

/// Errors that can occur during client operations.
///
/// Most errors are recoverable through retry logic, but some
/// (like configuration errors) are fatal.
#[derive(Error, Debug)]
pub enum ClientError {
    /// Socket connection error
    #[error("Socket error: {0}")]
    Socket(#[from] std::io::Error),

    /// Pulsar connection or send error
    #[error("Pulsar error: {0}")]
    Pulsar(#[from] pulsar::Error),

    /// Configuration validation error
    #[error("Configuration error: {0}")]
    Config(String),

    /// Message buffer overflow
    #[error("Buffer overflow: {current} bytes exceeds limit {limit}")]
    BufferOverflow { current: usize, limit: usize },

    /// Retry queue full
    #[error("Retry queue full: {0} messages")]
    RetryQueueFull(usize),

    /// Shutdown signal received
    #[error("Shutdown requested")]
    Shutdown,

    /// Generic error
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for ClientError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl ClientError {
    /// Checks if the error is recoverable.
    ///
    /// Recoverable errors can typically be resolved through:
    /// - Reconnection (Socket, Pulsar errors)
    /// - Retry logic
    /// - Waiting for external service recovery
    ///
    /// # Returns
    ///
    /// * `true` - Error is recoverable
    /// * `false` - Error is fatal (e.g., Config errors)
    ///
    /// # Examples
    ///
    /// ```rust
    /// # use adsb_pulsar_client::error::ClientError;
    /// let error = ClientError::Config("Invalid".into());
    /// assert!(!error.is_recoverable());
    ///
    /// let error = ClientError::Socket(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
    /// assert!(error.is_recoverable());
    /// ```
    pub fn is_recoverable(&self) -> bool {
        matches!(
            self,
            ClientError::Socket(_) | ClientError::Pulsar(_)
        )
    }

    /// Checks if the error should trigger a retry.
    ///
    /// Similar to [`is_recoverable`](Self::is_recoverable) but also includes
    /// errors that benefit from retry logic like queue full conditions.
    ///
    /// # Returns
    ///
    /// * `true` - Should retry the operation
    /// * `false` - Should not retry (fatal or non-retriable)
    pub fn should_retry(&self) -> bool {
        matches!(
            self,
            ClientError::Socket(_) | ClientError::Pulsar(_) | ClientError::RetryQueueFull(_)
        )
    }
}
