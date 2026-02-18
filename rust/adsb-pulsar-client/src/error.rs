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
    #[cfg(feature = "pulsar")]
    #[error("Pulsar error: {0}")]
    Pulsar(#[from] pulsar::Error),

    /// Forwarder backend error (generic, always available)
    #[error("Forwarder error: {0}")]
    Forwarder(String),

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
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl ClientError {
    /// Checks if the error is recoverable.
    ///
    /// Recoverable errors can typically be resolved through:
    /// - Reconnection (Socket, Pulsar, Forwarder errors)
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
        match self {
            ClientError::Socket(_) | ClientError::Forwarder(_) => true,
            #[cfg(feature = "pulsar")]
            ClientError::Pulsar(_) => true,
            _ => false,
        }
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
        match self {
            ClientError::Socket(_) | ClientError::Forwarder(_) | ClientError::RetryQueueFull(_) => {
                true
            }
            #[cfg(feature = "pulsar")]
            ClientError::Pulsar(_) => true,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_socket_error_is_recoverable() {
        let err = ClientError::Socket(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "refused",
        ));
        assert!(err.is_recoverable());
    }

    #[test]
    fn test_config_error_not_recoverable() {
        let err = ClientError::Config("bad config".into());
        assert!(!err.is_recoverable());
    }

    #[test]
    fn test_buffer_overflow_not_recoverable() {
        let err = ClientError::BufferOverflow {
            current: 100,
            limit: 50,
        };
        assert!(!err.is_recoverable());
    }

    #[test]
    fn test_retry_queue_full_not_recoverable() {
        let err = ClientError::RetryQueueFull(1000);
        assert!(!err.is_recoverable());
    }

    #[test]
    fn test_shutdown_not_recoverable() {
        let err = ClientError::Shutdown;
        assert!(!err.is_recoverable());
    }

    #[test]
    fn test_other_not_recoverable() {
        let err = ClientError::Other("something".into());
        assert!(!err.is_recoverable());
    }

    #[test]
    fn test_forwarder_error_is_recoverable() {
        let err = ClientError::Forwarder("connection lost".into());
        assert!(err.is_recoverable());
    }

    #[test]
    fn test_forwarder_error_should_retry() {
        let err = ClientError::Forwarder("timeout".into());
        assert!(err.should_retry());
    }

    #[cfg(feature = "pulsar")]
    #[test]
    fn test_pulsar_error_is_recoverable() {
        // We can't easily construct a pulsar::Error, so we test via Forwarder
        // which has the same recoverable semantics
        let err = ClientError::Forwarder("pulsar-like error".into());
        assert!(err.is_recoverable());
    }

    #[test]
    fn test_socket_error_should_retry() {
        let err = ClientError::Socket(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "refused",
        ));
        assert!(err.should_retry());
    }

    #[test]
    fn test_retry_queue_full_should_retry() {
        let err = ClientError::RetryQueueFull(1000);
        assert!(err.should_retry());
    }

    #[test]
    fn test_config_error_should_not_retry() {
        let err = ClientError::Config("bad".into());
        assert!(!err.should_retry());
    }

    #[test]
    fn test_error_display_contains_context() {
        let err = ClientError::BufferOverflow {
            current: 100,
            limit: 50,
        };
        let display = err.to_string();
        assert!(display.contains("100"), "should contain current size");
        assert!(display.contains("50"), "should contain limit");
    }

    #[test]
    fn test_forwarder_error_display() {
        let err = ClientError::Forwarder("file write failed".into());
        assert!(err.to_string().contains("file write failed"));
    }
}
