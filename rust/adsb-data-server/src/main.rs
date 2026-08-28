//! ADS-B data server — headless recorder entry point.

use adsb_data_server::{Recorder, RecorderConfig};
use adsb_pulsar_client::Config as FeedConfig;
use adsb_pulsar_client::source::mqtt_source::MqttSource;
use std::time::Duration;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

mod config;
use config::ServerConfig;

#[tokio::main]
async fn main() {
    let cfg = match ServerConfig::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Configuration error: {e}");
            std::process::exit(2);
        }
    };

    init_tracing(&cfg.log_level);
    info!("ADS-B data server starting (source_id={})", cfg.source_id);

    if let Err(e) = run(cfg).await {
        error!("Fatal error: {e}");
        std::process::exit(1);
    }
    info!("Shutdown complete");
}

async fn run(cfg: ServerConfig) -> anyhow::Result<()> {
    let recorder = Recorder::open(RecorderConfig {
        storage: cfg.storage_config(),
        dump1090_tz: cfg.dump1090_tz.clone(),
        checkpoint_interval: (cfg.checkpoint_secs > 0)
            .then(|| Duration::from_secs(cfg.checkpoint_secs)),
        retention: (cfg.retention_hours > 0)
            .then(|| Duration::from_secs(cfg.retention_hours * 3600)),
    })?;

    if cfg.share {
        report_sharing(&recorder).await;
    }

    #[cfg(feature = "http-api")]
    if cfg.http_port > 0 {
        adsb_data_server::server::spawn(recorder.storage(), cfg.http_port);
    }

    // The MQTT subscriber lives in the feed client, which owns both ends of the
    // MQTT transport and the raw-SBS broadcast contract every consumer speaks.
    let source = MqttSource::new(&FeedConfig {
        source_id: cfg.source_id.clone(),
        mqtt_broker: cfg.mqtt_broker.clone(),
        mqtt_port: cfg.mqtt_port,
        mqtt_topic: cfg.mqtt_topic.clone(),
        ..FeedConfig::default()
    });

    tokio::select! {
        result = recorder.run(source) => result,
        _ = shutdown_signal() => {
            info!("Shutdown signal received, stopping gracefully...");
            // Fold the WAL back into the file: an edge node that loses power
            // mid-write leaves a WAL that is slow to replay and awkward for
            // anything reading the database over Quack.
            let storage = recorder.storage();
            let guard = storage.read().await;
            if let Some(s) = guard.as_ref()
                && let Err(e) = s.checkpoint().await
            {
                error!("Final checkpoint failed: {e}");
            }
            Ok(())
        }
    }
}

/// Reports the Quack listen URI and token once sharing is up.
///
/// The token is printed at startup because DuckDB generates it at serve time
/// when none is configured — there is no other way for an operator to learn it.
async fn report_sharing(recorder: &Recorder) {
    let storage = recorder.storage();
    let guard = storage.read().await;
    let Some(s) = guard.as_ref() else { return };
    match s.sharing_status().await {
        Ok(status) => info!("Quack sharing: {status:?}"),
        Err(e) => error!(
            "Quack sharing unavailable: {e}. The extension is not statically \
             linked and is downloaded on first use, so this host needs outbound \
             network and a writable extension directory, or a pre-seeded extension."
        ),
    }
}

fn init_tracing(level: &str) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

async fn shutdown_signal() {
    use tokio::signal;
    let ctrl_c = async {
        signal::ctrl_c().await.expect("install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
