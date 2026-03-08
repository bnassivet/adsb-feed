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
└── storage.rs     DuckDB backend — schema, inserts, queries
```

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
| `get_trajectory` | `TrajectoryQuery` | `Vec<PositionRecord>` | All positions for a single aircraft by hex ident, ordered by timestamp. |
| `get_aircraft_summary` | `start_ms?, end_ms?` | `Vec<AircraftSummary>` | Per-aircraft aggregates: position count, first/last seen, altitude range. |
| `get_time_distribution` | `TimeDistributionQuery` | `Vec<TimeDistributionBucket>` | Message count histogram: divides the time range into N equal buckets. |
| `get_detection_range` | `DetectionRangeQuery` | `Vec<DetectionRangeSector>` | Max detection range by bearing sector (see below). Always returns 36 sectors. |
| `get_hourly_heatmap` | `HourlyHeatmapQuery` | `Vec<HourlyHeatmapCell>` | Activity grid: distinct aircraft count and message count per (calendar day × hour). |
| `get_stats` | — | `StorageStats` | Row counts, database file size, oldest/newest timestamps. |
| `prune` | `older_than_ms: i64` | `u64` (deleted count) | Delete positions and raw messages older than the given timestamp. |
| `query_raw_messages` | `RawMessageQuery` | `Vec<RawSbsRecord>` | Raw SBS-1 lines for a specific aircraft and time window (limit 10 000). |
| `get_raw_message_count` | `start_ms?, end_ms?` | `u64` | Count raw messages in optional time window. |

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

The Tauri `AppState` holds `storage: Option<StorageHandle>`. If DuckDB fails to open (e.g., disk full, permission error), `storage` is `None` and all storage-backed Tauri commands return the string `"Storage not available"`. The application continues to operate in real-time-only mode — live aircraft tracks are still visible, historical queries are disabled.

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

The crate ships approximately 60 tests across all modules, following TDD conventions.

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

---

## Dependency Summary

| Dependency | Version | Role |
|------------|---------|------|
| `duckdb` | 1.2 (bundled) | Embedded OLAP database; statically linked, no system dependency |
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
          │
          ▼
   Tauri commands → Frontend (React / Next.js)
```
