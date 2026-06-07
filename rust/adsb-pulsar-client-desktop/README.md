# ADS-B Aircraft Tracker

A desktop application for real-time aircraft tracking and historical analysis, built with **Tauri v2**, **Next.js 15**, and **DuckDB**.

Connects to a [dump1090](https://github.com/flightaware/dump1090) receiver (directly or via [Apache Pulsar](https://pulsar.apache.org/)), displays live aircraft positions on an interactive map, and persists every data point to a local DuckDB database for later exploration.

## Overview

<!-- Replace with actual screenshots -->
| Live Tracking | DB History & Analysis | Aircraft Details |
|:---:|:---:|:---:|
| ![Live tracking map](docs/screenshots/live-tracking.png) | ![DB History panel](docs/screenshots/db-history.png) | ![Aircraft details](docs/screenshots/aircraft-details.png) |

## Features

### Real-Time Tracking
- Live aircraft positions on a Leaflet map with altitude-based color coding
- Heading-rotated markers, polyline trails, and high-density dot rendering
- Configurable filters: callsign search, altitude range, ground speed range
- Metrics dashboard: messages/sec, throughput, queue depth, error rate, uptime

### Historical Analysis
- Every position automatically persisted to a local DuckDB database
- Browse flights by date range with virtualized scrolling
- Batch-load flights into a dedicated **Analysis mode** for side-by-side comparison
- Spatial queries (bounding box), trajectory reconstruction, flight summaries
- Detection range radar, hourly heatmap, and time distribution charts

### Storage Management
- **Release / Reclaim** the database connection for external tool access
- **Export** a live copy without stopping recording
- **Import** external `.db` files with automatic deduplication
- **Swap** to archive the current database and start fresh with zero data loss

### GeoJSON Export & Import
- Export active and historical tracks as standard GeoJSON
- Re-import for visualization with distinct styling (dashed trails, indigo accent)

### Events of Interest
- Mark and annotate notable occurrences (unusual altitudes, rare callsigns)
- Status timeline with color-coded audit trail of feed and storage events

### Additional
- **Simulated flights** demo mode with 20 predefined routes (no live feed needed)
- **Receiver location** marker on the map with altitude tooltip
- **Dark / Light** map tile themes
- **Resizable panels** with state persisted across sessions

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Tauri v2 Desktop App                     │
│                                                             │
│  ┌──────────────────────┐    ┌────────────────────────────┐ │
│  │     Rust Backend      │    │    Next.js 15 Frontend     │ │
│  │                       │    │                            │ │
│  │  dump1090 TCP ──────────── Tauri Events ──► Leaflet Map │ │
│  │  (or Pulsar)  bridge  │    │              ──► Data Table │ │
│  │       │               │    │              ──► Charts     │ │
│  │       ▼               │    │                            │ │
│  │  DuckDB  ◄──────────────── Tauri Commands (IPC)        │ │
│  │  (adsb_history.db)    │    │  (queries, storage mgmt)   │ │
│  └──────────────────────┘    └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

- The **Rust backend** ingests ~50k messages/sec, throttles to ~2 UI updates/sec, and persists every batch to DuckDB
- The **frontend** renders tracks on the map and queries historical data via Tauri IPC commands
- **Arrow IPC** wire format for large query results (~4x smaller, ~5x faster than JSON)
- **Graceful degradation**: app runs in real-time-only mode if DuckDB is unavailable

## Quick Start

**Prerequisites:** Rust 1.75+, Node.js 18+, `protoc`

```bash
cd adsb-feed/rust/adsb-pulsar-client-desktop
npm install
npm run tauri dev
```

See [QUICKSTART.md](QUICKSTART.md) for full setup instructions including `protoc` installation and build options.

## Documentation

| Document | Description |
|----------|-------------|
| [QUICKSTART.md](QUICKSTART.md) | Prerequisites, installation, and first run |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture deep-dive: IPC flow, track lifecycle, state management, feature design decisions |
| [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md) | Developer guide: patterns, conventions, performance guidelines |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop framework | [Tauri v2](https://v2.tauri.app/) (Rust) |
| Frontend | [Next.js 15](https://nextjs.org/) + [React 19](https://react.dev/) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com/) |
| Map | [Leaflet](https://leafletjs.com/) via [react-leaflet](https://react-leaflet.js.org/) |
| Database | [DuckDB](https://duckdb.org/) (embedded, via `adsb-data-engine` crate) |
| Serialization | [Apache Arrow IPC](https://arrow.apache.org/) for query results |
| Charts | [Recharts](https://recharts.org/) |
| Geospatial | [H3](https://h3geo.org/) hexagonal density overlay |
| Virtualization | [@tanstack/react-virtual](https://tanstack.com/virtual) |

## Testing

~360 tests across Rust and TypeScript:

```bash
# Rust (from adsb-feed/rust/)
cargo test --workspace

# TypeScript (from this directory)
npm test

# Full CI gate
cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check
npm test && npx next lint
```

## Part of the ADS-B Project

This desktop app is one component of a larger ADS-B data pipeline. See the [project root](../../../) for the full architecture including Apache Pulsar streaming, Spark processing with Delta Lake, and the Dash web visualization.
