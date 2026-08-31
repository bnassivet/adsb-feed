# adsb-data-engine — Design Document

## Purpose

`adsb-data-engine` is a shared Rust library that provides two capabilities to the ADS-B desktop application:

1. **SBS-1 message parsing** — decoding the CSV-based BaseStation format emitted by dump1090
2. **Persistent storage and query** — writing parsed aircraft positions to a local DuckDB database and answering historical queries from the frontend

It is a workspace crate consumed by the Tauri backend (`adsb-pulsar-client-desktop/src-tauri`). It has no Tauri or async dependency itself; async ergonomics are provided through thin wrappers using `tokio::task::spawn_blocking`.

---

## Module Map

```
adsb-data-engine/src/
├── lib.rs         Public re-exports (the crate's surface area)
├── error.rs       StorageError enum
├── types.rs       Domain types — queries and results
├── sbs_parser.rs  SBS-1 CSV parser
├── geo.rs         Geodesic math (haversine, bearing, sectors)
├── share.rs       Quack server — expose the DB to other DuckDB clients
└── storage.rs     DuckDB backend — schema, inserts, queries
```

> **Sharing the live database.** Embedded DuckDB holds an exclusive file lock, so
> nothing else can read the database while the engine owns it. `share.rs` wraps
> `quack_serve()` so other DuckDB clients can `ATTACH` over HTTP *while recording
> continues* — the engine stays the sole owner and sole writer.
> [`quack_client_example.ipynb`](quack_client_example.ipynb) is a worked example:
> it attaches from a plain Python DuckDB session and plots aircraft-per-day and
> flights-per-day histograms straight off the live tables.

---

## SBS-1 Parser (`sbs_parser.rs`)

### Message Format

SBS-1 (BaseStation) is a 22-field comma-separated text format emitted by dump1090 over TCP:

```
MSG,<tx_type>,<session>,<aircraft>,<hex_ident>,<flight>,<date_gen>,<time_gen>,<date_log>,<time_log>,<callsign>,<altitude>,<ground_speed>,<track>,<lat>,<lon>,<vertical_rate>,<squawk>,<alert>,<emergency>,<spi>,<is_on_ground>
```

Field indices used by the parser:

| Index | Field | Notes |
|-------|-------|-------|
| 0 | Message type | Must be `"MSG"` |
| 1 | Transmission type | 1–8; determines which fields are populated |
| 4 | Hex ident | ICAO 24-bit address (6 hex chars) |
| 6 | Date generated | `YYYY/MM/DD` |
| 7 | Time generated | `HH:MM:SS.mmm` |
| 10 | Callsign | |
| 11 | Altitude | feet |
| 12 | Ground speed | knots |
| 13 | Track | heading degrees |
| 14 | Latitude | |
| 15 | Longitude | |
| 16 | Vertical rate | feet/min |
| 17 | Squawk | 4-digit octal |
| 21 | Is on ground | `"-1"` / `"0"` / `"1"` |

### Public Functions

```rust
/// Parse a full SBS-1 line into a structured AircraftPosition.
pub fn parse_sbs_message(line: &str) -> Option<AircraftPosition>

/// Lightweight extraction: returns (hex_ident, msg_type_string, transmission_type).
pub fn parse_sbs_raw_fields(line: &str) -> Option<(String, String, Option<u8>)>

/// Extract the timestamp string "YYYY/MM/DD HH:MM:SS.mmm" from fields 6+7.
pub fn extract_sbs_timestamp(line: &str) -> Option<String>
```

### Filtering Rules

All three functions apply the same guard rules:

- Lines that do not start with `MSG,` are silently skipped
- Lines with fewer than 22 fields are silently skipped
- Empty hex ident → skip
- Hex ident `"000000"` → skip (receiver heartbeat, not an aircraft)

Missing optional fields (e.g., no position in a MSG type 1) are represented as `None` in the parsed struct — never as zero or an error.

---

## Geodesic Math (`geo.rs`)

Pure Rust reference implementations of geodetic computations. These are used in tests and available for future Rust-side analysis. The production detection-range query runs these computations inside DuckDB SQL for vectorized execution.

