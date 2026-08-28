# adsb-data-server

Headless ADS-B recorder. Consumes a live SBS-1 feed over MQTT, records it to
DuckDB, and exposes the result to other processes — no GUI, and no Apache
Pulsar required.

```
adsb-pulsar-client ──MQTT──► adsb-data-server ──► DuckDB
  (any arch)                   (aarch64 only)       │
                                                    ├─► quack_serve   SQL ATTACH
                                                    └─► HTTP tool API read-only
```

## Why this is a separate process

DuckDB takes an **exclusive file lock**, so exactly one process may own the
database. Keeping that constraint out of `adsb-pulsar-client` lets the feed
client stay a small binary that also runs on 32-bit nodes — where DuckDB cannot
go at all. A mixed fleet therefore runs the feed client everywhere and this
daemon only on `aarch64` nodes.

The ingest path is not implemented here. It lives in
`adsb_data_engine::ingest`, shared with the Tauri desktop app so the two cannot
drift; this crate supplies the headless wiring — a source, a `NoopSink`, and
the serving surfaces.

## Run

```bash
cargo run -p adsb-data-server -- --config ./data-server.example.toml
```

Configuration layers, lowest to highest: struct defaults < TOML file <
environment variable < CLI flag. A file value is **not** overridden by a flag's
default — only by a flag the operator actually passes.

## Serving surfaces

| Surface | Access | Notes |
|---|---|---|
| `http_port` (default 8787) | read-only JSON | `POST /tools/<name>`; shared with the desktop app and the agent, so all three answer queries identically |
| `share` / Quack | full SQL, read **and write** | Off by default. Token grants write access to every table and the server terminates no TLS — homelab-grade on a trusted LAN only |

Mutating operations are deliberately absent from the HTTP surface.

## Build

```bash
cargo build -p adsb-data-server --release
```

Requires `aarch64` or `x86_64` — DuckDB does not support 32-bit ARM. No
`protoc` needed: this crate depends on `adsb-pulsar-client` with
`default-features = false, features = ["mqtt"]`, so the `pulsar` crate (and its
protobuf build step) is never pulled in.
