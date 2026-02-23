# Data Engine as a Service — Architecture Analysis

**Document Type:** Architecture Analysis & Design Document
**Date:** February 19, 2026
**Status:** Draft — L1 Design Phase
**Stack:** Rust + DuckDB (hybrid) + Apache Pulsar + Protobuf + MQTT

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Core Engine: Polars vs DuckDB Analysis](#3-core-engine-polars-vs-duckdb-analysis)
4. [DuckDB Source Ecosystem](#4-duckdb-source-ecosystem)
5. [Connector Framework](#5-connector-framework)
6. [Messaging & Transport Layer](#6-messaging--transport-layer)
7. [Geospatial Data Handling](#7-geospatial-data-handling)
8. [Protobuf Schema Design](#8-protobuf-schema-design)
9. [Arrow End-to-End Strategy](#9-arrow-end-to-end-strategy)
10. [End-to-End Data Pipeline](#10-end-to-end-data-pipeline)
11. [Project Structure & Crate Map](#11-project-structure--crate-map)
12. [Phased Delivery Plan](#12-phased-delivery-plan)
13. [Key Design Decisions](#13-key-design-decisions)
14. [Risks & Caveats](#14-risks--caveats)

---

## 1. Executive Summary

This document describes the architecture for a **Data Engine as a Service** — a Rust-based system that ingests real-time data (including geospatial telemetry), stores it efficiently, and exposes analytical query capabilities via a service API. The system is designed to support remote IoT devices over constrained internet connections as well as higher-bandwidth internal sources.

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Core language | **Rust** | Memory safety, performance, zero-cost abstractions |
| Query/Storage engine | **DuckDB (embedded)** with Rust ingestion hot path | Full SQL, spatial extension, persistence, crash recovery — reduces custom code by ~60% vs pure Polars |
| Message broker | **Apache Pulsar** | Multi-protocol support (MQTT, WebSocket, Kafka, AMQP) via pluggable protocol handlers — one broker, one connector |
| Wire protocol (device edge) | **Protobuf** | 3–10× smaller than JSON, compile-time schema enforcement, Rust-native via `prost` |
| IoT transport | **MQTT** (via Pulsar MoP) | Purpose-built for constrained devices, QoS levels, persistent sessions, minimal wire overhead |
| Internal data format | **Apache Arrow** | End-to-end from connector through engine to client — zero-copy at every boundary |
| Client query API | **Arrow Flight** (gRPC + Arrow IPC) | Zero ser/deser on query path, streaming results, rich client ecosystem (Python, Java, Go, Rust) |
| Storage at rest | **Parquet** | Arrow-columnar on disk with compression, predicate pushdown, DuckDB-native |

---

## 2. System Overview

### High-Level Architecture

```
Remote IoT Devices              Web/Browser Clients         Kafka/AMQP Producers
(constrained, cellular)         (dashboards, apps)          (internal systems)
       │                               │                           │
  MQTT (QoS 1)                   WebSocket (WSS)              Kafka / AMQP
  port 8883                      port 443                    native protocols
       │                               │                           │
       └───────────────────┬───────────┴───────────────────────────┘
                           │
                ┌──────────▼──────────────┐
                │     Apache Pulsar       │
                │                         │
                │  ┌─────┐ ┌────┐ ┌────┐  │
                │  │ MoP │ │ WS │ │KoP │  │
                │  │MQTT │ │API │ │Kafka│  │
                │  └──┬──┘ └─┬──┘ └─┬──┘  │
                │     └──────┼──────┘     │
                │      Pulsar Topics      │
                └──────────┬──────────────┘
                           │
                    Pulsar native protocol
                           │
                ┌──────────▼──────────────┐
                │  Rust Data Engine        │
                │                          │
                │  ┌───────────────────┐   │
                │  │ Connector Layer   │   │
                │  │ (connector-pulsar)│   │
                │  └────────┬──────────┘   │
                │           │              │
                │  ┌────────▼──────────┐   │
                │  │ Ingestion Engine  │   │
                │  │ Protobuf decode   │   │
                │  │ Deduplication     │   │
                │  │ Arrow RecordBatch │   │
                │  └────────┬──────────┘   │
                │           │              │
                │  ┌────────▼──────────┐   │
                │  │ Data Store Mgr    │   │
                │  │ Hot: Arrow bufs   │   │
                │  │ Warm: DuckDB      │   │
                │  │ Cold: S3/Parquet  │   │
                │  └────────┬──────────┘   │
                │           │              │
                │  ┌────────▼──────────┐   │
                │  │ Query Engine      │   │
                │  │ DuckDB (embedded) │   │
                │  │ SQL + Spatial     │   │
                │  └────────┬──────────┘   │
                │           │              │
                │  ┌────────▼──────────┐   │
                │  │ API Layer         │   │
                │  │ Arrow Flight :8815│   │
                │  │  (query + ingest) │   │
                │  │ REST (Axum) :8080 │   │
                │  │  (admin + mgmt)   │   │
                │  └───────────────────┘   │
                └──────────────────────────┘
                           │
                           ▼
                  Clients / Consumers
           (Arrow Flight: pyarrow, polars, DuckDB)
              (REST: web apps, dashboards)
```

---

## 3. Core Engine: Polars vs DuckDB Analysis

### Initial Consideration: Polars

Polars was initially considered as the core analytical engine. It is an excellent Rust-native DataFrame library — columnar (Arrow-based), with lazy evaluation for query optimization and strong performance on analytical workloads.

However, for this use case, Polars would require building significant infrastructure manually: spatial indexing, persistence/WAL, crash recovery, concurrent access management, SQL support, and a data catalog.

### Decision: DuckDB (Hybrid Approach)

DuckDB is an embedded OLAP database that provides much of this infrastructure out of the box. The hybrid approach retains Rust for the hot ingestion path while delegating storage, indexing, and query execution to DuckDB.

### Comparison Matrix

| Concern | Polars | DuckDB | Winner for This Use Case |
|---------|--------|--------|--------------------------|
| Geo/spatial queries | Build it yourself (R-tree + H3 sidecar) | `LOAD spatial;` — built-in | **DuckDB** |
| Time to L1 MVP | 8–12 weeks | 4–6 weeks | **DuckDB** |
| SQL support | `polars-sql` — functional, gaps on complex queries | Full-featured, battle-tested | **DuckDB** |
| Programmatic query building | Excellent (LazyFrame is first-class Rust) | String SQL or query builder libs | **Polars** |
| Real-time ingest latency | Sub-ms (direct Arrow buffer append) | ~1-5ms (DuckDB insert path) | **Polars** |
| Rust-nativeness | Pure Rust, no FFI | C++ via FFI | **Polars** |
| Persistence / crash recovery | Build it yourself | Built-in WAL + ACID | **DuckDB** |
| Memory control | Full control, predictable | DuckDB buffer pool, less transparent | **Polars** |
| Concurrent access | Design it yourself | Single writer, multiple readers — handled | **DuckDB** |

### Hybrid Architecture

The selected approach uses Rust for the ultra-low-latency ingestion path (Arrow buffers) and DuckDB for storage, spatial queries, SQL execution, and persistence:

```
Ingest path:   Event → Rust (sub-ms) → Arrow RecordBatch → Hot Buffer
Query path:    Hot buffer registered as DuckDB Arrow table (zero-copy)
               + Warm data in DuckDB persistent tables
               → UNION ALL → single SQL query across both tiers
Flush path:    Hot buffer → INSERT INTO warm DuckDB table → Parquet on disk
```

DuckDB can scan Arrow RecordBatches directly with zero copy via its Arrow interface. This means the hot buffer stays in pure Rust/Arrow, and DuckDB only touches the data at query time or flush time.

---

## 4. DuckDB Source Ecosystem

DuckDB's extension system provides broad data source support, which significantly simplifies the ingestion architecture. Instead of building custom connectors for every source, many can be handled by DuckDB natively.

### File Formats (Built-in or Core Extensions)

| Source | Extension | Read/Write | Notes |
|--------|-----------|------------|-------|
| Parquet | built-in | R/W | First-class. Predicate & projection pushdown, encryption |
| CSV / TSV | built-in | R/W | Auto-detection of delimiters, types, headers |
| JSON / NDJSON | `json` | R/W | Nested JSON, auto-schema detection |
| Arrow / IPC | `arrow` | R/W | Zero-copy interchange — key for Rust hot buffer |
| Avro | `avro` | R | Common in Kafka ecosystems |
| Excel (.xlsx) | `excel` | R/W | Enterprise data onboarding |

### Databases (Attach & Query Directly)

| Source | Extension | Mode | Notes |
|--------|-----------|------|-------|
| PostgreSQL | `postgres` | R/W | Attach and query as virtual tables, filter pushdown |
| MySQL | `mysql` | R/W | Same attach pattern |
| SQLite | `sqlite` | R/W | Direct file access, queryable at query time |

### Cloud & Object Storage

| Source | Extension | Notes |
|--------|-----------|-------|
| AWS S3 | `httpfs` + `aws` | Parquet/CSV/JSON directly from S3 |
| Azure Blob | `azure` | Azure-native auth |
| Google Cloud Storage | `httpfs` | Via S3-compatible API |
| Cloudflare R2 | `httpfs` | S3-compatible |
| HTTP/HTTPS | `httpfs` | Any publicly accessible file |

### Lakehouse Formats

| Source | Extension | Notes |
|--------|-----------|-------|
| Delta Lake | `delta` | Read Delta tables |
| Apache Iceberg | `iceberg` | REST catalogs, S3 Tables, AWS Glue |
| DuckLake | `ducklake` | DuckDB's ACID lakehouse format with time-travel |
| Unity Catalog | `unity_catalog` | Databricks integration |

### Specialized

| Source | Extension | Notes |
|--------|-----------|-------|
| Spatial (GDAL) | `spatial` | Shapefile, GeoJSON, GeoPackage, KML, 50+ formats. R-tree indexing, ST_* functions |
| Full-Text Search | `fts` | FTS indexes on DuckDB tables |
| Vector Similarity | `vss` | HNSW indexes for embeddings |

### Source Tier Classification

**Tier 1 — Native (DuckDB handles entirely):**
Parquet, CSV, JSON, Excel, S3/Azure/GCS, PostgreSQL, MySQL, SQLite, GeoJSON/Shapefile, Delta, Iceberg

**Tier 2 — Rust ingestion layer required:**
Real-time push (gRPC/HTTP streaming), Kafka, MQTT, Pulsar, custom IoT protocols

**Tier 3 — Future / community:**
WebSocket/Redis Pub/Sub, Snowflake, vector/ML pipelines

Note: Apache Pulsar is **not** natively supported by DuckDB (no core, community, or third-party extension exists). This is handled by the Rust connector layer.

---

## 5. Connector Framework

### Design Philosophy

The connector framework is a pluggable ingestion layer where each streaming source is a connector that normalizes data into Arrow RecordBatches. The key architectural principle is **separation of transport from serialization** — a Pulsar connector and a Kafka connector differ in how they receive bytes, but both might carry Protobuf-encoded messages.

### Core Trait

```rust
#[async_trait]
pub trait SourceConnector: Send + Sync + 'static {
    fn connector_type(&self) -> &str;
    fn validate_config(&self, config: ConnectorConfig) -> Result<ResolvedConfig>;
    async fn start(
        &self,
        config: ResolvedConfig,
        schema: Arc<Schema>,
        sink: BatchSink,
        shutdown: CancellationToken,
    ) -> Result<ConnectorHandle>;
    async fn health(&self, handle: &ConnectorHandle) -> ConnectorHealth;
}
```

### Transport × Serialization Separation

```rust
/// Transport: HOW bytes arrive
#[async_trait]
pub trait Transport: Send + Sync {
    type MessageStream: Stream<Item = Result<RawMessage>> + Send;
    async fn connect(&self, config: &TransportConfig) -> Result<Self::MessageStream>;
    async fn acknowledge(&self, msg: &RawMessage) -> Result<()>;
}

/// Serialization: WHAT the bytes mean
pub trait Deserializer: Send + Sync {
    fn deserialize(&self, msg: &RawMessage, schema: &Schema) -> Result<RecordBatch>;
    fn deserialize_batch(&self, msgs: &[RawMessage], schema: &Schema) -> Result<RecordBatch>;
}

/// A connector is a composition of transport + deserializer
pub struct GenericConnector<T: Transport, D: Deserializer> {
    transport: T,
    deserializer: D,
}
```

### Connector Strategy with Pulsar

Since Pulsar supports multiple protocols via pluggable handlers, the connector strategy is greatly simplified. Instead of building N transport implementations, one well-tested Pulsar connector handles all protocol-translated messages:

```
Via Pulsar (protocol handlers, zero code changes in data engine):
├── MQTT devices         → MoP handler → Pulsar topic
├── WebSocket clients    → WS API      → Pulsar topic
├── Kafka producers      → KoP handler → Pulsar topic
└── AMQP / RabbitMQ      → AoP handler → Pulsar topic
        │
        ▼
connector-pulsar (single Rust connector)
        │
        ▼
Ingestion Engine → DuckDB

Direct connectors (only for non-Pulsar sources):
├── connector-grpc    ← custom push API
└── connector-http    ← webhook / HTTP POST ingest
```

### Connector Configuration (User-Facing)

```yaml
sources:
  - connector: pulsar
    transport:
      service_url: "pulsar://broker1:6650"
      topic: "persistent://fleet/telemetry/vehicles"
      subscription: "data-engine-sub"
      subscription_type: shared
      batch_size: 1000
      start_position: earliest
    format:
      type: protobuf
      proto_message: "dataengine.telemetry.v1.TelemetryEnvelope"
    schema:
      fields:
        - name: device_id
          type: utf8
        - name: lat
          type: float64
        - name: lon
          type: float64
        - name: alt
          type: float32
        - name: speed_kmh
          type: float32
        - name: timestamp
          type: timestamp_ms
```

### Connector Lifecycle

```
Created → Starting → Running → Stopping → Stopped
                ↓                   ↑
             Failed (backoff + retry)
```

Each connector instance has a restart policy (exponential backoff, max retries) and is managed by a `ConnectorManager` that handles start/stop/pause/resume operations.

### Connector Management API

```
POST   /v1/connectors                  Create + start a connector
GET    /v1/connectors                  List all active connectors
GET    /v1/connectors/{id}             Status, metrics, health
DELETE /v1/connectors/{id}             Stop + remove
PUT    /v1/connectors/{id}/pause       Pause consumption
PUT    /v1/connectors/{id}/resume      Resume
GET    /v1/connectors/{id}/metrics     Throughput, lag, errors
GET    /v1/connector-types             List registered connector types
```

### Backpressure & Flow Control

```
Source (Pulsar/Kafka/...)
    │
    │  consumer.recv()        ← blocks when channel is full
    ▼
┌───────────────────┐
│ bounded mpsc      │  ← capacity: e.g., 64 batches
│ channel           │  ← if full, connector's send() awaits
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Ingestion Engine  │  ← drains channel, appends to hot buffer
│                   │  ← if hot buffer full, triggers flush
└────────┬──────────┘
         │  flush
         ▼
┌───────────────────┐
│ DuckDB            │  ← INSERT INTO warm_data
└───────────────────┘
```

The bounded channel is the pressure valve. When DuckDB flush is slow, the channel fills, the connector blocks, and the transport-level consumer naturally slows down (Pulsar and Kafka both handle this gracefully — unconsumed messages stay in the topic).

---

## 6. Messaging & Transport Layer

### Apache Pulsar as Unified Message Bus

Apache Pulsar serves as the unified message broker, providing multi-protocol support through its pluggable protocol handler framework.

#### Protocol Support Matrix

| Protocol | Implementation | Status | Notes |
|----------|---------------|--------|-------|
| Pulsar native | Built-in | Production | Binary protocol, full feature set |
| MQTT | MoP (MQTT-on-Pulsar) | Stable | QoS 0 and 1 supported; QoS 2 planned |
| Kafka | KoP (Kafka-on-Pulsar) | Production | Full Kafka wire protocol |
| AMQP | AoP (AMQP-on-Pulsar) | Stable | RabbitMQ compatible |
| WebSocket | Built-in API | Built-in | Produce, consume, read via JSON over WS |

### MQTT for Remote IoT Devices

MQTT is selected as the primary protocol for remote, constrained devices connecting over the internet. It was purpose-built for this exact scenario — originally created by IBM for monitoring oil pipelines over satellite links.

#### Why MQTT

- **Minimal wire overhead:** ~2 bytes header vs. ~200+ bytes for HTTP. A typical telemetry message has ~10–50 bytes of protocol overhead.
- **QoS levels:** QoS 0 (fire & forget) for high-frequency loss-tolerant data, QoS 1 (at least once) for most telemetry, QoS 2 (exactly once) for critical events.
- **Persistent sessions:** When a device connects with `clean_session=false`, the broker queues messages while the device is offline and delivers them on reconnect.
- **Last Will & Testament (LWT):** Automatic device-offline detection — no heartbeat polling needed.
- **NAT/firewall friendly:** Outbound TCP on port 8883 (TLS).
- **Battery/resource friendly:** Runs on microcontrollers with 32KB RAM.

#### QoS Strategy

| QoS Level | Guarantee | Use Case |
|-----------|-----------|----------|
| 0 | At most once (fire & forget) | High-frequency GPS pings (1Hz+), loss-tolerant |
| 1 | At least once (ack required) | Most telemetry — dedup server-side |
| 2 | Exactly once (4-step handshake) | Critical events (geofence, alerts). Higher overhead |

**Default: QoS 1** with server-side deduplication by `(device_id, sequence)` pair.

#### MQTT Topic Design

```
fleet/{device_id}/telemetry       ← high-frequency GPS + sensors
fleet/{device_id}/events          ← discrete events (geofence, alert)
fleet/{device_id}/status          ← LWT + heartbeat
fleet/{device_id}/command         ← reverse channel (engine → device)
```

The connector subscribes with wildcards: `fleet/+/telemetry` captures all devices.

#### Security Over Public Internet

| Method | Use Case | Notes |
|--------|----------|-------|
| mTLS (client certificates) | Fleets you control | Gold standard. Per-device cert, CA-level revocation |
| Username/password + TLS | Simpler provisioning | Per-device credentials, rotate via API |
| JWT tokens | Dynamic provisioning | Short-lived, broker validates signature |

### Architecture: Pulsar as Protocol Gateway

```
Remote IoT Devices              Web/Browser Clients
(MQTT, port 8883)               (WebSocket, port 443)
       │                               │
       └──────────┬────────────────────┘
                  │
       ┌──────────▼──────────────┐
       │     Apache Pulsar       │
       │                         │
       │  MoP ←── MQTT devices   │
       │  WS API ← Browsers      │
       │  KoP ←── Kafka clients   │
       │  AoP ←── AMQP clients   │
       │         │               │
       │   Unified Pulsar Topics │
       └──────────┬──────────────┘
                  │
           Pulsar native protocol
                  │
       ┌──────────▼──────────────┐
       │  connector-pulsar       │
       │  (single Rust connector)│
       └──────────┬──────────────┘
                  │
                  ▼
           Ingestion Engine → DuckDB
```

One connector consumes from Pulsar regardless of how messages were published. Adding a new ingest protocol means configuring a Pulsar protocol handler — not writing new Rust code.

---

## 7. Geospatial Data Handling

### Requirements

The system ingests data with geolocation fields (latitude, longitude, altitude) from mobile/remote devices. This requires spatial indexing, geo-aware queries, and coordinate system handling.

### DuckDB Spatial Extension

With DuckDB as the core engine, geospatial support is handled by the built-in `spatial` extension, which provides:

- ST_Point, ST_Distance, ST_Within, ST_Buffer functions
- R-tree spatial index
- GeoJSON/WKB I/O
- GDAL integration (50+ geo formats: Shapefile, GeoPackage, KML, FlatGeobuf, etc.)

This eliminates the need for a custom spatial sidecar index.

### Geo Query Example

```sql
WITH all_data AS (
    SELECT * FROM hot_data
    UNION ALL
    SELECT * FROM warm_data
)
SELECT device_id, speed_kmh, lat, lon
FROM all_data
WHERE ST_Distance(
    ST_Point(lon, lat),
    ST_Point(-73.5673, 45.5017)  -- Montreal
) < 5000
AND speed_kmh > 60
```

### Coordinate Handling

- **Storage datum:** WGS84 (EPSG:4326) — standard GPS datum
- **Altitude:** Stored as `f32` in meters above WGS84 ellipsoid
- **Validation on ingest:** Reject coordinates outside valid ranges (lat: -90..90, lon: -180..180)
- **H3 indexing (optional enrichment):** Precompute H3 hexagonal cells at multiple resolutions as additional columns for fast spatial aggregation

#### H3 Resolution Reference

| Resolution | Hex Edge Length | Use Case |
|------------|----------------|----------|
| 5 | ~8 km | Country/region aggregation |
| 7 | ~1.2 km | City-level geofencing |
| 9 | ~174 m | Block-level precision (good default) |
| 11 | ~24 m | Building-level |

### Geo-Enrichment Pipeline (L2 Feature)

```
Raw event {lat: 45.50, lon: -73.57, alt: 30, ...}
    │
    ▼  Geo Enrichment (async, best-effort)
    │
    ├── Reverse geocode → city: "Montréal", country: "CA"
    ├── H3 cell hierarchy → h3_res5, h3_res7, h3_res9
    ├── Geofence membership → zone: "downtown", region: "QC"
    └── Timezone → "America/Montreal"
```

---

## 8. Protobuf Schema Design

### Design Rationale

Protobuf is selected as the wire format for all device-to-engine communication:

- **Wire efficiency:** 3–10× smaller than JSON. ~45–65 bytes for a typical telemetry message vs. ~250–350 bytes in JSON.
- **Schema enforcement:** Compile-time validation via shared `.proto` files between device firmware and ingestion layer.
- **Rust-native:** `prost` generates idiomatic Rust structs with zero-copy deserialization paths.

### Wire Size Comparison

| Format | Typical Telemetry Message | Notes |
|--------|---------------------------|-------|
| Protobuf | ~45–65 bytes | Varint encoding, no field names on wire |
| MessagePack | ~80–100 bytes | Compact but carries key names |
| JSON (minified) | ~180–220 bytes | 3–4× protobuf |
| JSON | ~250–350 bytes | Human-readable but verbose |

Over 10,000 messages/day per device on metered cellular, protobuf saves ~1.5–3 MB/day vs. JSON. Across 1,000 devices: 1.5–3 GB/day.

### Core Proto Schema

```protobuf
syntax = "proto3";
package dataengine.telemetry.v1;
import "google/protobuf/timestamp.proto";

// ─── Core Geo Type ────────────────────────────
message GeoPosition {
  double latitude   = 1;  // WGS84 decimal degrees
  double longitude  = 2;
  float  altitude   = 3;  // meters above WGS84 ellipsoid
  float  accuracy   = 4;  // horizontal accuracy (CEP50)
  float  heading    = 5;  // degrees from true north [0, 360)
  float  speed      = 6;  // meters per second
}

// ─── Telemetry Envelope ───────────────────────
message TelemetryEnvelope {
  string                     device_id   = 1;
  string                     device_type = 2;
  google.protobuf.Timestamp  timestamp   = 3;
  uint64                     sequence    = 4;  // monotonic for dedup
  map<string, string>        metadata    = 5;

  oneof payload {
    VehicleTelemetry   vehicle   = 10;
    SensorReading      sensor    = 11;
    DeviceEvent        event     = 12;
    RawPayload         raw       = 15;
  }
}

// ─── Typed Payloads ───────────────────────────
message VehicleTelemetry {
  GeoPosition position        = 1;
  float       speed_kmh       = 2;
  float       fuel_level      = 3;
  float       battery_voltage = 4;
  uint32      rpm              = 5;
  EngineState engine_state     = 6;
  enum EngineState {
    ENGINE_STATE_UNSPECIFIED = 0;
    ENGINE_STATE_OFF         = 1;
    ENGINE_STATE_IDLE        = 2;
    ENGINE_STATE_RUNNING     = 3;
  }
}

message SensorReading {
  GeoPosition position    = 1;
  float       temperature = 2;
  float       humidity    = 3;
  float       pressure    = 4;
  float       battery_pct = 5;
}

message DeviceEvent {
  GeoPosition position     = 1;
  EventType   event_type   = 2;
  string      description  = 3;
  Severity    severity     = 4;
  enum EventType {
    EVENT_TYPE_UNSPECIFIED     = 0;
    EVENT_TYPE_GEOFENCE_ENTER  = 1;
    EVENT_TYPE_GEOFENCE_EXIT   = 2;
    EVENT_TYPE_ALERT           = 3;
    EVENT_TYPE_MAINTENANCE     = 4;
    EVENT_TYPE_BOOT            = 5;
    EVENT_TYPE_SHUTDOWN        = 6;
  }
  enum Severity {
    SEVERITY_UNSPECIFIED = 0;
    SEVERITY_INFO        = 1;
    SEVERITY_WARNING     = 2;
    SEVERITY_CRITICAL    = 3;
  }
}

message RawPayload {
  string content_type = 1;
  bytes  data         = 2;
}
```

### Schema Design Principles

- **Envelope pattern:** Every message wraps in `TelemetryEnvelope` with common header fields and a `oneof` payload. One Pulsar topic, one deserializer, payload type discriminated in the proto.
- **Sequence number:** Device-side monotonic counter for deduplication when MQTT QoS 1 delivers duplicates.
- **`GeoPosition` as reusable type:** Embedded in every payload variant, ensuring consistent geo field handling.
- **Version in package path:** `dataengine.telemetry.v1` — breaking changes go in `v2` with parallel support during migration.

### Schema Management

Use **Buf** (`buf.build`) for proto linting, breaking change detection, and schema registry:

```yaml
# buf.yaml
version: v2
breaking:
  use:
    - WIRE_JSON
lint:
  use:
    - DEFAULT
    - COMMENTS
```

### Payload Routing Strategy

Each `oneof` payload variant maps to a separate DuckDB table with a tight, well-typed Arrow schema:

```
TelemetryEnvelope
    ├── payload = Vehicle → Arrow(vehicle_schema) → DuckDB: vehicle_telemetry
    ├── payload = Sensor  → Arrow(sensor_schema)  → DuckDB: sensor_readings
    └── payload = Event   → Arrow(event_schema)   → DuckDB: device_events
```

This avoids a single wide table with sparse nullable columns, improving both query clarity and DuckDB scan efficiency.

---

## 9. Arrow End-to-End Strategy

### Design Principle

Apache Arrow is not just an internal interchange format — it is the **end-to-end data representation** from the connector boundary all the way to the client. The only serialization format that exists outside of Arrow is Protobuf at the constrained device edge, where single-row columnar encoding would be counterproductive.

### Why Not Arrow at the Device Edge

Arrow IPC is optimized for columnar batches, not single-row messages from constrained devices:

| Factor | Protobuf | Arrow IPC |
|--------|----------|-----------|
| Single-row message | ~50–60 bytes | ~500+ bytes (schema + buffers + alignment padding) |
| Schema overhead | None on wire (compiled in) | Full schema metadata in every IPC message |
| Alignment | None needed | 8-byte aligned buffers — wastes bytes at small scale |
| Streaming single events | Natural fit | Anti-pattern — Arrow shines with batches |
| Constrained devices | Tiny encode footprint | Arrow IPC encoder is heavy for embedded |

**Decision:** Protobuf stays at the device edge. Arrow starts at the connector where micro-batches are accumulated.

### Arrow Through the Full Pipeline

```
Device            Pulsar         Connector        Engine          Client
  │                 │               │               │               │
  │  Protobuf       │               │               │               │
  │  (optimal for   │               │               │               │
  │   single-row    │               │               │               │
  │   constrained)  │               │               │               │
  │────────────────►│               │               │               │
  │                 │  raw bytes    │               │               │
  │                 │──────────────►│               │               │
  │                 │               │               │               │
  │                 │         decode + batch         │               │
  │                 │               │               │               │
  │                 │          Arrow RecordBatch     │               │
  │                 │               │──────────────►│               │
  │                 │               │               │               │
  │                 │               │    ┌──────────┤               │
  │                 │               │    │ Hot:  Arrow buffers      │
  │                 │               │    │ Warm: DuckDB (Arrow      │
  │                 │               │    │       internal repr)     │
  │                 │               │    │ Cold: Parquet (Arrow     │
  │                 │               │    │       columnar on disk)  │
  │                 │               │    └──────────┤               │
  │                 │               │               │               │
  │                 │               │        query: SQL             │
  │                 │               │        result: Arrow batch    │
  │                 │               │               │               │
  │                 │               │               │  Arrow Flight │
  │                 │               │               │  (gRPC +      │
  │                 │               │               │   Arrow IPC)  │
  │                 │               │               │──────────────►│
  │                 │               │               │               │
  │                 │               │               │    pyarrow    │
  │                 │               │               │    polars     │
  │                 │               │               │    DuckDB     │
  │                 │               │               │    pandas     │
```

### Format at Each Stage

| Stage | Format | Why |
|-------|--------|-----|
| Device → Broker | **Protobuf** | Single-row, constrained devices, minimal wire overhead |
| Broker → Connector | **Protobuf bytes** (in Pulsar message payload) | Passthrough, no transformation |
| Connector → Hot Buffer | **Arrow RecordBatch** | Batch-level decode, columnar from this point forward |
| Hot Buffer | **Arrow RecordBatch** (in-memory) | Zero-copy queryable |
| Hot → DuckDB query | **Arrow** (zero-copy register) | DuckDB scans Arrow directly |
| Warm storage (DuckDB) | **Arrow** (DuckDB internal columnar) | DuckDB's native representation is Arrow-compatible |
| Cold storage (disk/S3) | **Parquet** | Arrow-columnar on disk with compression, predicate pushdown |
| Query result → Client | **Arrow Flight** (Arrow IPC over gRPC) | Zero ser/deser, streaming, rich client ecosystem |
| Bulk ingest from client | **Arrow Flight DoPut** | Client pushes Arrow batches directly — no JSON/CSV conversion |

### Serialization Boundaries

Only three serialization/deserialization boundaries remain in the entire system:

1. **Protobuf → Arrow** (at the connector, once per micro-batch)
2. **Arrow → Parquet** (at flush to disk — columnar-to-columnar, very efficient)
3. **Parquet → Arrow** (at cold scan — also very efficient)

Everything else is zero-copy or native Arrow.

### Arrow Flight as Query Protocol

Arrow Flight is a gRPC-based protocol purpose-built for high-throughput Arrow data transfer. It provides query submission, metadata exchange, and parallel streaming of Arrow RecordBatches.

#### Flight Protocol Flow

```
Client                              Data Engine
  │                                      │
  │── GetFlightInfo(SQL query) ─────────►│
  │◄── FlightInfo(endpoints, schema) ────│
  │                                      │
  │── DoGet(ticket) ────────────────────►│
  │◄── Stream<RecordBatch> ──────────────│  ← zero-copy Arrow IPC frames
  │◄── RecordBatch ──────────────────────│
  │◄── RecordBatch ──────────────────────│
  │◄── done ─────────────────────────────│
  │                                      │
  │── DoPut(Stream<RecordBatch>) ───────►│  ← bulk ingest via Arrow too
  │◄── ack ──────────────────────────────│
```

**Zero serialization cost on the query path.** DuckDB produces Arrow RecordBatches internally. Arrow Flight sends Arrow IPC frames on the wire. The client receives Arrow RecordBatches. At no point does anyone convert to/from JSON, CSV, or any other format.

#### Rust Flight Server Implementation

```rust
use arrow_flight::flight_service_server::{FlightService, FlightServiceServer};
use arrow_flight::{FlightInfo, FlightData, Ticket, FlightDescriptor, FlightEndpoint};

pub struct DataEngineFlightService {
    engine: Arc<QueryEngine>,
}

#[tonic::async_trait]
impl FlightService for DataEngineFlightService {
    type DoGetStream = RecordBatchStream;
    type DoPutStream = PutResultStream;

    /// Client submits a SQL query, gets back metadata + ticket
    async fn get_flight_info(
        &self,
        request: Request<FlightDescriptor>,
    ) -> Result<Response<FlightInfo>, Status> {
        let sql = std::str::from_utf8(&request.into_inner().cmd)
            .map_err(|_| Status::invalid_argument("invalid SQL"))?;

        let schema = self.engine.plan_query(sql).await?.schema();
        let info = FlightInfo::new()
            .with_schema(&schema)
            .with_descriptor(FlightDescriptor::new_cmd(sql))
            .with_endpoint(FlightEndpoint::new().with_ticket(Ticket::new(sql)));

        Ok(Response::new(info))
    }

    /// Client fetches results as a stream of Arrow RecordBatches
    async fn do_get(
        &self,
        request: Request<Ticket>,
    ) -> Result<Response<Self::DoGetStream>, Status> {
        let sql = std::str::from_utf8(&request.into_inner().ticket)
            .map_err(|_| Status::invalid_argument("invalid ticket"))?;

        // Execute query — DuckDB returns Arrow batches natively
        let batch_stream = self.engine.execute_streaming(sql).await?;

        // Stream directly to client — no conversion
        Ok(Response::new(batch_stream))
    }

    /// Client pushes Arrow data directly for bulk ingest
    async fn do_put(
        &self,
        request: Request<Streaming<FlightData>>,
    ) -> Result<Response<Self::DoPutStream>, Status> {
        let mut stream = request.into_inner();
        while let Some(flight_data) = stream.next().await {
            let batch = flight_data_to_record_batch(&flight_data?)?;
            self.engine.ingest_batch(batch).await?;
        }
        Ok(Response::new(/* ack stream */))
    }
}
```

#### Client Usage Examples

**Python — Query to DataFrame (zero parsing):**

```python
import pyarrow.flight as flight
import polars as pl

client = flight.connect("grpc://data-engine:8815")

info = client.get_flight_info(
    flight.FlightDescriptor.for_command(
        b"""SELECT device_id, lat, lon, speed_kmh
            FROM vehicle_telemetry
            WHERE ST_Distance(
                ST_Point(lon, lat),
                ST_Point(-73.5673, 45.5017)
            ) < 5000"""
    )
)

# Stream results directly into Polars (zero copy)
reader = client.do_get(info.endpoints[0].ticket)
df = pl.from_arrow(reader.read_all())

# Or into Pandas
df_pandas = reader.read_pandas()
```

**Python — Bulk ingest (push Arrow directly):**

```python
import pyarrow as pa
import pyarrow.flight as flight

table = pa.table({
    "device_id": ["v001", "v002", "v003"],
    "lat": [45.50, 45.51, 45.52],
    "lon": [-73.56, -73.57, -73.58],
    "speed_kmh": [60.0, 45.0, 80.0],
})

client = flight.connect("grpc://data-engine:8815")
writer, _ = client.do_put(
    flight.FlightDescriptor.for_path("vehicle_telemetry"),
    table.schema,
)
writer.write_table(table)
writer.close()
```

### API Layer: Dual Protocol

The service exposes both Arrow Flight (for data-intensive operations) and REST (for management and lightweight queries):

```
┌────────────────────────────────────────────┐
│              API Layer                      │
│                                            │
│  ┌──────────────────┐  ┌────────────────┐  │
│  │  Arrow Flight     │  │  REST (Axum)   │  │
│  │  (port 8815)      │  │  (port 8080)   │  │
│  │                   │  │                │  │
│  │  - DoGet (query)  │  │  - POST /query │  │
│  │  - DoPut (ingest) │  │    → JSON resp │  │
│  │  - GetFlightInfo  │  │  - GET /health │  │
│  │                   │  │  - Connectors  │  │
│  │  For: data eng,   │  │    CRUD        │  │
│  │  analytics,       │  │                │  │
│  │  high-throughput  │  │  For: web apps,│  │
│  │  pipelines        │  │  dashboards,   │  │
│  │                   │  │  admin ops     │  │
│  └──────────────────┘  └────────────────┘  │
└────────────────────────────────────────────┘
```

| Interface | Format | Audience | Use Case |
|-----------|--------|----------|----------|
| **Arrow Flight** | Arrow IPC over gRPC | Data engineers, analytics pipelines, notebooks | High-throughput queries, bulk ingest, DataFrame integration |
| **REST API** | JSON | Web apps, dashboards, admin | Connector management, health checks, lightweight queries |

---

## 10. End-to-End Data Pipeline

### Full Flow: Device to Query

```
Device
  │  TelemetryEnvelope.encode_to_vec()  (~50-60 bytes)
  │
  │── MQTT publish (QoS 1, TLS) ──►  Pulsar Broker (MoP handler)
                                          │
                                     Pulsar Topic (raw bytes)
                                          │
                                     connector-pulsar consumes
                                          │
                                  prost::Message::decode()
                                          │
                                  TelemetryEnvelope (Rust struct)
                                          │
                                  Dedup by (device_id, sequence)
                                          │
                                  Route by oneof variant
                                          │
                                  Batch into Arrow RecordBatch
                                     (micro-batch: 1000 msgs or 1s)
                                          │
                                  Hot Buffer (in-memory Arrow)
                                          │
                              ┌────────────┼────────────────┐
                              │            │                │
                         Query Path   Flush Path       Compact Path
                              │            │                │
                    Register as       INSERT INTO      Merge small
                    DuckDB Arrow      warm DuckDB      Parquet files
                    table (zero-      table             into larger
                    copy)                               segments
                              │            │
                         UNION ALL    Write Parquet
                         hot + warm   to disk/S3
                              │
                        SQL query execution
                        (analytics + spatial)
                              │
                        Results → API → Client
```

### Deserialization: Protobuf → Arrow

The deserializer operates at batch level for efficiency — accumulating a micro-batch of messages and building one `RecordBatch` with pre-allocated column builders:

```rust
pub struct ProtoTelemetryDeserializer {
    schema: Arc<Schema>,
}

impl ProtoTelemetryDeserializer {
    pub fn deserialize_batch(&self, messages: &[RawMessage]) -> Result<RecordBatch> {
        let capacity = messages.len();

        // Pre-allocate column builders
        let mut device_id = StringBuilder::with_capacity(capacity, capacity * 16);
        let mut timestamp = TimestampMillisecondBuilder::with_capacity(capacity);
        let mut lat       = Float64Builder::with_capacity(capacity);
        let mut lon       = Float64Builder::with_capacity(capacity);
        let mut alt       = Float32Builder::with_capacity(capacity);
        // ... additional field builders ...

        for msg in messages {
            let envelope = TelemetryEnvelope::decode(msg.payload.as_ref())?;
            let vehicle = match envelope.payload {
                Some(Payload::Vehicle(v)) => v,
                _ => continue,
            };
            let pos = vehicle.position.unwrap_or_default();

            device_id.append_value(&envelope.device_id);
            lat.append_value(pos.latitude);
            lon.append_value(pos.longitude);
            // ... populate remaining fields ...
        }

        RecordBatch::try_new(self.schema.clone(), vec![
            Arc::new(device_id.finish()),
            Arc::new(lat.finish()),
            Arc::new(lon.finish()),
            // ...
        ])
    }
}
```

### Deduplication

MQTT QoS 1 guarantees at-least-once delivery, meaning duplicates are expected. Deduplication uses a bounded LRU cache keyed by `(device_id, sequence)`, placed before the batch builder to filter duplicates before they reach Arrow or DuckDB.

---

## 11. Project Structure & Crate Map

```
data-engine/
├── Cargo.toml                        # workspace root
├── proto/
│   └── dataengine/
│       └── telemetry/
│           └── v1/
│               ├── envelope.proto
│               ├── geo.proto
│               ├── vehicle.proto
│               ├── sensor.proto
│               └── event.proto
├── crates/
│   ├── engine-core/                  # DuckDB integration, catalog, query engine
│   ├── ingestion/                    # Ingestion engine, hot buffer, flush logic
│   ├── connector-api/                # Trait definitions, BatchSink, config types
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── transport.rs
│   │       ├── deserializer.rs
│   │       ├── connector.rs
│   │       └── config.rs
│   ├── connector-pulsar/             # Pulsar transport (pulsar crate)
│   ├── connector-kafka/              # Kafka transport (rdkafka)
│   ├── connector-mqtt/               # Direct MQTT if not via Pulsar (rumqttc)
│   ├── connector-grpc/               # gRPC push ingest (tonic)
│   ├── connector-http/               # HTTP/webhook ingest (axum)
│   ├── format-protobuf/              # Protobuf deserializer (prost)
│   ├── format-json/                  # JSON deserializer
│   ├── format-avro/                  # Avro deserializer
│   ├── flight-server/                # Arrow Flight query + ingest server (arrow-flight + tonic)
│   └── api-server/                   # REST admin API (Axum) + Flight server composition
└── config/
    └── example.yaml
```

### Cargo Feature Flags

```toml
[features]
default = ["pulsar"]
pulsar   = ["connector-pulsar"]
kafka    = ["connector-kafka"]
mqtt     = ["connector-mqtt"]
grpc     = ["connector-grpc"]
http     = ["connector-http"]
all      = ["pulsar", "kafka", "mqtt", "grpc", "http"]
```

### Crate Dependencies

| Crate | Purpose | Version |
|-------|---------|---------|
| `prost` / `prost-types` | Protobuf encode/decode | 0.13 |
| `tonic` / `tonic-build` | gRPC server + proto compilation (shared with Arrow Flight) | 0.12 |
| `axum` | REST API | latest |
| `tokio` | Async runtime | 1.x |
| `duckdb` | Embedded DuckDB (via `duckdb-rs`) | latest |
| `arrow` | Arrow types and builders | 54 |
| `arrow-flight` | Arrow Flight protocol (query API) | 54 |
| `arrow-ipc` | Arrow IPC serialization | 54 |
| `pulsar` | Apache Pulsar client | latest |
| `rdkafka` | Kafka client (librdkafka binding) | latest |
| `rumqttc` | MQTT client (if direct, not via Pulsar) | latest |
| `dashmap` | Concurrent metadata store | latest |
| `quick_cache` | Bounded LRU cache for dedup | latest |
| `h3o` | H3 spatial indexing (pure Rust) | 0.7 |
| `geo` | Geometry primitives + haversine | 0.28 |
| `tracing` | Structured logging/observability | latest |

---

## 12. Phased Delivery Plan

### Phase 1 — MVP (4–6 weeks)

- `connector-api` + `connector-pulsar` + `format-protobuf` + `ingestion` core
- Single connector (Pulsar), single format (Protobuf), end to end
- Hot buffer (in-memory Arrow) + Warm (DuckDB persistent tables, local Parquet)
- DuckDB spatial extension enabled
- **Arrow Flight server** for query results (DoGet) and bulk ingest (DoPut)
- REST API for connector management and lightweight queries (JSON fallback)
- Catalog: In-memory `DashMap` with optional SQLite persistence
- No auth

### Phase 2 — Connector Validation (3–4 weeks)

- Add `connector-kafka` + `format-avro`
- Validate the Transport/Deserializer trait abstraction holds across two implementations
- Connector management API (start/stop/pause/resume/metrics)
- Lifecycle management with restart policies
- Geo-enrichment pipeline (reverse geocode, H3 indexing)
- Arrow Flight GetFlightInfo with schema introspection

### Phase 3 — Production Hardening (4–6 weeks)

- Auth middleware (API keys / JWT → tenant isolation, Flight auth handshake)
- Cold storage tier (S3/object store Parquet)
- Compaction (merge small Parquet segments)
- Observability (Prometheus metrics, tracing)
- Additional connectors: gRPC push, HTTP webhook
- Arrow Flight parallel endpoints (multi-endpoint DoGet for partitioned scans)
- SDK generation (Python, JavaScript) — leveraging `pyarrow.flight` client

---

## 13. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Concurrency model | Tokio async for I/O, Rayon (via DuckDB/Polars) for compute | Keep I/O async, compute parallel |
| Hot buffer structure | `Arc<RwLock<Vec<RecordBatch>>>` per dataset | Writers append; readers snapshot. Swap-on-flush |
| Data format strategy | **Arrow end-to-end** from connector to client | Only 3 ser/deser boundaries in the entire system; zero-copy at all other transitions |
| Device wire format | Protobuf (not Arrow) | Arrow IPC has ~500+ byte overhead per message; Protobuf is ~50–60 bytes for single-row telemetry on constrained devices |
| Storage at rest | Parquet | Arrow-columnar on disk; efficient Arrow ↔ Parquet conversion (columnar-to-columnar) |
| Client query API | Arrow Flight (gRPC + Arrow IPC) + REST (JSON) | Flight for high-throughput data operations; REST for admin/management. Dual protocol serves both audiences |
| Query language | SQL (DuckDB native) | Full-featured, universal, spatial-enabled |
| Backpressure | Bounded `tokio::sync::mpsc` channels on ingest path | Prevents OOM; backpressure propagates to source |
| Dedup strategy | LRU cache on `(device_id, sequence)` before batch builder | Filter duplicates before Arrow/DuckDB, not after |
| Payload routing | Separate DuckDB table per `oneof` variant | Tight schemas, no sparse NULLs, better scan efficiency |
| Proto versioning | Package path: `v1`, `v2`, etc. | Parallel support during migration, Buf CI for breaking change detection |
| MQTT QoS default | QoS 1 | At-least-once with server-side dedup. Covers most telemetry use cases |
| Broker architecture | External Pulsar (not embedded) | Session persistence, clustering, auth, multi-protocol — don't own this in the data engine |

---

## 14. Risks & Caveats

### MoP (MQTT-on-Pulsar) Limitations

- **QoS 2 not yet supported.** QoS 1 with deduplication covers most cases. Only an issue for strict exactly-once requirements on critical events.
- **MQTT topic mapping quirks.** Multi-level MQTT topics like `/a/b/c` get URL-encoded when mapped to Pulsar's namespace model. Topic hierarchy must be designed with Pulsar's naming in mind.
- **Maintained by StreamNative, not Apache Pulsar core.** Open source (Apache 2.0) and widely used, but long-term support depends on StreamNative's priorities.

### WebSocket via Pulsar

- **JSON-only.** All WebSocket API exchanges use JSON — no binary protobuf. Fine for browser clients, not ideal for bandwidth-constrained devices (use MQTT for those).

### DuckDB Considerations

- **Single writer.** DuckDB supports concurrent readers but single writer. The ingestion engine must serialize flush operations.
- **C++ via FFI.** `duckdb-rs` crosses FFI boundaries. Less transparent error handling and memory management than pure Rust.
- **Buffer pool opacity.** DuckDB manages its own memory. Set explicit memory limits and monitor with `jemalloc` stats.

### Schema Evolution

- **Decide early:** Reject schema-incompatible data, or support additive changes (new nullable columns)? Additive is harder but much more useful in production. Protobuf's wire format naturally supports additive evolution (new fields are ignored by old consumers).

### Memory Pressure

- Set a cap on hot buffer size per dataset; force flush to DuckDB/Parquet when exceeded.
- The dedup LRU cache also needs bounded capacity to prevent unbounded memory growth.

---

*This document captures the architectural analysis as of February 2026. It is intended to evolve as implementation proceeds and decisions are validated.*
