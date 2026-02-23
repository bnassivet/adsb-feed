# DuckDB History UI

**Date**: 2026-02-23
**Status**: Approved

## Problem

The DuckDB backend is fully implemented and persisting data continuously, but there is no UI to query it. Four Tauri commands and four TypeScript wrappers exist and are tested, but the user has no way to:

1. Browse aircraft that flew in a past time window (`getAircraftSummary`)
2. Replay a historical trajectory for a specific aircraft (`getTrajectory`)
3. Search for all positions within a bounding box + time window (`queryBbox`)
4. See database health and record count (`getStorageStats`)

The only "history" visible today is the in-memory 6-hour React context buffer — not the durable DuckDB store.

## Background: What Already Exists

### Backend (complete, no changes needed)

| Layer | File | Status |
|-------|------|--------|
| Storage engine | `adsb-data-engine/src/storage.rs` | ✅ Done |
| Type definitions (Rust) | `adsb-data-engine/src/types.rs` | ✅ Done |
| Tauri commands | `src-tauri/src/commands.rs` | ✅ Done |
| Graceful degradation | `AppState.storage: Option<StorageHandle>` | ✅ Done |

### Frontend (complete, no changes needed)

| Layer | File | Status |
|-------|------|--------|
| TypeScript types | `src/lib/types.ts` (PositionRecord, BboxQuery, TrajectoryQuery, AircraftSummary, StorageStats) | ✅ Done |
| Command wrappers | `src/lib/commands.ts` (queryBbox, getTrajectory, getAircraftSummary, getStorageStats) | ✅ Done |
| Command tests | `src/lib/__tests__/commands.test.ts` | ✅ Done |

**Only UI work is needed.**

## Design

### Approach: HistoryBrowser panel in the LeftPanel

Add a collapsible **HistoryBrowser** section below the existing Filters in `LeftPanel` / `FiltersPanel`. The section has two sub-panels:

1. **Stats strip** — always visible when storage is available; shows row count, DB size, oldest/newest timestamps. Calls `getStorageStats()` on mount and on manual refresh.

2. **Aircraft list** — shown when "Browse DB History" is expanded; shows `getAircraftSummary()` results for the selected time window. Clicking a row calls `getTrajectory()` and injects the result as imported tracks (`importTracks`) so they appear on the map and table using the existing imported-track pipeline.

### Time range picker

A compact two-input time range (start / end datetime-local inputs) stored in component state. Default: last 1 hour. Used for both `getAircraftSummary` and `getTrajectory`.

### Data flow

```
HistoryBrowser
  │ on mount / refresh
  ├── getStorageStats()  → StorageStats → render strip
  │
  │ on "Browse" click / time range change
  ├── getAircraftSummary(startMs, endMs)  → AircraftSummary[] → render list
  │
  │ on row click
  └── getTrajectory({ hex_ident, start_ms, end_ms })
        → PositionRecord[]
        → convert to AircraftTrack[]
        → importTracks(tracks)  ← existing hook, handles map + table
```

### AircraftTrack conversion

`PositionRecord[]` (DuckDB rows for one aircraft) → one `AircraftTrack`:

```ts
function recordsToTrack(records: PositionRecord[]): AircraftTrack {
  const sorted = [...records].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const last = sorted[sorted.length - 1];
  return {
    hex_ident: last.hex_ident,
    callsign: last.callsign,
    altitude: last.altitude,
    ground_speed: last.ground_speed,
    track: last.track,
    latitude: last.latitude,
    longitude: last.longitude,
    vertical_rate: last.vertical_rate,
    squawk: last.squawk,
    is_on_ground: last.is_on_ground,
    timestamp: new Date(last.timestamp_ms).toISOString(),
    positions: sorted.map(r => [r.latitude, r.longitude, r.altitude] as [number, number, number | null]),
    first_seen: sorted[0].timestamp_ms,
    last_seen: last.timestamp_ms,
    message_count: sorted.length,
  };
}
```

This function lives in `src/lib/history-convert.ts` (pure utility → fully testable).

### "Storage not available" handling

All four DuckDB commands return the string `"Storage not available"` (not an error throw) when DuckDB init failed. The UI checks: if `getStorageStats()` returns a string, render a "History unavailable" notice instead of the browser panel.

### Integration with existing imported-track pipeline

DuckDB trajectories are loaded via the existing `importTracks` function from `useAircraftTracks`. They appear:
- In the `AircraftTable` under the "Imported" section (with indigo styling)
- On the map as imported Polylines / DotsLayer
- In `AircraftDetailsPanel` with the IMPORTED badge

No new rendering paths needed.

### Files to create

| File | Purpose |
|------|---------|
| `src/lib/history-convert.ts` | `recordsToTrack(records)` pure utility |
| `src/lib/__tests__/history-convert.test.ts` | Unit tests for conversion |
| `src/components/HistoryBrowser.tsx` | Browser panel component |
| `src/components/__tests__/HistoryBrowser.test.tsx` | Component tests |

### Files to modify

| File | Change |
|------|--------|
| `src/components/Filters.tsx` | Add `<HistoryBrowser>` section at bottom of `FiltersPanel` |
| `src/app/page.tsx` | Pass `importTracks` down via `LeftPanel` → `FiltersPanel` props |
| `src/components/LeftPanel.tsx` | Thread `importTracks` prop |

### Props threading

`importTracks` already exists in `page.tsx` via `useAircraftTracks`. We need to thread it:

```
page.tsx → LeftPanel → FiltersPanel → HistoryBrowser
```

### Alignment with DESIGN.md

| Principle | Alignment |
|-----------|-----------|
| Graceful degradation | ✅ "History unavailable" when storage = None |
| Imported-track pipeline | ✅ DuckDB results injected via existing `importTracks` |
| No backend changes | ✅ All 4 commands already exist |
| TDD | ✅ `history-convert.ts` is pure; `HistoryBrowser` tested with mocked commands |
| YAGNI | ✅ No bbox query UI in initial version (trajectory-first) |

### What is NOT in scope (v1)

- `queryBbox` (geographic bounding box search) — deferred; trajectory-by-aircraft is the primary use case
- Auto-refresh / polling of the history browser
- Pagination of `getAircraftSummary` results (backend returns up to 1000 rows)
- DuckDB data pruning / TTL management UI