```rust
pub fn haversine_nm(lat1, lon1, lat2, lon2) -> f64
pub fn initial_bearing_deg(lat1, lon1, lat2, lon2) -> f64
pub fn bearing_to_sector(bearing_deg: f64) -> usize  // 0..35, each covers 10°
```

`bearing_to_sector` maps bearings to 36 equal sectors where sector 0 covers North ([355°, 5°)).

---

## Storage Backend (`storage.rs`)

### Architecture

```
StorageHandle          (Arc<Mutex<Storage>>, Clone-able)
  └── Storage
       └── conn: duckdb::Connection   (not Send — protected by Mutex)
```

`StorageHandle` is the public handle. It is `Clone` and `Send + Sync`. All callers share the same underlying `Connection` through the `Arc<Mutex<>>`. This ensures serialized access, which is required because `duckdb::Connection` is not thread-safe.

### Database Schema

Two tables are created on first open:

```sql
-- Parsed aircraft positions (primary query target)
CREATE TABLE IF NOT EXISTS positions (
    hex_ident      TEXT    NOT NULL,
    callsign       TEXT,
    latitude       DOUBLE,
    longitude      DOUBLE,
    altitude       DOUBLE,
    ground_speed   DOUBLE,
    track          DOUBLE,
    vertical_rate  DOUBLE,
    squawk         TEXT,
    is_on_ground   BOOLEAN,
    timestamp_ms   BIGINT  NOT NULL,
    source_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_ts     ON positions (timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_positions_hex_ts ON positions (hex_ident, timestamp_ms);

-- Raw SBS-1 messages for audit and replay
CREATE TABLE IF NOT EXISTS raw_messages (
    hex_ident         TEXT   NOT NULL,
    msg_type          TEXT,
    transmission_type INTEGER,
    timestamp_ms      BIGINT NOT NULL,
    raw_message       TEXT   NOT NULL,
    source_id         TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_msgs_ts     ON raw_messages (timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_raw_msgs_hex_ts ON raw_messages (hex_ident, timestamp_ms);
```

All timestamps are stored as `BIGINT` UTC epoch milliseconds. Conversion from SBS-1 timestamp strings happens at insert time.

### API Convention — Sync vs Async

The library exposes every operation at two levels:

| Level | Naming | Usage |
|-------|--------|-------|
| Synchronous | `method_name_sync()` | Call directly from a blocking context |
| Async wrapper | `method_name()` | Calls `tokio::task::spawn_blocking` internally; for use from async Tauri commands |

This layering keeps the library free of `async fn` in its core logic while being convenient to call from an async runtime.

### Write Path

The Tauri bridge buffers incoming `AircraftPosition` and `RawSbsRecord` structs in memory and flushes them to DuckDB every 500 ms:

```
SBS-1 TCP stream
  → parse_sbs_message / parse_sbs_raw_fields
  → HashMap<hex_ident, AircraftPosition> (in-memory buffer)
  → every 500 ms: insert_batch() + insert_raw_batch()
  → DuckDB positions + raw_messages tables
```

Inserts use DuckDB's `Appender` API for efficient bulk loading. Failure is non-fatal; the bridge logs a warning and continues.

### Timestamp Resolution

```rust
fn parse_timestamp_to_ms(timestamp: &str, tz: &str) -> i64
```

SBS-1 timestamps are wall-clock strings without timezone information. The `tz` parameter controls interpretation:

| Value | Behaviour |
|-------|-----------|
| `"UTC"` | Interpret as UTC |
| `"Local"` | Interpret as the machine's local timezone |
| IANA string (e.g. `"Europe/Paris"`) | Resolve via `chrono-tz` |
| Unknown IANA string | Warn and fall back to Local |

The stored value is always UTC epoch milliseconds regardless of input timezone.

