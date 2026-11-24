//! Error types for the ADS-B data engine.

use thiserror::Error;

/// Errors that can occur in storage operations.
#[derive(Debug, Error)]
pub enum StorageError {
    /// DuckDB error.
    #[error("DuckDB error: {0}")]
    DuckDb(#[from] duckdb::Error),

    /// Query returned unexpected data.
    #[error("Query error: {0}")]
    Query(String),

    /// A receiver location change broke the history's rules.
    #[error(transparent)]
    History(#[from] crate::receiver_history::HistoryError),

    /// I/O error (e.g., creating DB directory).
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
