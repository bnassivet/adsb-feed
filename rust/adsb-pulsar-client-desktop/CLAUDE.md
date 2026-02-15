# CLAUDE.md - ADS-B Desktop App (Tauri + Next.js)

This file provides guidance to Claude Code when working with the Tauri desktop application.

## Project Overview

Desktop aircraft tracker built with Tauri v2 (Rust backend) + Next.js 15 + React 19. Connects to dump1090 via the `adsb-pulsar-client` library and displays real-time aircraft positions on an interactive Leaflet map.

## Architecture

### Stack

- **Backend**: Tauri v2 Rust (`src-tauri/src/`)
- **Frontend**: Next.js 15 App Router + React 19 (`src/`)
- **Styling**: Tailwind CSS v4
- **Map**: Leaflet via react-leaflet (dynamic import, SSR disabled)
- **Build**: Next.js `output: 'export'` for Tauri static file serving

### Source Layout

```
src-tauri/src/
├── lib.rs          # Tauri app builder, command/plugin registration
├── main.rs         # Entry point (calls lib::run)
├── bridge.rs       # Feed bridge: ADSBFeedClient → Tauri events (throttled)
├── commands.rs     # Tauri IPC commands (start/stop feed, get status/config)
├── sbs_parser.rs   # SBS-1 CSV parser (22-field MSG messages)
└── state.rs        # AppState, ConnectionStatus, StatusResponse

src/
├── app/            # Next.js App Router pages
├── components/     # React components (Map, AircraftTable, Filters, etc.)
├── hooks/          # Custom hooks (useAircraftTracks, useLocalStorage, etc.)
├── lib/            # Pure utilities (colors, types, h3-density, format)
└── test/           # Test setup and mocks
```

### Key Patterns

- **Tauri bridge** throttles ~50k msg/s down to ~2 updates/sec via HashMap buffer flushed every 500ms
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

### Rust Tests (src-tauri/)

Tauri crate tests (~19 tests) live inline in each module:

| Module | Tests | What's Covered |
|--------|-------|----------------|
| `sbs_parser.rs` | 14 | MSG subtypes 1/3/4/5, empty hex_ident, whitespace trimming, is_on_ground values, negative altitude, extra fields, non-numeric fields, parse_bool edge cases |
| `state.rs` | 5 | AppState defaults, feed_handle starts None, initial status, ConnectionStatus/StatusResponse JSON serialization |

```bash
# From adsb-feed/rust/
cargo test -p adsb-pulsar-client-desktop-lib          # All Tauri tests
cargo test -p adsb-pulsar-client-desktop-lib sbs_parser  # Parser only
cargo test -p adsb-pulsar-client-desktop-lib state       # State only
```

**Not tested (and why):**
- `commands.rs` / `bridge.rs` — tightly coupled to `tauri::AppHandle`
- Tested via Tauri integration testing, not unit tests

### TypeScript Tests (src/)

Test stack: **Vitest** + jsdom + @testing-library/react + @testing-library/user-event

| Directory | Tests | What's Covered |
|-----------|-------|----------------|
| `src/lib/__tests__/` | ~18 | `altitudeToColor`, `zoomToH3Resolution`, `computeH3Density`, `formatBytes`/`timeAgo` |
| `src/hooks/__tests__/` | ~12 | `useLocalStorage`, `useAircraftTracks` filter logic, `useSimulatedTracks` heading/interpolation |
| `src/components/__tests__/` | ~12 | `ConnectionStatus` states, `MetricsBar` formatting, `Filters` interactions |

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
# Rust
cargo test -p adsb-pulsar-client-desktop-lib && cargo clippy -p adsb-pulsar-client-desktop-lib -- -D warnings

# TypeScript
npm test && npx next lint
```

## Code Conventions

### Rust (src-tauri/)
- SBS-1 parsing: 22 comma-separated fields; MSG types 1-8 each populate different subsets
- Use `Option<T>` for all SBS fields except `hex_ident` and `timestamp`
- `AircraftPosition` derives `Serialize` for Tauri event emission

### TypeScript (src/)
- Pure utility functions go in `src/lib/` — fully testable without React
- Hooks that contain pure logic should export the pure function separately for direct testing
- Components use `"use client"` directive (Next.js App Router)
- Map components use `dynamic()` with `{ ssr: false }` for Leaflet compatibility

## Gotchas

- Root `.gitignore` has `lib/` which silently ignores `src/lib/`. Negated with `!**/src/lib/`
- Tauri v2 commands silently fail without proper permissions in `capabilities/default.json`
- `create-next-app` fails if `src-tauri/` exists — scaffold manually or use temp dir
- Workspace dep names use hyphens (`adsb-pulsar-client`), Rust `use` statements use underscores (`adsb_pulsar_client`)
