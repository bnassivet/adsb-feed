//! ADS-B Feed Client for Apache Pulsar
//!
//! High-performance Rust implementation that connects to dump1090 TCP socket
//! and forwards SBS-1 messages to Apache Pulsar.

mod client;
mod config;
mod error;
mod metrics;

use clap::Parser;
use client::ADSBFeedClient;
use config::Config;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    // Parse command-line arguments
    let config = Config::parse();

    // Initialize logging
    let log_level = config.log_level.clone();
    init_tracing(&log_level);

    // Log startup banner
    print_banner();

    // Create and run client
    match run_client(config).await {
        Ok(()) => {
            info!("Client shutdown successfully");
            std::process::exit(0);
        }
        Err(e) => {
            error!("Fatal error: {}", e);
            std::process::exit(1);
        }
    }
}

/// Runs the client with graceful shutdown handling.
async fn run_client(config: Config) -> error::Result<()> {
    let mut client = ADSBFeedClient::new(config)?;

    // Setup graceful shutdown handler
    let shutdown = setup_shutdown_handler();

    // Run client with shutdown signal
    tokio::select! {
        result = client.run() => {
            result
        }
        _ = shutdown => {
            info!("Shutdown signal received, stopping gracefully...");
            info!("{}", client.final_stats());
            Ok(())
        }
    }
}

/// Initializes the tracing/logging subsystem.
fn init_tracing(log_level: &str) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(log_level));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_thread_ids(false)
        .with_line_number(true)
        .init();
}

/// Sets up graceful shutdown handler for SIGINT/SIGTERM.
async fn setup_shutdown_handler() {
    use tokio::signal;

    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

/// Prints the startup banner to logs.
fn print_banner() {
    info!("╔═══════════════════════════════════════════════════════╗");
    info!("║   ADS-B Feed Client for Apache Pulsar (Rust)         ║");
    info!("║   High-Performance Edge Data Ingestion               ║");
    info!("╚═══════════════════════════════════════════════════════╝");
}
