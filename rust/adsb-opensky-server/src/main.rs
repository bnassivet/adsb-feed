//! ADS-B OpenSky gap-filler entry point.

use adsb_opensky_server::api_server::{self, ApiState};
use adsb_opensky_server::auth::TokenSource;
use adsb_opensky_server::budget;
use adsb_opensky_server::control::{self, Budget, Control};
use adsb_opensky_server::credits::{self, Ledger};
use adsb_opensky_server::poller;
use adsb_opensky_server::provider::HttpProvider;
use adsb_opensky_server::publisher::{self, PublisherConfig};
use adsb_opensky_server::status::OpenSkyStatus;
use adsb_opensky_server::watch::WatchSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

mod config;
use config::OpenSkyConfig;

#[tokio::main]
async fn main() {
    let cfg = match OpenSkyConfig::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Configuration error: {e:#}");
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
    if let Err(e) = cfg.validate() {
        eprintln!("Configuration error: {e:#}");
        std::process::exit(2);
    }

    init_tracing(&cfg.log_level);
    info!(
        "ADS-B OpenSky service starting (source_id={}, topic={})",
        cfg.source_id, cfg.mqtt_topic
    );
    if let Err(e) = run(cfg).await {
        error!("Fatal error: {e:#}");
        std::process::exit(1);
    }
    info!("Shutdown complete");
}

async fn run(cfg: OpenSkyConfig) -> anyhow::Result<()> {
    let credentials = cfg.credentials()?;
    let authenticated = credentials.is_some();
    match &credentials {
        Some(c) => info!("OpenSky API client '{}'", c.client_id),
        None => warn!(
            "No OpenSky credentials: anonymous access, {} credits a day and no tracks. \
             Set client_id/client_secret or credentials_file",
            budget::ANONYMOUS_DAILY_CREDITS
        ),
    }
    let auth = credentials
        .map(|c| TokenSource::new(&cfg.token_url, c))
        .transpose()?;
    let provider = Arc::new(HttpProvider::new(&cfg.api_url, auth)?);

    let daily = cfg.effective_daily_credits(authenticated);
    let min_interval = cfg.effective_min_interval(authenticated);
    info!(
        "Budget: {daily} credits a day per bucket, {:.0}% spent by the scheduler; one \
         small area or any number of aircraft polls every {} s at best",
        budget::SPEND_FRACTION * 100.0,
        budget::steady_interval(1, daily, min_interval).as_secs()
    );

    let ledger = match cfg.state_path.as_deref().map(credits::load) {
        None => {
            warn!(
                "state_path is not set: the 24 h credit count restarts from zero on every restart"
            );
            Ledger::default()
        }
        Some(Ok(l)) => l,
        Some(Err(e)) => {
            warn!("{e}; starting the credit count from zero");
            Ledger::default()
        }
    };

    // Fetched tracks, on their way to the publisher and the recorders.
    let (tracks_tx, tracks_rx) = tokio::sync::mpsc::channel(32);
    let control = Arc::new(
        Control::new(
            WatchSet::new(cfg.limits(), cfg.lease_seconds as i64 * 1_000),
            ledger,
            cfg.state_path.clone(),
            Budget {
                daily_credits: daily,
                min_interval,
            },
            provider,
            control::system_clock(),
        )
        .with_track_sink(tracks_tx),
    );

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (states_tx, states_rx) = watch::channel(None);
    let (status_tx, status_rx) = watch::channel(OpenSkyStatus::initial(
        true,
        authenticated,
        daily,
        control.now(),
    ));

    let api = (cfg.http_port > 0).then(|| {
        tokio::spawn(api_server::serve(
            cfg.http_bind_addr().expect("http_bind was validated"),
            cfg.http_port,
            ApiState {
                control: control.clone(),
                status: status_rx.clone(),
            },
            cfg.source_id.clone(),
            shutdown_rx.clone(),
        ))
    });
    if api.is_none() {
        warn!("OpenSky control API disabled (http_port = 0): nothing can be watched");
    }
    let publisher = tokio::spawn(publisher::run(
        PublisherConfig {
            broker: cfg.mqtt_broker.clone(),
            port: cfg.mqtt_port,
            topic: cfg.mqtt_topic.clone(),
            client_id: publisher::client_id(&cfg.source_id),
            keep_alive: Duration::from_secs(30),
        },
        states_rx,
        tracks_rx,
        status_rx,
        shutdown_rx.clone(),
    ));
    let poller = tokio::spawn(poller::run(control, states_tx, status_tx, shutdown_rx));

    shutdown_signal().await;
    info!("Shutdown signal received, stopping gracefully...");
    let _ = shutdown_tx.send(true);
    let _ = tokio::join!(poller, publisher);
    if let Some(api) = api {
        let _ = api.await;
    }
    Ok(())
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
