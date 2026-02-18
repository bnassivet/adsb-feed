//! Pluggable message forwarding backends.
//!
//! The [`MessageForwarder`] trait abstracts message delivery, allowing the
//! client to forward to Pulsar, files, or any custom backend.

pub mod file;
#[cfg(feature = "pulsar")]
pub mod pulsar_forwarder;

use crate::error::Result;

/// Trait for message forwarding backends.
///
/// Implementors handle their own connection lifecycle and message delivery.
/// The core client fans out to all registered forwarders independently.
#[async_trait::async_trait]
pub trait MessageForwarder: Send {
    /// Establishes the connection to the backend.
    async fn connect(&mut self) -> Result<()>;

    /// Sends a single message to the backend.
    async fn send(&mut self, message: &[u8]) -> Result<()>;

    /// Flushes any buffered data to the backend.
    async fn flush(&mut self) -> Result<()>;

    /// Disconnects from the backend gracefully.
    async fn disconnect(&mut self) -> Result<()>;

    /// Returns whether the forwarder is currently connected.
    fn is_connected(&self) -> bool;

    /// Returns a human-readable name for this forwarder (e.g., "pulsar", "file").
    fn name(&self) -> &str;
}

/// Always-connected, always-succeeds forwarder for test_mode and Tauri app.
///
/// # Examples
///
/// ```rust
/// use adsb_pulsar_client::forwarder::{MessageForwarder, NoopForwarder};
///
/// let forwarder = NoopForwarder;
/// assert!(forwarder.is_connected());
/// assert_eq!(forwarder.name(), "noop");
/// ```
pub struct NoopForwarder;

#[async_trait::async_trait]
impl MessageForwarder for NoopForwarder {
    async fn connect(&mut self) -> Result<()> {
        Ok(())
    }

    async fn send(&mut self, _message: &[u8]) -> Result<()> {
        Ok(())
    }

    async fn flush(&mut self) -> Result<()> {
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        Ok(())
    }

    fn is_connected(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        "noop"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_noop_forwarder_always_connected() {
        let forwarder = NoopForwarder;
        assert!(forwarder.is_connected());
    }

    #[tokio::test]
    async fn test_noop_forwarder_name() {
        let forwarder = NoopForwarder;
        assert_eq!(forwarder.name(), "noop");
    }

    #[tokio::test]
    async fn test_noop_forwarder_send_succeeds() {
        let mut forwarder = NoopForwarder;
        assert!(forwarder.send(b"test message").await.is_ok());
    }

    #[tokio::test]
    async fn test_noop_forwarder_connect_disconnect_cycle() {
        let mut forwarder = NoopForwarder;
        assert!(forwarder.connect().await.is_ok());
        assert!(forwarder.is_connected());
        assert!(forwarder.disconnect().await.is_ok());
        assert!(forwarder.is_connected()); // Noop stays connected
    }

    #[tokio::test]
    async fn test_noop_forwarder_flush_succeeds() {
        let mut forwarder = NoopForwarder;
        assert!(forwarder.flush().await.is_ok());
    }
}
