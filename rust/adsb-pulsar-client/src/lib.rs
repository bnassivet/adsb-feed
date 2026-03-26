//! ADS-B Feed Client
//!
//! High-performance Rust implementation for forwarding ADS-B messages
//! from dump1090 to pluggable backends (Apache Pulsar, files, etc.).
//!
//! # Overview
//!
//! This library provides a robust, production-ready client for ingesting
//! ADS-B (Automatic Dependent Surveillance-Broadcast) data from dump1090
//! and forwarding it through one or more [`forwarder::MessageForwarder`]
//! backends.
//!
//! # Features
//!
//! - **High Performance**: Async/await with Tokio for maximum throughput
//! - **Pluggable Backends**: Forward to Pulsar, files, or custom backends
//! - **Reliability**: Per-forwarder retry queues prevent data loss
//! - **Zero-Copy**: Efficient buffer management with `bytes` crate
//! - **Lock-Free Metrics**: Atomic operations for thread-safe tracking
//! - **Production Ready**: Graceful shutdown, structured logging, systemd support
//!
//! # Quick Start
//!
//! ```no_run
//! use adsb_pulsar_client::{ADSBFeedClient, Config};
//! use adsb_pulsar_client::forwarder::NoopForwarder;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let config = Config::default();
//!     let forwarders = vec![Box::new(NoopForwarder) as Box<dyn adsb_pulsar_client::forwarder::MessageForwarder>];
//!     let mut client = ADSBFeedClient::new(config, forwarders)?;
//!     client.run().await?;
//!     Ok(())
//! }
//! ```
//!
//! # Configuration
//!
//! Configuration can be provided via:
//! - Command-line arguments (with `cli` feature)
//! - Environment variables
//! - Programmatic construction with `Default`
//! - Deserialization from JSON/TOML (via serde)
//!
//! See [`Config`] for all available options.
//!
//! # Performance
//!
//! Typical performance on Raspberry Pi 4:
//! - **Throughput**: 40,000+ messages/second
//! - **Latency**: <1ms per message
//! - **Memory**: ~15 MB
//! - **CPU**: 10-15% utilization

pub mod client;
pub mod config;
pub mod connection_monitor;
pub mod error;
pub mod forwarder;
pub mod metrics;

// Re-export main types for convenience
pub use client::ADSBFeedClient;
pub use config::{Config, ConnectionMode, ForwarderKind};
pub use error::{ClientError, Result};
pub use metrics::{Metrics, MetricsSnapshot};
