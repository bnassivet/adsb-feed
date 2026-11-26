//! OpenSky gap filler for the ADS-B stack.
//!
//! The local receiver has blind spots. This service fills them from the
//! OpenSky Network: clients (the desktop) say which aircraft and which areas
//! they want, the service polls OpenSky for them within the account's daily
//! credit budget, and publishes what it finds over MQTT. Nothing it fetches is
//! recorded: the recorder's database stays "what my receiver heard".
//!
//! The contract modules ([`api`], [`states`], [`status`], [`budget`],
//! [`credits`], [`watch`]) carry no service dependencies, so the desktop can
//! decode the payloads without building the poller.

pub mod api;
#[cfg(feature = "client")]
pub mod api_client;
#[cfg(feature = "http-api")]
pub mod api_server;
#[cfg(feature = "service")]
pub mod auth;
pub mod budget;
#[cfg(feature = "service")]
pub mod control;
pub mod credits;
#[cfg(feature = "metrics")]
pub mod metrics_export;
#[cfg(feature = "service")]
pub mod poller;
#[cfg(feature = "service")]
pub mod provider;
#[cfg(feature = "service")]
pub mod publisher;
pub mod states;
pub mod status;
pub mod watch;
