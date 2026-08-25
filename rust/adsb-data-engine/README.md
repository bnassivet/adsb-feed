# ADS-B Data Engine

Shared Rust library providing SBS-1 message parsing, DuckDB persistent storage, and analytical queries for ADS-B aircraft tracking data.

Used by the [ADS-B Aircraft Tracker](../adsb-pulsar-client-desktop/) desktop app and available as a standalone crate for any Rust application needing ADS-B data persistence.

## Features

- **SBS-1 Parser** - Stateless parser for 22-field CSV messages from dump1090 (MSG types 1-8)
- **DuckDB Storage** - Embedded OLAP database with 7 tables: positions, raw messages, flights, status events, events of interest, scenarios, scenario tracks
- **Incremental Flight Tracking** - Automatic flight segmentation based on configurable time gaps (default: 1 hour)
- **Arrow IPC Serialization** - Query results as Apache Arrow for efficient wire transfer (~4x smaller than JSON)
- **Analytical Queries** - Detection range by azimuth, hourly heatmaps, time distribution histograms, spatial bounding box queries
- **Import / Export** - Merge external databases with deduplication, live export without stopping writes
- **Live Sharing over Quack** - Expose the running database over DuckDB's client/server
  protocol so other DuckDB clients can `ATTACH` while recording continues
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
    db_path: Some("adsb_history.db".into()),  // None for in-memory
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

### Sharing the database over Quack

