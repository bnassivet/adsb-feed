//! ADS-B data server — headless recorder entry point.

use adsb_data_server::{Recorder, RecorderConfig};
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

    if cfg.print_config {
        match toml::to_string_pretty(&cfg) {
            Ok(t) => println!("{t}"),
            Err(e) => {
                eprintln!("Could not serialise config: {e}");
                std::process::exit(2);
            }
        }
        std::process::exit(0);
    }

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

    // A query-API setting must not stop a recorder from recording, so an
    // unparseable bind falls back to loopback and says so.
    #[cfg(feature = "http-api")]
    let http_bind = cfg.http_bind_addr().unwrap_or_else(|| {
        tracing::warn!(
            "http_bind '{}' is not an IP address; falling back to 127.0.0.1",
            cfg.http_bind
        );
        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    });

    #[cfg(all(feature = "http-api", not(feature = "metrics")))]
    if cfg.http_port > 0 {
        adsb_data_server::server::spawn(recorder.storage(), http_bind, cfg.http_port);
    }

    #[cfg(feature = "metrics")]
    if cfg.http_port > 0 {
        use adsb_data_server::metrics_export::{REFRESH_INTERVAL, StatsCache};
        use adsb_data_server::server::MetricsState;

        // The stats query contends with ingest, so it runs on its own cadence
        // rather than once per scrape. See `metrics_export`.
        let cache = StatsCache::new();
        tokio::spawn(cache.clone().run(recorder.storage(), REFRESH_INTERVAL));
        adsb_data_server::server::spawn_with_metrics(
            recorder.storage(),
            http_bind,
            cfg.http_port,
            MetricsState {
                version: env!("CARGO_PKG_VERSION").to_string(),
                source_id: cfg.source_id.clone(),
                cache,
            },
        );
    }

    // The MQTT subscriber lives in the feed client, which owns both ends of the
    // MQTT transport and the raw-SBS broadcast contract every consumer speaks.
    let feed = cfg.feed_config();
    let weather_topic = feed.weather_topic();
    let mut source = MqttSource::new(&feed);

    // A second topic on the SAME connection: whole retained documents, never
    // line-split, so the SBS path is byte-for-byte unchanged. Registered here
    // because `with_aux_topic` needs `&mut source` before the source is moved
    // into the recorder.
    let weather_rx = source.with_aux_topic(&weather_topic);
    info!("Recording weather snapshots from '{}'", weather_topic);

    tokio::select! {
        result = recorder.run_with_weather(source, Some(weather_rx)) => result,
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