### Query Operations

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `query_bbox` | `BboxQuery` | `Vec<PositionRecord>` | Positions within a geographic bounding box, optional time window, configurable limit. Only rows with non-NULL lat/lon are returned. |
| `query_bbox_arrow` | `BboxQuery` | `Vec<u8>` (IPC) | Same as `query_bbox` but returns Arrow IPC bytes (see [Arrow IPC Helper](#arrow-ipc-helper)). |
| `get_trajectory` | `TrajectoryQuery` | `Vec<PositionRecord>` | All positions for a single aircraft by hex ident, ordered by timestamp. |
| `get_trajectories_batch_arrow` | `Vec<(TrajectoryQuery, flight_id)>` | `Vec<u8>` (IPC) | Batch trajectory query — executes multiple queries, concatenates results into a single IPC stream with a `flight_id` column to tag each query's rows. |
| `get_aircraft_summary` | `start_ms?, end_ms?` | `Vec<AircraftSummary>` | Per-aircraft aggregates: position count, first/last seen, altitude range. |
| `get_flight_summary` | `FlightSummaryQuery` | `Vec<FlightSummary>` | Per-flight statistics from the `flights` table (hex_ident, flight_num, flight_id, callsign, position_count, first/last seen, altitude range). |
| `get_flight_summary_arrow` | `FlightSummaryQuery` | `Vec<u8>` (IPC) | Same as `get_flight_summary` but returns Arrow IPC bytes. |
| `get_time_distribution` | `TimeDistributionQuery` | `Vec<TimeDistributionBucket>` | Histogram over time: divides the range into N equal buckets. The `metric` field selects what to count — `Positions` (default, `COUNT(*)` on `positions`), `Aircraft` (`COUNT(DISTINCT hex_ident)` on `positions`), or `RawMessages` (`COUNT(*)` on `raw_messages`). |
| `get_detection_range` | `DetectionRangeQuery` | `Vec<DetectionRangeSector>` | Max detection range by bearing sector (see below). Always returns 36 sectors. |
| `get_hourly_heatmap` | `HourlyHeatmapQuery` | `Vec<HourlyHeatmapCell>` | Activity grid: distinct aircraft count and message count per (calendar day × hour). |
| `get_stats` | — | `StorageStats` | Row counts, database file size, oldest/newest timestamps. |
| `prune` | `older_than_ms: i64` | `u64` (deleted count) | Delete positions and raw messages older than the given timestamp. |
| `query_raw_messages` | `RawMessageQuery` | `Vec<RawSbsRecord>` | Raw SBS-1 lines for a specific aircraft and time window (limit 10 000). |
| `get_raw_messages_arrow` | `RawMessageQuery` | `Vec<u8>` (IPC) | Same as `query_raw_messages` but returns Arrow IPC bytes. |
| `get_raw_message_count` | `start_ms?, end_ms?` | `u64` | Count raw messages in optional time window. |
| `checkpoint` | — | `()` | Flush the WAL to disk (`CHECKPOINT`). Called before releasing the connection or exporting. |
| `export_database` | `target_path: PathBuf` | `()` | Copy both tables to a new DuckDB file via `ATTACH` + `CREATE TABLE AS` + `DETACH`. Runs within the active connection — recording continues uninterrupted. Overwrites target if it exists; creates parent directories as needed. |

### Free Functions

| Function | Parameters | Returns | Description |
|----------|-----------|---------|-------------|
| `move_database_to_snapshot` | `db_path: &Path, snapshot_path: &Path` | `Result<(), StorageError>` | Rename a closed database file (and its WAL if present) to a snapshot path. Creates parent directories for the snapshot. The DuckDB connection **must be closed** before calling — this is a file-level operation, not a connection-level one. Used by the Tauri `swap_database` command for zero-loss database rotation. |

### Detection Range Query (Advanced)

The detection range query computes the maximum range at which aircraft were observed from a receiver position, broken down by compass bearing in 10° sectors.

The computation is done **entirely in SQL** using trigonometric functions, rather than fetching all positions and computing in Rust:

```sql
WITH bearing_distance AS (
    SELECT
        degrees(atan2(
            sin(radians(longitude - ?)) * cos(radians(latitude)),
            cos(radians(?)) * sin(radians(latitude)) -
            sin(radians(?)) * cos(radians(latitude)) * cos(radians(longitude - ?))
        )) % 360 AS bearing_deg,
        acos(LEAST(1.0,
            sin(radians(?)) * sin(radians(latitude)) +
            cos(radians(?)) * cos(radians(latitude)) * cos(radians(longitude - ?))
        )) * 3440.065 AS distance_nm,
        altitude
    FROM positions
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL ...
),
sectors AS (
    SELECT
        CAST(((bearing_deg + 5) % 360) / 10 AS INTEGER) AS sector_idx,
        MAX(distance_nm) AS max_distance_nm,
        COUNT(*) AS position_count,
        MIN(altitude) AS min_altitude,
        MAX(altitude) AS max_altitude
    FROM bearing_distance
    GROUP BY sector_idx
)
```

Missing sectors are filled with zero-distance entries in Rust after the query, so the result is always exactly 36 sectors (indices 0–35, where sector 0 = North, each covering 10°).

This design minimises the amount of data crossing the `Mutex` boundary (at most 36 rows) even when the `positions` table contains millions of rows.

### Arrow IPC Helper

Query methods with an `_arrow` suffix return `Vec<u8>` containing an Apache Arrow IPC stream instead of deserialized Rust structs. This leverages DuckDB's native `query_arrow()` which returns `RecordBatch` objects — zero-copy views into DuckDB's columnar storage.

All Arrow methods share a common private helper:

```rust
fn write_arrow_ipc(batches: impl Iterator<Item = RecordBatch>) -> Result<Vec<u8>, StorageError> {
    let mut buf = Vec::new();
    let mut writer: Option<StreamWriter<&mut Vec<u8>>> = None;
    for batch in batches {
        if writer.is_none() {
            writer = Some(StreamWriter::try_new(&mut buf, &batch.schema())?);
        }
        writer.as_mut().unwrap().write(&batch)?;
    }
    if let Some(w) = writer.as_mut() { w.finish()?; }
    Ok(buf)
}
```

The writer is lazily initialized from the first batch's schema, which handles the empty-result case (zero batches → empty `Vec<u8>`). Each `_arrow_sync` method simply prepares its SQL, calls `stmt.query_arrow(params)`, and passes the result iterator to `write_arrow_ipc`.

The batch trajectory variant (`get_trajectories_batch_arrow_sync`) is special: it executes multiple queries and injects a `flight_id` column into each `RecordBatch` before writing, so the frontend can partition results by flight.

**Performance**: Arrow IPC avoids the `query_map()` → `Vec<T>` → serde JSON serialization chain. On the browser side, `tableFromIPC()` creates typed array views over the IPC buffer with no per-row object allocation. Measured improvements: ~4x smaller wire size, ~5x faster browser parsing.

---

## Error Handling

```rust
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("DuckDB error: {0}")]
    DuckDb(#[from] duckdb::Error),

    #[error("Query error: {0}")]
    Query(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}
```

All public methods return `Result<T, StorageError>`. The Tauri command layer maps these to string errors returned to the frontend.

---

## Graceful Degradation

The Tauri `AppState` holds `storage: SharedStorage` (`Arc<RwLock<Option<StorageHandle>>>`). The storage is `None` when DuckDB fails to open (e.g., disk full, permission error) or when the user explicitly releases the connection for external tool access. In either case, all storage-backed Tauri commands return `"Storage not available"`. The application continues to operate in real-time-only mode — live aircraft tracks are still visible, historical queries are disabled. A released connection can be reclaimed at runtime using the retained `StorageConfig`.

---

## Configuration

```rust
pub struct StorageConfig {
    /// Path to the DuckDB database file.
    /// None opens an in-memory database (used in tests).
    pub db_path: Option<String>,

    /// Source identifier stamped on every inserted row.
    pub source_id: String,
}
```

The database file location is controlled by the Tauri app. By default it is placed in the platform-specific app data directory (resolved via `tauri::api::path::app_data_dir`).

---

## Testing Strategy

The crate ships approximately 113 tests across all modules, following TDD conventions.

### Parser Tests (`sbs_parser.rs`)

- One test per MSG transmission type (1–8) verifying field extraction
- Edge cases: empty hex ident, `"000000"` heartbeat, missing coordinates, invalid numbers
- Whitespace trimming, boolean field parsing (`"-1"` / `"0"` / `"1"`)

### Geodesic Tests (`geo.rs`)

- Haversine validated against the known JFK→LHR distance (~2999 NM)
- Cardinal bearings (N, E, S, W) tested exactly
- Sector boundary conditions including the 355°–5° wrap-around at North

### Storage Tests (`storage.rs`)

All storage tests use in-memory DuckDB (`db_path: None`) for speed and isolation:

- Batch insert and retrieval round-trip
- Timezone conversion (UTC, Local, `"Europe/Paris"`)
- Bounding box queries with and without time windows
- NULL coordinate filtering (positions without lat/lon excluded from bbox results)
- Single-aircraft trajectory retrieval and ordering
- Aircraft summary aggregation
- Pruning old records
- Time distribution bucketing
- Detection range sector assignment, max distance tracking, altitude ranges
- Hourly heatmap day/hour grouping
- Raw message insert and query
- `Arc` cloning — two handles sharing the same connection
- `source_id` propagation
- Checkpoint on in-memory and file-backed databases
- Export to tempfile: creates valid copy with both tables and correct row counts
- Export overwrites existing target, creates parent directories
- Original database still functional after export
- Arrow IPC: `get_flight_summary_arrow`, `query_bbox_arrow`, `get_raw_messages_arrow`, and `get_trajectories_batch_arrow` return valid IPC streams with correct column counts and row data

---

## Dependency Summary

| Dependency | Version | Role |
|------------|---------|------|
| `duckdb` | 1.2 (bundled) | Embedded OLAP database; statically linked, no system dependency |
| `arrow` | 56 | Arrow IPC serialization (`StreamWriter`, `RecordBatch`) for `_arrow` query variants |
| `tokio` | workspace | Async runtime for `spawn_blocking` wrappers |
| `serde` / `serde_json` | workspace | Serialization of types for Tauri IPC |
| `chrono` / `chrono-tz` | workspace | Timezone-aware timestamp parsing |
| `tracing` | workspace | Structured logging |
| `thiserror` | workspace | Error type derivation |

DuckDB is statically linked (`features = ["bundled"]`). No system-level DuckDB installation is required.

---

## Data Flow Diagram

```
dump1090 TCP stream (SBS-1 text)
          │
          ▼
   parse_sbs_message()          parse_sbs_raw_fields()
   AircraftPosition              RawSbsRecord
          │                            │
          └────────────┬───────────────┘
                       │  (buffered 500 ms in bridge.rs)
                       ▼
              StorageHandle::insert_batch()
              StorageHandle::insert_raw_batch()
                       │
                       ▼
              DuckDB (positions + raw_messages)
                       │
          ┌────────────┼────────────────────────────┐
          ▼            ▼                            ▼
    query_bbox   get_trajectory          get_detection_range
    get_hourly_heatmap                  get_time_distribution
    get_aircraft_summary                get_stats / prune
    get_flight_summary                  checkpoint / export_database
    *_arrow variants (IPC bytes)        move_database_to_snapshot
          │
          ▼
   Tauri commands → Frontend (React / Next.js)
```


---

## Ingest pipeline (`src/ingest.rs`)

The parse → merge → throttle → persist path that turns a stream of raw SBS-1 lines into
`AircraftPosition` batches.

It lives in the data engine rather than in any one consumer because **two** processes need
it and they must not drift: the Tauri desktop app and the headless `adsb-data-server` daemon
on the Raspberry Pi. The only thing the two disagree about is what to do with a flushed
batch — the desktop emits it to the webview, the daemon has already persisted it and
discards it — so that single difference is abstracted behind `BatchSink`.

```
broadcast::Receiver<Vec<u8>>          IngestPipeline
   raw SBS-1 lines          ─────►  parse ─► merge by hex_ident ─► flush every 500ms
                                                                      │
                                                    ┌─────────────────┴──────────────┐
                                                    ▼                                ▼
                                          DuckDB insert_batch                  BatchSink
                                          + insert_raw_batch            EmitSink  |  NoopSink
                                          (gated, non-fatal)            desktop   |  daemon
```

| Item | Purpose |
|------|---------|
| `IngestPipeline` | Owns the buffers and the flush loop; `run(rx, sink)` until the channel closes |
| `IngestConfig` | `source_id`, `dump1090_tz`, `flush_interval` |
| `BatchSink` | Receives each flushed batch. `NoopSink` provided for headless use |
| `SharedStorage` | `Arc<RwLock<Option<StorageHandle>>>` — `None` means writes are silently skipped |
| `merge_into_buffer` | Field-preserving merge across SBS-1 message subtypes |

### Why the buffer merges rather than inserts

SBS-1 splits one aircraft's state across message subtypes: MSG1 carries the callsign, MSG3
the position, MSG4 the speed. A blind `HashMap::insert` would overwrite a MSG3's
latitude/longitude with the `None`s of a MSG1 arriving later in the same flush window.
`merge_into_buffer` keeps the best-known state per aircraft — which is why it is the most
test-covered function in the module.

### Design notes

- **Persistence is non-fatal and gated.** `record_positions` / `record_raw` are
  caller-owned `AtomicBool`s so a UI can toggle recording at runtime, and a `None` storage
  handle (released or unavailable) silently drops the batch. The live feed must never stall
  on the recorder.
- **The sink is not gated by the recording toggles.** They gate DuckDB writes only; the
  live UI feed continues regardless.
- **Raw records are captured before position parsing**, so a line that fails to parse into a
  position is still recoverable from the archive.
- **Every raw record carries `source_id`.** The desktop previously wrote an empty string,
  which makes receivers indistinguishable in a multi-node fleet.


---

## Remote mode (`StorageConfig::remote`)

`StorageHandle::open` has two modes, chosen by explicit configuration:

| Mode | `remote` | Observed tables | Authored tables |
|---|---|---|---|
| Embedded | `None` | local, owned by this process | local |
| Remote | `Some(..)` | **views** over an attached daemon's catalog | local |

*Observed* means `positions`, `raw_messages`, `flights`, `status_events` — data
recorded from a live feed. *Authored* means `events_of_interest`, `scenarios`,
`scenario_tracks` — written by whoever is using the app, so they stay local in
both modes.

### The view trick

Remote mode runs:

```sql
ATTACH 'quack:pi.lan:9494' AS edge (TYPE quack, TOKEN '…', DISABLE_SSL true);
CREATE OR REPLACE VIEW positions AS SELECT * FROM edge.positions;   -- and the rest
```

Because the views take the **same names** the queries already use, the entire
read path works against a remote daemon **unmodified**. No query routing layer,
no per-table dispatch, no changes to any of the existing query SQL.

`SCHEMA_OBSERVED_SQL` is deliberately *not* executed in remote mode: if the real
tables existed, the views could not take those names, and dropping them to make
room would destroy a user's local history. For the same reason the desktop app
uses a **separate file** (`adsb_local.db`) in remote mode and leaves
`adsb_history.db` untouched.

### Ingest bootstrap is skipped

`bootstrap_flights_sync` INSERTs into `flights` by scanning `positions`. Against
an attached catalog that is a write to tables the daemon owns — and Quack
rejects it outright:

```
Not implemented Error: Multiple streaming scans or streaming scans + CTAS /
insert in the same query are not currently supported
```

The flight tracker is likewise only consulted when assigning `flight_id` during
`insert_batch`, which a remote client never performs. Both are skipped when
`remote.is_some()`. This is the design doc's "server is the sole write
authority" constraint showing up as a runtime error rather than a rule.

### TLS posture

The Quack server terminates no TLS, but the *client* defaults `DISABLE_SSL` to
false for any non-local URI — i.e. it assumes HTTPS. `attach_sql` therefore sets
`DISABLE_SSL true` for remote hosts. Needing that flag is the signal that a
deployment is missing its reverse proxy. A token also grants full read **and**
write on every table, so this is homelab-grade on a trusted LAN.

### Verifying it

`cargo run -p adsb-data-engine --example remote_probe -- quack:host:9494 TOKEN`
opens storage in remote mode, reads through the views and confirms the local
authored tables are still reachable.
