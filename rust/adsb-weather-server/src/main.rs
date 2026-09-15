//! ADS-B weather service entry point.

use adsb_weather_server::api_server::{self, ApiState};
use adsb_weather_server::budget::{self, BudgetVerdict};
use adsb_weather_server::control::Control;
use adsb_weather_server::projection;
use adsb_weather_server::provider::OpenMeteoProvider;
use adsb_weather_server::publisher::{self, PublisherConfig};
use adsb_weather_server::refresh::{self, Refresher, ReportedState};
use adsb_weather_server::state_file::StateStore;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

mod config;
use config::WeatherConfig;

#[tokio::main]
async fn main() {
    let cfg = match WeatherConfig::load() {
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
        "ADS-B weather service starting (source_id={}, topic={})",
        cfg.source_id, cfg.mqtt_topic
    );

    if let Err(e) = run(cfg).await {
        error!("Fatal error: {e:#}");
        std::process::exit(1);
    }
    info!("Shutdown complete");
}

async fn run(cfg: WeatherConfig) -> anyhow::Result<()> {
    let grid = cfg.grid()?;
    report_budget(&cfg, grid.len());

    // The durable control state: the operator's setting and any rate-limit
    // deadline. Unreadable is not fatal -- the defaults are safe enough, and
    // the next change rewrites the file -- but it must be visible.
    let (store, store_error) = StateStore::open(cfg.state_path.clone());
    if let Some(e) = store_error {
        warn!("{e}; starting enabled with no rate-limit deadline");
    }
    if !store.is_persistent() {
        warn!(
            "state_path is not set: enable/disable and rate-limit deadlines will not survive a restart"
        );
    }
    let store = Arc::new(store);
    let control = Arc::new(Control::new(store.clone()));
    if !control.enabled() {
        info!(
            "Weather fetching is disabled (persisted setting); enable it through the control API"
        );
    }

    let provider = OpenMeteoProvider::new(&cfg.base_url, &cfg.model)?;
    let mut refresher = Refresher::new(
        provider,
        grid,
        cfg.levels.clone(),
        Duration::from_secs(u64::from(cfg.refresh_minutes) * 60),
    )
    .with_desired(control.subscribe())
    .with_state_store(store);
    if let Some(path) = cfg.cache_path.clone() {
        refresher = refresher.with_cache(path);
    }

    let (snapshot_tx, snapshot_rx) = watch::channel(None);
    let (reported_tx, reported_rx) = watch::channel(ReportedState::default());
    let (status_tx, status_rx) = watch::channel(projection::project(
        control.enabled(),
        &ReportedState::default(),
        refresh::system_clock_ms(),
    ));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let projection = tokio::spawn(projection::run(
        control.subscribe(),
        reported_rx,
        status_tx,
        shutdown_rx.clone(),
        refresh::system_clock_ms,
    ));
    let api = (cfg.http_port > 0).then(|| {
        tokio::spawn(api_server::serve(
            // Validated at startup.
            cfg.http_bind_addr().expect("http_bind was validated"),
            cfg.http_port,
            ApiState {
                control: control.clone(),
                status: status_rx.clone(),
            },
            shutdown_rx.clone(),
        ))
    });
    if api.is_none() {
        info!("Weather control API disabled (http_port = 0)");
    }
    let publisher = tokio::spawn(publisher::run(
        PublisherConfig {
            broker: cfg.mqtt_broker.clone(),
            port: cfg.mqtt_port,
            topic: cfg.mqtt_topic.clone(),
            client_id: publisher::client_id(&cfg.source_id),
            keep_alive: Duration::from_secs(30),
        },
        snapshot_rx,
        status_rx,
        shutdown_rx.clone(),
    ));
    let refresh = tokio::spawn(refresher.run(snapshot_tx, reported_tx, shutdown_rx));

    shutdown_signal().await;
    info!("Shutdown signal received, stopping gracefully...");
    let _ = shutdown_tx.send(true);
    // The publisher goes last in spirit: it says "offline" on its way out.
    let _ = tokio::join!(refresh, projection, publisher);
    if let Some(api) = api {
        let _ = api.await;
    }
    Ok(())
}

/// Logs the Open-Meteo call estimate once, up front, where an operator who
/// just shrank the spacing or the refresh interval will see it.
fn report_budget(cfg: &WeatherConfig, points: usize) {
    let variables = budget::variables_per_location(cfg.levels.len());
    let daily = budget::estimated_daily_calls(points, variables, cfg.refresh_minutes);
    let summary = format!(
        "{points} grid points x {variables} variables every {} min = ~{daily:.0} Open-Meteo calls/day",
        cfg.refresh_minutes
    );
    // The daily total can look fine while a single refresh still trips a
    // shorter window. Over the hourly limit every refresh fails; over the
    // per-minute allowance the provider paces itself, which is only worth
    // knowing because the grid then takes longer to arrive.
    let per_refresh = budget::calls_per_refresh(points, variables);
    let pacing = budget::estimated_pacing(per_refresh);
    if per_refresh > budget::HOURLY_LIMIT {
        warn!(
            "One refresh is ~{per_refresh:.0} Open-Meteo calls, over the {:.0}/hour limit: \
             every refresh will be rate limited. Increase spacing_deg or fetch fewer levels",
            budget::HOURLY_LIMIT
        );
    } else if !pacing.is_zero() {
        info!(
            "One refresh is ~{per_refresh:.0} Open-Meteo calls, more than the per-minute \
             allowance: requests are spread over ~{} s",
            pacing.as_secs()
        );
    }

    match budget::verdict(daily) {
        BudgetVerdict::Ok => info!("{summary}"),
        BudgetVerdict::Warn => warn!(
            "{summary}: close to the {:.0}/day free tier, little headroom for retries",
            budget::FREE_DAILY_LIMIT
        ),
        BudgetVerdict::OverLimit => warn!(
            "{summary}: EXCEEDS the {:.0}/day free tier. Increase spacing_deg or \
             refresh_minutes, or fetches will be rate limited",
            budget::FREE_DAILY_LIMIT
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
