# ADS-B Data Engine

Shared Rust library providing SBS-1 message parsing, DuckDB persistent storage, and analytical queries for ADS-B aircraft tracking data.

Used by the [ADS-B Aircraft Tracker](../adsb-pulsar-client-desktop/) desktop app and available as a standalone crate for any Rust application needing ADS-B data persistence.

## Features

- **SBS-1 Parser** - Stateless parser for 22-field CSV messages from dump1090 (MSG types 1-8)
- **DuckDB Storage** - Embedded OLAP database with 5 tables: positions, raw messages, flights, status events, events of interest
- **Incremental Flight Tracking** - Automatic flight segmentation based on configurable time gaps (default: 1 hour)
- **Arrow IPC Serialization** - Query results as Apache Arrow for efficient wire transfer (~4x smaller than JSON)
- **Analytical Queries** - Detection range by azimuth, hourly heatmaps, time distribution histograms, spatial bounding box queries
- **Import / Export** - Merge external databases with deduplication, live export without stopping writes
- **Graceful Degradation** - All storage operations return `Result`; callers can run without a database

## API Overview

### Parsing

```rust
use adsb_data_engine::{parse_sbs_message, AircraftPosition};

let line = "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,45.5,-73.5,,,,,,0";
if let Some(position) = parse_sbs_message(line) {
    println!("{} at {}ft", position.hex_ident, position.altitude.unwrap_or(0.0));
}
```

### Storage

```rust
use adsb_data_engine::{StorageHandle, StorageConfig};

// Open or create a database
let config = StorageConfig {
    db_path: "adsb_history.db".into(),
    source_id: "my-receiver".into(),
    ..Default::default()
};
let storage = StorageHandle::open(config).await?;

// Insert a batch of positions
storage.insert_batch(&positions, "UTC").await?;

// Query trajectories, flight summaries, bounding boxes...
let stats = storage.get_stats().await?;
println!("{}  positions, {} flights", stats.position_count, stats.flight_count);
```

### Key Types

| Type | Purpose |
|------|---------|
| `StorageHandle` | Thread-safe DuckDB wrapper (cloneable `Arc<Mutex>`) |
| `AircraftPosition` | Parsed SBS-1 message with optional fields |
| `StorageConfig` | Database path, source ID, gap threshold |
| `BboxQuery` | Spatial + temporal window query |
| `TrajectoryQuery` | Single aircraft path reconstruction |
| `FlightSummary` | Pre-computed flight segment stats |
| `StorageStats` | Row counts, DB size, timestamp bounds |
| `StatusEvent` | Operational audit trail entry |
| `EventOfInterest` | User/system annotation with spatial bounds |

## Database Schema

Five tables with targeted indexes:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| **positions** | Core fact table | hex_ident, lat, lon, altitude, timestamp_ms |
| **raw_messages** | SBS-1 audit trail | hex_ident, msg_type, raw_message, timestamp_ms |
| **flights** | Pre-computed segments | flight_id, hex_ident, flight_num, position_count, first/last_seen_ms |
| **status_events** | Operational log | event_type, status, detail, timestamp_ms |
| **events_of_interest** | User annotations | title, description, lat/lon, bbox, category |

All timestamps are stored as UTC epoch milliseconds (`BIGINT`).

## Query Methods

### Spatial & Temporal
- `query_bbox` / `query_bbox_arrow` - Positions within a geographic and time window
- `get_trajectory` / `get_trajectories_batch_arrow` - Full flight path reconstruction
- `get_aircraft_summary` - Unique aircraft with aggregate stats
- `get_flight_summary` / `get_flight_summary_arrow` - Distinct flights from pre-computed table

### Analytics
- `get_detection_range` - Signal range by 10-degree azimuth sectors (36 sectors, vectorized in SQL)
- `get_hourly_heatmap` - Activity grid (day x hour) across positions, messages, and flights
- `get_time_distribution` - Histogram with selectable metric (Positions, Aircraft, RawMessages, Flights)

### Audit & Events
- `query_status_events` - Feed/storage lifecycle events
- CRUD for `events_of_interest` - Create, read, update, delete user annotations

### Maintenance
- `prune` - Delete data older than a threshold
- `checkpoint` - Flush WAL to disk
- `export_database` / `import_database` - Copy or merge databases
- `move_database_to_snapshot` - Archive current DB as timestamped snapshot

## Design Decisions

**Dual API surface** - Every query has a `*_sync()` method (direct, blocking) and an async wrapper using `tokio::spawn_blocking`. DuckDB's C FFI is synchronous; the async layer exists for scheduler fairness in Tokio runtimes.

**Incremental flight tracking** - Flights are computed on insert, not on query. An in-memory `HashMap<hex_ident, ActiveFlight>` tracks the latest flight per aircraft with O(1) gap detection. On open, the tracker is rebuilt from existing flight data.

**Arrow serialization** - Methods suffixed `_arrow` return `Vec<u8>` (Arrow IPC stream). The desktop app frontend decodes these with zero-copy typed array views for large result sets.

**Timezone handling** - The parser preserves the original SBS-1 string timestamp. The storage layer converts to UTC epoch milliseconds using a configurable timezone (supports "Local", "UTC", or any IANA name).

## Testing

~148 tests covering parsing, storage CRUD, flight tracking, analytics, and geodesic math:

```bash
cargo test -p adsb-data-engine                # All tests
cargo test -p adsb-data-engine sbs_parser     # Parser only
cargo test -p adsb-data-engine storage        # Storage only
```

| Module | Tests | Focus |
|--------|------:|-------|
| sbs_parser | 23 | MSG subtypes, edge cases, heartbeat filtering |
| storage | 112 | CRUD, incremental flights, import/export, analytics queries |
| geo | 13 | Haversine distance, bearing calculation, sector mapping |

## Dependencies

| Crate | Purpose |
|-------|---------|
| [duckdb](https://crates.io/crates/duckdb) 1.2 | Embedded OLAP database (statically linked) |
| [arrow](https://crates.io/crates/arrow) 56 | IPC serialization for query results |
| [chrono](https://crates.io/crates/chrono) + chrono-tz | Timezone-aware timestamp conversion |
| [tokio](https://crates.io/crates/tokio) | Async wrappers via `spawn_blocking` |
| [uuid](https://crates.io/crates/uuid) | Auto-generated event IDs |
| [thiserror](https://crates.io/crates/thiserror) | Typed error handling |
