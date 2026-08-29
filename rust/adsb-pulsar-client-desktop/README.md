# ADS-B Aircraft Tracker

A desktop application for real-time aircraft tracking and historical analysis, built with **Tauri v2**, **Next.js 16**, and **DuckDB**.

Connects to a [dump1090](https://github.com/flightaware/dump1090) receiver — directly over TCP, or over an [MQTT](https://mosquitto.org/) broker when the receiver lives on another machine — displays live aircraft positions on an interactive map, and persists every data point to a local DuckDB database for later exploration.

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

### AI Assistant (AG-UI)
- **Natural-language chat** to query live and historical traffic and drive the UI
  ("show AFR123's trajectory", "pan to LFPG", "filter above 30,000 ft")
- Backed by a local **LangGraph ReAct agent** (CopilotKit / AG-UI) with a server/client
  tool-plane split: read-only DuckDB queries run server-side in-loop, UI actions stay
  user-in-the-loop on the frontend
- **Voice input** via two local backends — Voxtral (streaming STT) and LFM2.5-Audio
  (end-to-end speech understanding) — with optional auto-send
- Fully optional and fully local; see [`agent/README.md`](../adsb-agent/README.md)

### Events of Interest
- Mark and annotate notable occurrences (unusual altitudes, rare callsigns)
- Status timeline with color-coded audit trail of feed and storage events

### Flight Simulation
Put aircraft on the map with no receiver, no feed, and no live traffic — for demos,
UI work, and reproducing a situation on demand. Three levels, cheapest first:

- **Demo flights** — one toggle at the top of the Simulation panel animates 20
  predefined Montreal-area routes. Zero setup; nothing to generate or save.
- **Generated trajectories** — describe a flight in plain language ("orbit the port,
  then land downtown") and the simulation agent returns real waypoint geometry:
  multi-leg routes, climb/cruise/descent phases, and per-waypoint timing. Generate
  from the panel form, or just ask in chat — chat-generated aircraft start flying
  immediately.
- **Scenarios** — name a collection of trajectories, each with its own
  `start_offset_s` saying when it enters the timeline, and persist it to DuckDB.
  Scenarios **replay offline**: the waypoints are stored verbatim, so a saved
  scenario survives a restart and needs no Python agent to play back. Each carries a
  prose description you can write yourself or have the LLM draft from the tracks it
  contains.

Playback is a proper transport: **Start / Pause / Resume / Stop** plus a scrub
timeline, available per trajectory *and* for the scenario as a whole via its master
clock. Visibility is an independent axis — the **eye** hides a trajectory's marker
and route without touching its clock, per trajectory or all at once, so you can
isolate one aircraft and un-hide the rest exactly where they should be by now. A
shown trajectory draws its dashed **planned route** whether or not it is playing,
which is what makes a freshly generated scenario inspectable before you press Start.

> Generation needs `adsb-agent` (:8000) and `adsb-simulation-agent` (:8300). Without
> them the panel shows a readable error, and demo flights plus saved scenarios still
> work — the rest of the app is unaffected.

### Additional
- **Receiver location** marker on the map with altitude tooltip
- **Dark / Light** map tile themes
- **Resizable panels** with state persisted across sessions

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Tauri v2 Desktop App                     │
│                                                             │
│  ┌──────────────────────┐    ┌────────────────────────────┐ │
│  │     Rust Backend      │    │    Next.js 16 Frontend     │ │
│  │                       │    │                            │ │
│  │  dump1090 TCP ──────────── Tauri Events ──► Leaflet Map │ │
│  │   or MQTT     bridge  │    │              ──► Data Table │ │
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

### Message source: socket or MQTT

```
[Raspberry Pi]                          [Desktop]
dump1090 --> adsb-pulsar-client --MQTT--> this app          (source_kind = mqtt)
                    |                     :1883
                    +--MQTT--> adsb-data-server --Quack :9494--> this app
                                (records continuously)      (storage_mode = remote)
```

`source_kind` selects between a direct TCP read (`socket`, the default) and an MQTT
subscription (`mqtt`). The broker exists so the receiver does not have to be on the same
machine as the UI, and so `adsb-data-server` can keep recording when the app is closed.
Apache Pulsar remains available as an *additional* fan-out leg for the Spark/Delta
pipeline — it is not an alternative to MQTT.

Set it from the Settings panel, or via `ADSB_SOURCE_KIND` / `ADSB_MQTT_BROKER` /
`ADSB_MQTT_PORT` / `ADSB_MQTT_TOPIC` (environment beats the stored config). The simplest
path is `make up-desktop` from `adsb-feed/`, which starts the broker, feed and recorder in
the right order. See [docs/DESIGN.md §27](docs/DESIGN.md#message-sources--the-mqtt-broker)
and [`QUICKSTART.md`](../../QUICKSTART.md).

### Optional AI Assistant

```
  CopilotChat (frontend) ──AG-UI SSE──► Agent (FastAPI, :8000)
                                          └ LangGraph ReAct loop ──► LLM (:1234)
                                                  │ server tools (read-only)
                                                  ▼
                              Tauri tool server (127.0.0.1:8787) ──► DuckDB
```

An optional local AI agent adds a natural-language chat panel. Read-only data tools run
in-loop against DuckDB via a loopback tool server (`:8787`); UI-action tools are
forwarded back to the frontend. The agent runs as a **separate process** — if it isn't
started, the rest of the app is unaffected. See [docs/DESIGN.md §18](docs/DESIGN.md#ai-agent--ag-ui-integration)
and [`agent/README.md`](../adsb-agent/README.md).

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
| [agent/README.md](../adsb-agent/README.md) | AI agent backend: setup, configuration, voice-model install |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop framework | [Tauri v2](https://v2.tauri.app/) (Rust) |
| Frontend | [Next.js 16](https://nextjs.org/) + [React 19](https://react.dev/) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com/) |
| Map | [Leaflet](https://leafletjs.com/) via [react-leaflet](https://react-leaflet.js.org/) |
| Database | [DuckDB](https://duckdb.org/) (embedded, via `adsb-data-engine` crate) |
| Serialization | [Apache Arrow IPC](https://arrow.apache.org/) for query results |
| Charts | [Recharts](https://recharts.org/) |
| Geospatial | [H3](https://h3geo.org/) hexagonal density overlay |
| Virtualization | [@tanstack/react-virtual](https://tanstack.com/virtual) |
| AI chat (AG-UI) | [CopilotKit](https://copilotkit.ai/) + [ag-ui-protocol](https://github.com/ag-ui-protocol) |
| Agent runtime | [LangGraph](https://langchain-ai.github.io/langgraph/) + [LangChain](https://www.langchain.com/) (Python / [FastAPI](https://fastapi.tiangolo.com/)) |
| Voice input | Voxtral (STT) / [LFM2.5-Audio](https://www.liquid.ai/) (local speech understanding) |

## Testing

~1,370 tests across Rust and TypeScript:

```bash
# Rust (from adsb-feed/rust/)
cargo test --workspace

# TypeScript (from this directory)
npm test

# Full CI gate
cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check
npm test && npm run lint
```

## Part of the ADS-B Project

This desktop app is one component of a larger ADS-B data pipeline. See the [project root](../../../) for the full architecture including Apache Pulsar streaming, Spark processing with Delta Lake, and the Dash web visualization.
