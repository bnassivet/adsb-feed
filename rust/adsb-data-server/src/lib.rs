//! Headless ADS-B recorder.
//!
//! `adsb-data-server` is the edge counterpart to the desktop app: it consumes a
//! live SBS-1 feed, records it to DuckDB, and exposes the result to other
//! processes — without a GUI, and without Apache Pulsar.
//!
//! It is deliberately a *separate process* from `adsb-pulsar-client`. DuckDB
//! takes an exclusive file lock, so exactly one process may own the database;
//! keeping the feed client free of that constraint lets it stay a tiny binary
//! that also runs on 32-bit nodes, where DuckDB cannot go at all.
//!
//! ```text
//! adsb-pulsar-client ──MQTT──► adsb-data-server ──► DuckDB
//!   (any arch)                   (aarch64 only)       │
//!                                                     ├─► quack_serve  (SQL ATTACH)
//!                                                     └─► HTTP tool API (read-only)
//! ```
//!
//! The ingest path itself is not implemented here: it lives in
//! [`adsb_data_engine::ingest`], shared with the desktop app so the two cannot
//! drift. This crate supplies the headless wiring — a source, a
//! [`NoopSink`](adsb_data_engine::NoopSink), and the serving surfaces.

pub mod recorder;
#[cfg(feature = "http-api")]
pub mod server;
pub mod tool_service;

pub use recorder::{Recorder, RecorderConfig};
