# Status Event Audit Trail

**Date**: 2026-03-28
**Status**: Implemented

## Goal

Persist connection and feed lifecycle events to DuckDB for audit purposes and display them in a timeline UI within the DB History panel.

## Problem

Status transitions (Connected, Degraded, ConnectionLost, etc.) were only visible in real-time via Tauri events and log output. No persistent record survived app restarts, making it impossible to review past connection health or diagnose intermittent issues.

## Design

### Option Considered

Two approaches were evaluated via staff-level review:

- **Option A (chosen)**: `StatusEventRecorder` wrapping `SharedStorage` — one consumer (DuckDB), simple `record()` method, defer observer pattern until a second consumer exists.
- **Option B (rejected)**: Full observer/subscriber pattern with `EventBus`, `tokio::spawn` per event, trait-based listeners. Over-engineered for one consumer; adds complexity without benefit.

### Architecture

- **Backend**: `StatusEventRecorder` in `bridge.rs` wraps `SharedStorage`, provides non-fatal `record()` method. Cloned into `client_task` and `socket_watchdog` background tasks.
- **Storage**: `status_events` DuckDB table with `(timestamp_ms, event_type, status, detail, source_id)`. Enum types (`StatusEventType`, `StatusEventStatus`) serialize to strings via `Display`/`FromStr`.
- **Query**: `get_status_timeline` Tauri command with optional time/type filters, DESC order, default limit 500.
- **Frontend**: `StatusTimeline` component in DB History panel — collapsible, lazy-loaded, with filter pills and color-coded timeline dots.

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| Simple recorder, not observer pattern | YAGNI — one consumer exists; `record()` → `emit()` refactor is trivial when needed |
| Enums not strings | Compile-time safety for event_type and status values |
| `execute` not Appender | Low-frequency single inserts (a few per session) |
| Non-fatal persistence | Recorder failure must never block the feed |
| No heartbeat persistence | Avoids ~1440 redundant rows/day |
| Excluded from export/import | Status events are instance-local audit data |
| Transitions only in watchdog | Connected/Degraded/ConnectionLost on change, not every 5s check |

## Implementation

### Phase 1: Data Engine (`adsb-data-engine`)
- Added `StatusEvent`, `StatusEventType`, `StatusEventStatus`, `StatusEventQuery` types with `Display`/`FromStr`
- Added `status_events` table to DuckDB schema with indexes
- Added `insert_status_event_sync`/`query_status_events_sync` + async wrappers
- Updated `StorageStats` with `status_event_count`
- 9 tests covering roundtrip, filtering, ordering, builder pattern

### Phase 2: Tauri Backend (`src-tauri/`)
- Added `StatusEventRecorder` struct in `bridge.rs`
- Instrumented `client_task`: Connecting, Error, Stopped, Disconnected
- Instrumented `socket_watchdog`: Connected, Degraded, ConnectionLost (transitions only)
- Instrumented `commands.rs`: Feed Started/Stopped, Storage Released/Reclaimed
- Added `get_status_timeline` command
- Records `Feed`/`AppStart` in `init_storage`

### Phase 3: Frontend (`src/`)
- Added TypeScript types: `StatusEvent`, `StatusEventType`, `StatusEventStatus`, `StatusEventQuery`
- Added `getStatusTimeline` command wrapper
- Created `StatusTimeline` component with color-coded dots, duration display, type filter pills
- Integrated as collapsible section in `DBHistoryContent`
- 11 component tests + 3 command wrapper tests

### Phase 4: Documentation
- Updated DESIGN.md: lib.rs commands, bridge.rs StatusEventRecorder, commands.rs timeline command, DuckDB schema, new "Status Event Audit Trail" section
- Created this plan document

## Files Modified/Created

| File | Action |
|------|--------|
| `adsb-data-engine/src/types.rs` | Modified — added enums, StatusEvent, StatusEventQuery, updated StorageStats |
| `adsb-data-engine/src/lib.rs` | Modified — re-exports |
| `adsb-data-engine/src/storage.rs` | Modified — schema, insert/query methods, 9 tests |
| `src-tauri/src/bridge.rs` | Modified — StatusEventRecorder, instrumented client_task + watchdog |
| `src-tauri/src/commands.rs` | Modified — get_status_timeline, lifecycle recording |
| `src-tauri/src/lib.rs` | Modified — command registration, AppStart recording |
| `src/lib/types.ts` | Modified — TS types |
| `src/lib/commands.ts` | Modified — getStatusTimeline wrapper |
| `src/lib/__tests__/commands.test.ts` | Modified — 3 new tests, updated sampleStats |
| `src/components/StatusTimeline.tsx` | **Created** — timeline component |
| `src/components/__tests__/StatusTimeline.test.tsx` | **Created** — 11 tests |
| `src/components/DBHistoryContent.tsx` | Modified — integrated StatusTimeline section |
| `src/components/__tests__/DBHistoryContent.test.tsx` | Modified — updated sampleStats |
| `docs/DESIGN.md` | Modified — new section + updates to existing sections |
