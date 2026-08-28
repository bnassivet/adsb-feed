//! Probe: open storage in REMOTE mode against a live adsb-data-server.
//!
//! Verifies the whole Part B premise end to end -- that attaching a daemon's
//! Quack catalog and shadowing the observed table names with views makes the
//! existing query path work untouched.

use adsb_data_engine::types::RemoteConfig;
use adsb_data_engine::{BboxQuery, StorageConfig, StorageHandle};

fn main() {
    let uri = std::env::args()
        .nth(1)
        .expect("usage: remote_probe <quack-uri> [token]");
    let token = std::env::args().nth(2);

    let handle = StorageHandle::open(StorageConfig {
        db_path: Some(std::env::temp_dir().join("adsb_local_probe.db")),
        source_id: "desktop-remote".to_string(),
        gap_threshold_ms: 3_600_000,
        share: None,
        remote: Some(RemoteConfig {
            uri: uri.clone(),
            token,
            disable_ssl: None,
        }),
    })
    .expect("open in remote mode");

    println!("attached to {uri}");

    // Reads the REMOTE catalog through a local view, using unmodified query SQL.
    let rows = handle
        .query_bbox_sync(BboxQuery {
            north: 90.0,
            south: -90.0,
            east: 180.0,
            west: -180.0,
            start_ms: None,
            end_ms: None,
            limit: 10,
        })
        .expect("query_bbox through the remote view");
    println!("positions visible through remote view: {}", rows.len());

    let stats = handle.get_stats_sync().expect("stats");
    println!(
        "remote row_count={} flights={}",
        stats.row_count, stats.flight_count
    );

    // Authored tables must still be LOCAL and writable.
    let scenarios = handle.list_scenarios_sync().expect("local scenarios");
    println!("local scenarios table reachable: {} rows", scenarios.len());

    println!("REMOTE MODE OK");
}
