//! ADS-B Feed Client — CLI entry point.
//!
//! High-performance Rust implementation that connects to dump1090 TCP socket
//! and forwards SBS-1 messages to pluggable backends (Pulsar, file, etc.).

use adsb_pulsar_client::forwarder::file::FileForwarder;
use adsb_pulsar_client::forwarder::{MessageForwarder, NoopForwarder};
use adsb_pulsar_client::{ADSBFeedClient, ClientError, Config, ForwarderKind};
use clap::Parser;
use std::path::PathBuf;
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

/// Builds forwarder instances based on configuration.
fn build_forwarders(config: &Config) -> Result<Vec<Box<dyn MessageForwarder>>, ClientError> {
    if config.test_mode {
        return Ok(vec![Box::new(NoopForwarder)]);
    }

    let mut forwarders: Vec<Box<dyn MessageForwarder>> = Vec::new();

    for kind in &config.forwarders {
        match kind {
            ForwarderKind::Pulsar => {
                #[cfg(feature = "pulsar")]
                {
                    use adsb_pulsar_client::forwarder::pulsar_forwarder::PulsarForwarder;
                    forwarders.push(Box::new(PulsarForwarder::new(config)));
                }
                #[cfg(not(feature = "pulsar"))]
                {
                    return Err(ClientError::Config(
                        "Pulsar forwarder requested but 'pulsar' feature is not enabled. \
                         Recompile with --features pulsar or use --forwarder file."
                            .into(),
                    ));
                }
            }
            ForwarderKind::File => {
                forwarders.push(Box::new(FileForwarder::new(PathBuf::from(
                    &config.file_path,
                ))));
            }
            ForwarderKind::Noop => {
                forwarders.push(Box::new(NoopForwarder));
            }
        }
    }

    if forwarders.is_empty() {
        return Err(ClientError::Config(
            "No forwarders configured. Use --forwarder pulsar|file|noop.".into(),
        ));
    }

    Ok(forwarders)
}

/// Runs the client with graceful shutdown handling.
async fn run_client(config: Config) -> adsb_pulsar_client::error::Result<()> {
    let forwarders = build_forwarders(&config)?;
    let mut client = ADSBFeedClient::new(config, forwarders)?;

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
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(log_level));

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
    info!("║   ADS-B Feed Client (Rust)                           ║");
    info!("║   High-Performance Edge Data Ingestion               ║");
    info!("╚═══════════════════════════════════════════════════════╝");
}
