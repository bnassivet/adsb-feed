# CLAUDE.md - ADS-B Desktop App (Tauri + Next.js)

This file provides guidance to Claude Code when working with the Tauri desktop application.

## Project Overview

Desktop aircraft tracker built with Tauri v2 (Rust backend) + Next.js 15 + React 19. Connects to dump1090 via the `adsb-pulsar-client` library and displays real-time aircraft positions on an interactive Leaflet map.

## Architecture

### Stack

- **Backend**: Tauri v2 Rust (`src-tauri/src/`)
- **Shared library**: `adsb-data-engine` (workspace crate) — SBS-1 parser + DuckDB persistent storage
- **Frontend**: Next.js 15 App Router + React 19 (`src/`)
- **Styling**: Tailwind CSS v4
- **Map**: Leaflet via react-leaflet (dynamic import, SSR disabled)
- **Build**: Next.js `output: 'export'` for Tauri static file serving

### Source Layout

```
../adsb-data-engine/src/      # Workspace crate (shared library)
├── lib.rs          # Re-exports: parse_sbs_message, AircraftPosition, StorageHandle, query types
├── sbs_parser.rs   # SBS-1 CSV parser (22-field MSG messages) — moved from src-tauri
├── storage.rs      # DuckDB StorageHandle: insert_batch, query_bbox, get_trajectory, etc.
├── types.rs        # Domain types: PositionRecord, BboxQuery, TrajectoryQuery, AircraftSummary, StorageStats
└── error.rs        # StorageError types

src-tauri/src/
├── lib.rs          # Tauri app builder, command/plugin registration, init_storage()
├── main.rs         # Entry point (calls lib::run)
├── bridge.rs       # Feed bridge: ADSBFeedClient → Tauri events (throttled) + DuckDB writes
├── commands.rs     # Tauri IPC commands: feed control + DuckDB historical queries + storage management (release/reclaim/export)
└── state.rs        # AppState (SharedStorage, StorageAvailability, StorageConfig), ConnectionStatus, StatusResponse

src/
├── app/            # Next.js App Router pages
├── components/     # React components (Map, AircraftTable, AircraftDetailsPanel, Filters, etc.)
├── hooks/          # Custom hooks (useAircraftTracks, useLocalStorage, etc.)
├── lib/            # Pure utilities (colors, types, h3-density, format, aircraft-details, commands)
└── test/           # Test setup and mocks
```

### Key Patterns

- **Tauri bridge** throttles ~50k msg/s down to ~2 updates/sec via HashMap buffer flushed every 500ms; tracks per-aircraft message counts pre-throttle
- **DuckDB writes on every flush**: each 500ms batch is persisted to `adsb_history.db` via `StorageHandle::insert_batch()` — non-fatal if storage is unavailable
- **Graceful DuckDB degradation**: `AppState.storage: SharedStorage` (`Arc<RwLock<Option<StorageHandle>>>`) — `None` if DuckDB init fails or connection is released; app runs in real-time-only mode; all historical query commands return `"Storage not available"`
- **Storage management**: Release/reclaim DuckDB connection at runtime (for external tool access); live export via DuckDB `ATTACH`+`CREATE TABLE AS` without stopping recording; import/merge from external `.db` files with deduplication; `StorageConfig` retained in AppState for reopening after release
- `broadcast::channel` as message tap — fire-and-forget (`let _ = tx.send()`)
- `watch::channel` for shutdown signal
- Tauri v2 capability-based permissions in `src-tauri/capabilities/default.json`

## Build and Development

```bash
# Install frontend dependencies
npm install

# Development (hot reload)
npm run tauri dev

# Build frontend only
npx next build

# Build full Tauri app
npm run tauri build
```

## Testing

### TDD Workflow

All changes follow Test-Driven Development:
1. **Red**: Write a failing test first
2. **Green**: Minimum code to make it pass
3. **Refactor**: Clean up while tests stay green

**No code lands without a test.**

### Rust Tests

**adsb-data-engine** crate (~113 tests, in `adsb-data-engine/src/`):

| Module | Tests | What's Covered |
|--------|-------|----------------|
| `sbs_parser.rs` | 15 | MSG subtypes 1/3/4/5, empty hex_ident, whitespace trimming, is_on_ground values, negative altitude, extra fields, non-numeric fields, parse_bool edge cases, message_count default |

**Tauri crate** tests (~5 tests, inline in `src-tauri/src/`):

| Module | Tests | What's Covered |
|--------|-------|----------------|
| `state.rs` | 5 | AppState defaults, feed_handle starts None, initial status, ConnectionStatus/StatusResponse JSON serialization |

```bash
# From adsb-feed/rust/
cargo test -p adsb-data-engine                        # Data engine: parser + storage
cargo test -p adsb-pulsar-client-desktop-lib          # Tauri: state tests
cargo test -p adsb-data-engine sbs_parser             # Parser only
```

**Not tested (and why):**
- `commands.rs` / `bridge.rs` — tightly coupled to `tauri::AppHandle`
- Tested via Tauri integration testing, not unit tests

