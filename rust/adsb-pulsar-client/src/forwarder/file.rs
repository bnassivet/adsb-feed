//! File-based message forwarder.
//!
//! Writes raw SBS-1 messages to a file, one per line, using a buffered
//! writer that is flushed periodically by the client's housekeeping tick.

use crate::error::{ClientError, Result};
use crate::forwarder::MessageForwarder;
use std::path::PathBuf;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncWriteExt, BufWriter};
use tracing::info;

/// File-based message forwarder.
///
/// Appends one raw SBS-1 line per message to the configured file path.
/// Uses a `BufWriter` for efficient batched I/O.
pub struct FileForwarder {
    path: PathBuf,
    writer: Option<BufWriter<tokio::fs::File>>,
}

impl FileForwarder {
    /// Creates a new FileForwarder that will write to the given path.
    pub fn new(path: PathBuf) -> Self {
        Self { path, writer: None }
    }
}

#[async_trait::async_trait]
impl MessageForwarder for FileForwarder {
    async fn connect(&mut self) -> Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
            .map_err(|e| {
                ClientError::Forwarder(format!("Failed to open {}: {}", self.path.display(), e))
            })?;

        self.writer = Some(BufWriter::new(file));
        info!("FileForwarder: opened {} for writing", self.path.display());
        Ok(())
    }

    async fn send(&mut self, message: &[u8]) -> Result<()> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| ClientError::Forwarder("FileForwarder not connected".into()))?;

        writer
            .write_all(message)
            .await
            .map_err(|e| ClientError::Forwarder(format!("Write failed: {}", e)))?;
        writer
            .write_all(b"\n")
            .await
            .map_err(|e| ClientError::Forwarder(format!("Write newline failed: {}", e)))?;

        Ok(())
    }

    async fn flush(&mut self) -> Result<()> {
        if let Some(writer) = self.writer.as_mut() {
            writer
                .flush()
                .await
                .map_err(|e| ClientError::Forwarder(format!("Flush failed: {}", e)))?;
        }
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<()> {
        if let Some(mut writer) = self.writer.take() {
            writer.flush().await.map_err(|e| {
                ClientError::Forwarder(format!("Flush on disconnect failed: {}", e))
            })?;
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.writer.is_some()
    }

    fn name(&self) -> &str {
        "file"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_file_forwarder_not_connected_before_open() {
        let forwarder = FileForwarder::new(PathBuf::from("/tmp/test.sbs"));
        assert!(!forwarder.is_connected());
    }

    #[test]
    fn test_file_forwarder_name() {
        let forwarder = FileForwarder::new(PathBuf::from("/tmp/test.sbs"));
        assert_eq!(forwarder.name(), "file");
    }

    #[tokio::test]
    async fn test_file_forwarder_writes_messages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_output.sbs");

        let mut forwarder = FileForwarder::new(path.clone());
        assert!(!forwarder.is_connected());

        forwarder.connect().await.unwrap();
        assert!(forwarder.is_connected());

        forwarder
            .send(b"MSG,3,1,1,A1B2C3,1,,,,,,35000")
            .await
            .unwrap();
        forwarder
            .send(b"MSG,1,1,1,D4E5F6,1,,,,AIR123")
            .await
            .unwrap();
        forwarder.flush().await.unwrap();

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "MSG,3,1,1,A1B2C3,1,,,,,,35000");
        assert_eq!(lines[1], "MSG,1,1,1,D4E5F6,1,,,,AIR123");
    }

    #[tokio::test]
    async fn test_file_forwarder_disconnect_flushes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_disconnect.sbs");

        let mut forwarder = FileForwarder::new(path.clone());
        forwarder.connect().await.unwrap();
        forwarder.send(b"line1").await.unwrap();
        forwarder.disconnect().await.unwrap();

        assert!(!forwarder.is_connected());

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(content.trim(), "line1");
    }

    #[tokio::test]
    async fn test_file_forwarder_send_without_connect_fails() {
        let mut forwarder = FileForwarder::new(PathBuf::from("/tmp/never_opened.sbs"));
        let result = forwarder.send(b"should fail").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_file_forwarder_appends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_append.sbs");

        // First session
        let mut forwarder = FileForwarder::new(path.clone());
        forwarder.connect().await.unwrap();
        forwarder.send(b"first").await.unwrap();
        forwarder.disconnect().await.unwrap();

        // Second session (should append)
        let mut forwarder = FileForwarder::new(path.clone());
        forwarder.connect().await.unwrap();
        forwarder.send(b"second").await.unwrap();
        forwarder.disconnect().await.unwrap();

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "first");
        assert_eq!(lines[1], "second");
    }
}
