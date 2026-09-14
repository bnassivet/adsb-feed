//! Weather service for the ADS-B stack.
//!
//! Fetches gridded winds aloft and mean-sea-level pressure around the receiver
//! and publishes them as one retained MQTT message. The desktop app subscribes
//! on the same broker connection it uses for the live feed.
//!
//! The types in [`snapshot`] and [`grid`] are the wire contract. They carry no
//! service dependencies, so a consumer can depend on this crate for the
//! payload shape alone.

pub mod budget;
pub mod grid;
pub mod snapshot;

pub use grid::{GridError, GridSpec};
pub use snapshot::{LevelFields, SnapshotError, SurfaceFields, WeatherSnapshot};