Embedded DuckDB holds an **exclusive file lock**, so while this crate owns the
database nothing else can read it. [Quack](https://duckdb.org/docs/current/quack/overview)
turns the running instance into an HTTP server that other DuckDB clients can
`ATTACH` to — **while recording continues**. The engine stays the sole owner and
the only writer; clients are just clients.

```rust
let info = storage.start_sharing().await?;
println!("ATTACH '{}' AS adsb (TOKEN '{}');", info.listen_uri, info.token);

// ... later
storage.stop_sharing().await?;
```

From any other DuckDB client:

```sql
ATTACH 'quack:localhost:9494' AS adsb (TOKEN '<token>');
SELECT count(*) FROM adsb.positions;
```

See [`docs/quack_client_example.ipynb`](docs/quack_client_example.ipynb) for a worked
Python example that plots aircraft-per-day and flights-per-day off the live tables.

#### Getting the token

The token is what a client authenticates with. There are three ways to obtain one,
depending on whether you need to know it in advance:

| How | Token | When to use |
|-----|-------|-------------|
| **Desktop app** — click **Share DB** in the metrics bar | Generated fresh, shown in a dialog and copied as a ready-to-paste `ATTACH` | Interactive use. Note it changes on every start, so a saved notebook will not reconnect after a restart |
| **`ADSB_SHARE_TOKEN=<token>`** | Yours, pre-seeded | You want a stable token (a notebook you re-run, a scripted client) but still want a deliberate click before the database is exposed |
| **`ADSB_SHARE_AUTO_START=1`** (with `ADSB_SHARE_TOKEN`) | Yours | Headless or always-on: share as soon as storage opens, no click |

Environment variables read by the desktop app at startup:

| Variable | Default | Effect |
|----------|---------|--------|
| `ADSB_SHARE_AUTO_START` | off | Start sharing as soon as storage opens (`1`/`true`/`yes`/`on`) |
| `ADSB_SHARE_URI` | `quack:localhost` | Bind URI; port defaults to 9494 |
| `ADSB_SHARE_TOKEN` | generated | Use this token instead of a generated one. Blank generates one |
| `ADSB_SHARE_ALLOW_OTHER_HOSTNAME` | off | Permit a non-local bind |

Sharing stays **off** unless at least one variable is set or the UI toggle is used.
Embedding this crate directly? Set `StorageConfig.share` to a `ShareConfig`; the
environment variables above are the desktop app's way of populating it.

#### Two things to know

**The `quack` extension is fetched at runtime.** It is *not* statically linked into
the bundled DuckDB build, so the first use downloads it from `extensions.duckdb.org`.
Offline, `start_sharing` fails and `sharing_status` reports
`ShareStatus::Unavailable { reason }` — storage keeps working; sharing is never fatal.

**A token grants full read *and write* access to every table.** The server runs with
Quack's default permissive authorization; Quack's authorization hook is a SQL macro,
and macros cannot execute DML, so table-level rules are not expressible without
shipping a custom DuckDB extension. The server also does **no TLS** of its own, and
DuckDB refuses a non-local bind unless `ADSB_SHARE_ALLOW_OTHER_HOSTNAME` is set — anything
off-host should be fronted by a TLS-terminating reverse proxy. Treat the token as a credential.

> Quack is **beta** until DuckDB 2.0. Keep client and server on the same DuckDB
> version — the protocol may still change between releases.

### Key Types

| Type | Purpose |
|------|---------|
| `StorageHandle` | Thread-safe DuckDB wrapper (cloneable `Arc<Mutex>`) |
| `AircraftPosition` | Parsed SBS-1 message with optional fields |
| `StorageConfig` | Database path, source ID, gap threshold, optional sharing |
| `ShareConfig` | Quack bind URI, token, `auto_start` |
| `ShareInfo` | Live server coordinates: `listen_uri`, `listen_url`, `token` |
| `ShareStatus` | `Off` / `Active(ShareInfo)` / `Unavailable { reason }` |
| `BboxQuery` | Spatial + temporal window query |
| `TrajectoryQuery` | Single aircraft path reconstruction |
| `FlightSummary` | Pre-computed flight segment stats |
| `StorageStats` | Row counts, DB size, timestamp bounds |
| `StatusEvent` | Operational audit trail entry |
| `EventOfInterest` | User/system annotation with spatial bounds |

## Database Schema

Seven tables with targeted indexes:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| **positions** | Core fact table | hex_ident, lat, lon, altitude, timestamp_ms |
| **raw_messages** | SBS-1 audit trail | hex_ident, msg_type, raw_message, timestamp_ms |
| **flights** | Pre-computed segments | flight_id, hex_ident, flight_num, position_count, first/last_seen_ms |
| **status_events** | Operational log | event_type, status, detail, timestamp_ms |
| **events_of_interest** | User annotations | title, description, lat/lon, bbox, category |
| **scenarios** | Named simulation scenarios | id, name, description, origin, tags |
| **scenario_tracks** | Tracks within a scenario | scenario_id, hex_ident, callsign, waypoints_json, start_offset_s |

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

### Sharing
- `start_sharing` / `stop_sharing` - Expose or withdraw the database over Quack (idempotent)
- `sharing_status` - `Off` / `Active(ShareInfo)` / `Unavailable { reason }`

## Design Decisions

**Dual API surface** - Every query has a `*_sync()` method (direct, blocking) and an async wrapper using `tokio::spawn_blocking`. DuckDB's C FFI is synchronous; the async layer exists for scheduler fairness in Tokio runtimes.

**Incremental flight tracking** - Flights are computed on insert, not on query. An in-memory `HashMap<hex_ident, ActiveFlight>` tracks the latest flight per aircraft with O(1) gap detection. On open, the tracker is rebuilt from existing flight data.

**Arrow serialization** - Methods suffixed `_arrow` return `Vec<u8>` (Arrow IPC stream). The desktop app frontend decodes these with zero-copy typed array views for large result sets.

**Exact `duckdb` pin, and `arrow` coupled to it** - `duckdb` is pinned with `=` rather
than a caret. The `quack` extension is not statically linked and is autoinstalled at
runtime, and extension binaries are keyed to the *exact* DuckDB build, so version drift
invalidates the cached extension. `arrow` must track the major that `duckdb` depends on:
`Statement::query_arrow` returns duckdb's own `RecordBatch`, and a skew resolves both
arrow versions into the lockfile where the types fail to unify.

**Timezone handling** - The parser preserves the original SBS-1 string timestamp. The storage layer converts to UTC epoch milliseconds using a configurable timezone (supports "Local", "UTC", or any IANA name). The expected format is `YYYY/MM/DD HH:MM:SS.mmm` — note the **space**, not the comma that separates the two fields in a raw SBS-1 line. An unparseable timestamp falls back to the current time rather than failing the batch (one malformed line must not stop ingestion) and logs a throttled warning.

## Testing

194 tests covering parsing, storage CRUD, flight tracking, sharing, analytics, and geodesic math:

```bash
cargo test -p adsb-data-engine                # All tests
cargo test -p adsb-data-engine sbs_parser     # Parser only
cargo test -p adsb-data-engine storage        # Storage only
```

| Module | Tests | Focus |
|--------|------:|-------|
| sbs_parser | 23 | MSG subtypes, edge cases, heartbeat filtering |
| storage | 154 | CRUD, incremental flights, import/export, analytics, Quack sharing |
| geo | 16 | Haversine distance, bearing calculation, sector mapping |
| share | 1 | SQL literal escaping for the Quack URI/token |

## Dependencies

| Crate | Purpose |
|-------|---------|
| [duckdb](https://crates.io/crates/duckdb) =1.10505.0 | Embedded OLAP database, DuckDB v1.5.5 (statically linked; pinned exactly — see below) |
| [arrow](https://crates.io/crates/arrow) 58 | IPC serialization for query results (must track duckdb's major) |
| [chrono](https://crates.io/crates/chrono) + chrono-tz | Timezone-aware timestamp conversion |
| [tokio](https://crates.io/crates/tokio) | Async wrappers via `spawn_blocking` |
| [uuid](https://crates.io/crates/uuid) | Auto-generated event IDs |
| [thiserror](https://crates.io/crates/thiserror) | Typed error handling |