### TypeScript Tests (src/)

Test stack: **Vitest** + jsdom + @testing-library/react + @testing-library/user-event

| Directory | Tests | What's Covered |
|-----------|-------|----------------|
| `src/lib/__tests__/` | ~84+ | `altitudeToColor`, `zoomToH3Resolution`, `computeH3Density`, `formatBytes`/`timeAgo`, `track-ordering`, `aircraft-icon`, `verticalTendency`/`formatVerticalRate`/`altitudeHistory`/`altitudeSparklinePoints`/`altitudeRange`/`formatTrackTime`, **DuckDB command wrappers** (`commands.test.ts` — incl. import) |
| `src/contexts/__tests__/` | ~5 | `appendPosition`, `mergePositionInto` message_count accumulation |
| `src/hooks/__tests__/` | ~13 | `useLocalStorage`, `useAircraftTracks` filter logic, `useSimulatedTracks` heading/interpolation |
| `src/components/__tests__/` | ~57 | `ConnectionStatus` states, `MetricsBar` formatting + import button, `Filters` interactions, `AircraftTable` selection/RxTS/Msg#, `AltitudeLegend`, `AircraftDetailsPanel` fold/unfold/identity/tendency/sparkline/axes |

```bash
npm test                          # All tests once (CI mode)
npm run test:watch                # Interactive watch mode (TDD)
npx vitest run src/lib/__tests__  # Single directory
npx vitest run --reporter=verbose # Verbose with test names
```

**Test infrastructure:**
- `src/test/setup.ts` — imports @testing-library/jest-dom matchers
- `src/test/mocks/tauri.ts` — mocks `@tauri-apps/api/core` (invoke) and `@tauri-apps/api/event` (listen)
- `vitest.config.ts` — jsdom environment, `@/` path alias, setup files

**Not tested (and why):**
- `MapInner.tsx` — Leaflet internals need complex DOM mocking for minimal value

### CI Gate

```bash
# Rust (both data engine and Tauri crate)
cargo test -p adsb-data-engine && cargo test -p adsb-pulsar-client-desktop-lib && cargo clippy --workspace -- -D warnings

# TypeScript
npm test && npx next lint
```

## Code Conventions

### Rust (adsb-data-engine + src-tauri/)
- SBS-1 parsing lives in `adsb-data-engine/src/sbs_parser.rs` (shared crate), not in the Tauri crate
- SBS-1 parsing: 22 comma-separated fields; MSG types 1-8 each populate different subsets
- Use `Option<T>` for all SBS fields except `hex_ident`, `timestamp`, and `message_count`
- `AircraftPosition` derives `Serialize` for Tauri event emission
- `message_count: u64` defaults to 0 in parser; actual count set by bridge before emission
- DuckDB queries use `tokio::task::spawn_blocking` because `duckdb-rs` is synchronous (blocking FFI)

### TypeScript (src/)
- Pure utility functions go in `src/lib/` — fully testable without React
- Hooks that contain pure logic should export the pure function separately for direct testing
- Components use `"use client"` directive (Next.js App Router)
- Map components use `dynamic()` with `{ ssr: false }` for Leaflet compatibility

### AircraftTrack type (src/lib/types.ts)
- `first_seen: number` — ms epoch of first detection; set once in `AircraftTrackingContext`, never updated by `mergePositionInto`
- `last_seen: number` — ms epoch of most recent update
- `positions: [lat, lng, altitude | null][]` — capped at 100 entries; no per-position timestamps
- GeoJSON export/import (`src/lib/geojson.ts`) serialises both `first_seen` and `last_seen` in feature properties; `first_seen` falls back to `last_seen` for legacy files

### AircraftDetailsPanel (src/components/AircraftDetailsPanel.tsx)
- Collapsible right panel rendered beside the map when an aircraft is selected (`selectedTrack !== null`)
- Three states: hidden (track=null), collapsed 32px strip (`>>` button), expanded (user-resizable, 200–480px)
- Width and open state persisted via `useLocalStorage` keys `adsb-details-panel-open` / `adsb-details-panel-width`
- Left edge is a draggable `col-resize` strip (mirrors `ResizeHandle` but horizontal, width delta owned internally)
- Sparkline: last ≤100 altitude positions rendered as SVG `<polyline>`; y-axis shows min/max ft labels; x-axis shows `HH:MM:SS` of `first_seen` and `last_seen`

## Gotchas

- Root `.gitignore` has `lib/` which silently ignores `src/lib/`. Negated with `!**/src/lib/`
- Tauri v2 commands silently fail without proper permissions in `capabilities/default.json`
- `create-next-app` fails if `src-tauri/` exists — scaffold manually or use temp dir
- Workspace dep names use hyphens (`adsb-pulsar-client`), Rust `use` statements use underscores (`adsb_pulsar_client`)
- DuckDB historical query commands return `"Storage not available"` if init failed — callers must handle this gracefully
- `sbs_parser.rs` is in `adsb-data-engine` crate, NOT in `src-tauri/src/` (was moved as part of shared library refactor)
