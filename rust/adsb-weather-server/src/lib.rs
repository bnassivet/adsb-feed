//! Weather service for the ADS-B stack.
//!
//! Fetches gridded winds aloft and mean-sea-level pressure around the receiver
//! and publishes them as one retained MQTT message. The desktop app subscribes
//! on the same broker connection it uses for the live feed.
//!
//! The types in [`snapshot`] and [`grid`] are the wire contract. They carry no
//! service dependencies, so a consumer can depend on this crate for the
//! payload shape alone.

pub mod api;
#[cfg(feature = "client")]
pub mod api_client;
#[cfg(feature = "http-api")]
pub mod api_server;
pub mod budget;
#[cfg(feature = "service")]
pub mod cache;
#[cfg(feature = "service")]
pub mod control;
pub mod grid;
#[cfg(feature = "metrics")]
pub mod metrics_export;
pub mod open_meteo;
#[cfg(feature = "service")]
pub mod projection;
#[cfg(feature = "service")]
pub mod provider;
#[cfg(feature = "service")]
pub mod publisher;
#[cfg(feature = "service")]
pub mod refresh;
pub mod snapshot;
#[cfg(feature = "service")]
pub mod state_file;
pub mod status;

pub use grid::{GridError, GridSpec};
pub use snapshot::{LevelFields, SnapshotError, SurfaceFields, WeatherSnapshot};
