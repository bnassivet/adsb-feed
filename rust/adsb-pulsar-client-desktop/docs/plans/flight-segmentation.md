# Flight Segmentation for DB History Aircraft List

## Context

Currently, the DB History panel lists aircraft by `hex_ident` only — all positions for a given aircraft in the time window are aggregated into one `AircraftSummary`. This is misleading when the same aircraft (hex_ident) appears multiple times in a time window (e.g., different flights hours apart). The user wants a "flight" concept: same hex_ident with a gap > configurable threshold (default 1h) = different flights, each showing its own callsign and time range.

## Approach

1. **New DuckDB query** (`get_flight_summary`) using window functions (`LAG` + cumulative `SUM`) to segment positions into flights by detecting time gaps. The existing `get_aircraft_summary` stays untouched (analytics uses it).

2. **`track_id` field on `AircraftTrack`** — optional string used as the unique key across ALL track Maps (live, history, imported, dbHistory, analysis) and ALL table sections. Every Map operation and every table row key uses `t.track_id ?? t.hex_ident`. This ensures multiple flights of the same hex_ident can coexist in any Map.

## Implementation

### 1. Rust Data Engine — New Types (`adsb-data-engine/src/types.rs`)

Add two new structs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightSummary {
    pub hex_ident: String,
    pub flight_num: u32,         // 0-based index per hex_ident
    pub flight_id: String,       // "{hex_ident}_{flight_num}"
    pub callsign: Option<String>,
    pub position_count: u64,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub min_altitude: Option<f64>,
    pub max_altitude: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightSummaryQuery {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub gap_threshold_ms: i64,   // Default: 3_600_000 (1h)
}
```

Re-export both from `lib.rs`.

### 2. Rust Data Engine — New Query (`adsb-data-engine/src/storage.rs`)

New method `get_flight_summary_sync` using this SQL:

```sql
WITH ordered AS (
    SELECT hex_ident, callsign, altitude, timestamp_ms,
           LAG(timestamp_ms) OVER (PARTITION BY hex_ident ORDER BY timestamp_ms) AS prev_ts
    FROM positions
    WHERE [time filters]
),
flights AS (
    SELECT *,
           SUM(CASE WHEN prev_ts IS NULL OR timestamp_ms - prev_ts > ?gap THEN 1 ELSE 0 END)
               OVER (PARTITION BY hex_ident ORDER BY timestamp_ms) - 1 AS flight_num
    FROM ordered
)
SELECT hex_ident, CAST(flight_num AS INTEGER) AS flight_num,
       MAX(callsign) AS callsign,
       COUNT(*) AS position_count,
       MIN(timestamp_ms) AS first_seen_ms,
       MAX(timestamp_ms) AS last_seen_ms,
       MIN(altitude) AS min_altitude,
       MAX(altitude) AS max_altitude
FROM flights
GROUP BY hex_ident, flight_num
ORDER BY last_seen_ms DESC
```

The `- 1` makes `flight_num` 0-based. The `flight_id` is computed in Rust as `format!("{hex_ident}_{flight_num}")`.

Add the async wrapper following the existing pattern (`spawn_blocking`).

### 3. Rust Data Engine — Tests (TDD: write FIRST)

Write these tests in `storage.rs` `#[cfg(test)]`:

| # | Test | Verifies |
|---|------|----------|
| 1 | `test_flight_summary_single_flight` | 1 hex, positions close together → 1 flight |
| 2 | `test_flight_summary_gap_splits_flights` | 1 hex, gap > threshold → 2 flights with correct time ranges |
| 3 | `test_flight_summary_callsign_per_flight` | Different callsigns across flights are preserved separately |
| 4 | `test_flight_summary_multiple_aircraft` | 2 hex_idents → at least 2 results, ordered by last_seen DESC |
| 5 | `test_flight_summary_time_filter` | start_ms/end_ms bounds correctly |
| 6 | `test_flight_summary_custom_threshold` | Smaller threshold splits what 1h wouldn't |
| 7 | `test_flight_summary_flight_id_format` | flight_id = "{hex_ident}_{flight_num}" |

Test setup: in-memory DuckDB via `StorageHandle::open(StorageConfig::default())`, insert test positions with known timestamps.

### 4. Tauri Command Layer (`src-tauri/src/commands.rs` + `lib.rs`)

New command:
```rust
#[tauri::command]
pub async fn get_flight_summary(
    query: FlightSummaryQuery,
    state: State<'_, AppState>,
) -> Result<Vec<FlightSummary>, String>
```

Register in `lib.rs` `invoke_handler`.

### 5. TypeScript Types (`src/lib/types.ts`)

Add `FlightSummary` and `FlightSummaryQuery` interfaces mirroring Rust.

Add optional `track_id` to `AircraftTrack`:
```typescript
export interface AircraftTrack {
  // ... existing fields ...
  /** Optional unique track identifier. Used as Map key instead of hex_ident when set.
   *  Set to flight_id when loaded from DB history flight segmentation. */
  track_id?: string;
}
```

### 6. TypeScript Command (`src/lib/commands.ts`)

Add `getFlightSummary(query: FlightSummaryQuery): Promise<FlightSummary[]>` wrapper.

### 7. `trackKey` Helper + AircraftTrackingContext (`src/contexts/AircraftTrackingContext.tsx`)

Add a `trackKey` helper used by ALL Map operations:

```typescript
/** Returns the unique key for a track: track_id if set, otherwise hex_ident. */
export const trackKey = (t: AircraftTrack) => t.track_id ?? t.hex_ident;
```

Update ALL Map keying across every track category:

**Live tracks** (`handleBatch`):
Live tracks come from real-time events and won't have `track_id` set, so behavior is unchanged. No code change needed here — `hex_ident` keying stays as-is for the real-time path since we don't have a `track_id` on `AircraftPosition`.

**History tracks** (`historyRef` — TTL expiry from live + startup auto-load):
- TTL expiry: moves track from tracksRef to historyRef — key is already hex_ident, unchanged.
- Auto-load (queryBbox on startup): update to use `recordsToFlightTracks()` (see step 9) which splits by time gaps. Each resulting track gets `track_id = "{hex_ident}_{flightNum}"`.

**Imported tracks** (`importTracks`):
```typescript
const importTracks = useCallback((tracks: AircraftTrack[]) => {
  const map = importedRef.current;
  map.clear();
  for (const t of tracks) map.set(trackKey(t), t);
  setUpdateCounter((c) => c + 1);
}, []);
```

**DB History tracks** (`loadDbHistoryTracks`):
```typescript
const loadDbHistoryTracks = useCallback((tracks: AircraftTrack[]) => {
  const map = dbHistoryRef.current;
  map.clear();
  for (const t of tracks) map.set(trackKey(t), t);
  setUpdateCounter((c) => c + 1);
}, []);
```

**Analysis tracks** (`addAnalysisTracks`, `removeAnalysisTrack`):
```typescript
const addAnalysisTracks = useCallback((tracks: AircraftTrack[]) => {
  const map = analysisRef.current;
  for (const t of tracks) map.set(trackKey(t), t);
  setUpdateCounter((c) => c + 1);
}, []);

const removeAnalysisTrack = useCallback((trackId: string) => {
  analysisRef.current.delete(trackId);
  setUpdateCounter((c) => c + 1);
}, []);
```

### 8. AircraftTable (`src/components/AircraftTable.tsx`)

Use `track_id ?? hex_ident` for row keys and remove button in ALL table sections:

```typescript
// Live/Analysis section rows (lines ~153-155):
key={t.track_id ?? t.hex_ident}
data-testid={`row-${t.track_id ?? t.hex_ident}`}

// History section rows (lines ~263-265):
key={`hist-${t.track_id ?? t.hex_ident}`}

// DB History section rows (lines ~355-357):
key={`dbhist-${t.track_id ?? t.hex_ident}`}

// Imported section rows (lines ~426-428):
key={`imported-${t.track_id ?? t.hex_ident}`}

// Remove button (line ~230):
onRemoveTrack(t.track_id ?? t.hex_ident)

// Eye visibility toggle:
onToggleMapVisibility(t.track_id ?? t.hex_ident, ...)
```

Update `onRemoveTrack` prop type name from `hexIdent` to `trackId` for clarity.

### 9. `history-convert.ts` — New `recordsToFlightTracks()`

Add a flight-aware conversion function that splits records by time gap:

```typescript
/**
 * Groups PositionRecord rows by hex_ident, then splits each group into
 * separate flights when consecutive positions are separated by > gapMs.
 * Each resulting AircraftTrack gets a track_id of "{hex_ident}_{flightNum}".
 */
export function recordsToFlightTracks(
  records: PositionRecord[],
  gapMs: number = 3_600_000, // 1 hour default
): AircraftTrack[] {
  // Group by hex_ident
  const groups = new Map<string, PositionRecord[]>();
  for (const r of records) {
    const arr = groups.get(r.hex_ident);
    if (arr) arr.push(r);
    else groups.set(r.hex_ident, [r]);
  }

  const tracks: AircraftTrack[] = [];
  for (const [hexIdent, recs] of groups) {
    // Sort by timestamp
    const sorted = recs.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    // Split into flights by time gap
    let flightNum = 0;
    let flightStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      if (i === sorted.length || sorted[i].timestamp_ms - sorted[i - 1].timestamp_ms > gapMs) {
        const flightRecords = sorted.slice(flightStart, i);
        const track = recordsToTrack(flightRecords);
        track.track_id = `${hexIdent}_${flightNum}`;
        tracks.push(track);
        flightNum++;
        flightStart = i;
      }
    }
  }
  return tracks;
}
```

The existing `recordsToTracks()` and `recordsToTrack()` stay unchanged for backward compatibility.

### 9b. AircraftTrackingContext — Startup Auto-Load Update

Update the `useEffect` that auto-loads from DuckDB on startup to use `recordsToFlightTracks`:

```typescript
// Current (line ~221-228):
const tracks = recordsToTracks(records);
const map = historyRef.current;
for (const t of tracks) map.set(t.hex_ident, t);

// Updated:
const tracks = recordsToFlightTracks(records); // Flight-segmented with track_id
const map = historyRef.current;
for (const t of tracks) map.set(trackKey(t), t); // Uses track_id as key
```

Import `recordsToFlightTracks` from `@/lib/history-convert`.

### 10. Frontend — `DBHistoryContent.tsx`

**New state:**
- `flightSummaries: FlightSummary[]` — drives the list
- `gapThresholdMinutes: number` — default 60, persisted via `useLocalStorage`
- `selectedFlights: Set<string>` — keyed by `flight_id` (replaces `selectedAircraft: Set<string>`)

**`doBrowse` changes:**
- Add `getFlightSummary({ start_ms, end_ms, gap_threshold_ms: gapThresholdMinutes * 60_000 })` to the parallel `Promise.all`
- Continue calling `getAircraftSummary` for analytics compatibility

**List rendering changes:**
- Header: "Flights (N)" with distinct aircraft count subtitle
- Key: `f.flight_id`
- Primary text: `f.callsign ?? f.hex_ident`
- Secondary: hex_ident + time range `formatTime(first_seen) – formatTime(last_seen)`
- Position count + altitude range (same as before)
- Checkbox keyed by `f.flight_id`

**Trajectory loading — set `track_id` on every loaded track:**
```typescript
async function handleLoadTrajectory(flight: FlightSummary) {
  const records = await getTrajectory({
    hex_ident: flight.hex_ident,
    start_ms: flight.first_seen_ms,  // Flight's own time window, not global browse
    end_ms: flight.last_seen_ms,
  });
  if (!Array.isArray(records) || records.length === 0) return;
  const track = recordsToTrack(records);
  track.track_id = flight.flight_id;  // Key by flight, not hex_ident
  onLoadTracks([track]);
}
```

**`fetchSelectedTracks`** — same pattern: use each flight's time window and set `track_id`:
```typescript
async function fetchSelectedTracks(): Promise<AircraftTrack[]> {
  const selected = flightSummaries.filter(f => selectedFlights.has(f.flight_id));
  const results = await Promise.all(
    selected.map(f =>
      getTrajectory({ hex_ident: f.hex_ident, start_ms: f.first_seen_ms, end_ms: f.last_seen_ms })
        .then(records => ({ flight: f, records }))
    )
  );
  const tracks: AircraftTrack[] = [];
  for (const { flight, records } of results) {
    if (!Array.isArray(records) || records.length === 0) continue;
    const track = recordsToTrack(records);
    track.track_id = flight.flight_id;
    tracks.push(track);
  }
  return tracks;
}
```

**Gap threshold UI:**
- Small select/dropdown below time range presets: "Gap: 15m | 30m | 1h | 2h | 4h"
- Stored in `useLocalStorage("adsb-flight-gap-minutes", 60)`
- Changing re-triggers `doBrowse`

### 11. TypeScript Tests

**`DBHistoryContent.test.tsx`** — Update existing tests to mock `get_flight_summary` alongside `get_aircraft_summary`. Add new tests:

| # | Test | Verifies |
|---|------|----------|
| 1 | Two flights for same hex_ident | Both render in list with distinct keys |
| 2 | Selection by flight_id | Selecting one flight doesn't select another of same hex |
| 3 | Trajectory uses flight time range | `get_trajectory` called with flight's `first_seen_ms`/`last_seen_ms` |
| 4 | Gap threshold control | Renders, changing it calls `get_flight_summary` with new threshold |
| 5 | Batch load mixed flights | Correct trajectory queries for each flight |
| 6 | Loaded tracks have track_id set | Tracks passed to `onLoadTracks`/`onAddToAnalysis` have `track_id = flight_id` |

**`AircraftTrackingContext.test.tsx`** — Add tests for `track_id` keying:

| # | Test | Verifies |
|---|------|----------|
| 1 | addAnalysisTracks with track_id | Two tracks with same hex_ident but different track_id coexist in Map |
| 2 | addAnalysisTracks without track_id | Falls back to hex_ident key (backward compat) |
| 3 | removeAnalysisTrack by track_id | Removes correct track when multiple share hex_ident |
| 4 | loadDbHistoryTracks with track_id | Multiple flights per hex_ident coexist |
| 5 | importTracks with track_id | Uses track_id as key when present |

**`history-convert.test.ts`** (new or add to existing `src/lib/__tests__/`):

| # | Test | Verifies |
|---|------|----------|
| 1 | recordsToFlightTracks single flight | Positions within gap → 1 track with track_id "{hex}_0" |
| 2 | recordsToFlightTracks gap splits | Gap > threshold → 2 tracks with track_id "{hex}_0" and "{hex}_1" |
| 3 | recordsToFlightTracks multiple aircraft | Each hex_ident segmented independently |
| 4 | recordsToFlightTracks custom gap | Smaller gap splits more |
| 5 | recordsToFlightTracks preserves callsign per flight | Different callsigns per flight segment |

**`AircraftTable.test.tsx`** — if existing tests reference row keys by hex_ident, verify they still pass (tracks without track_id fall back to hex_ident).

## Files to Modify

| File | Change |
|------|--------|
| `adsb-data-engine/src/types.rs` | Add `FlightSummary`, `FlightSummaryQuery` |
| `adsb-data-engine/src/lib.rs` | Re-export new types |
| `adsb-data-engine/src/storage.rs` | Add `get_flight_summary_sync` + async + 7 tests |
| `src-tauri/src/commands.rs` | Add `get_flight_summary` command |
| `src-tauri/src/lib.rs` | Register command in invoke_handler |
| `src/lib/types.ts` | Add `FlightSummary`, `FlightSummaryQuery` + `track_id?` on `AircraftTrack` |
| `src/lib/commands.ts` | Add `getFlightSummary` wrapper |
| `src/lib/history-convert.ts` | Add `recordsToFlightTracks()` with gap-based splitting |
| `src/contexts/AircraftTrackingContext.tsx` | Add `trackKey` helper, use in ALL Map ops, update auto-load to `recordsToFlightTracks` |
| `src/components/AircraftTable.tsx` | Use `track_id ?? hex_ident` for ALL row keys + remove + eye toggle |
| `src/components/DBHistoryContent.tsx` | Flight list, gap threshold, selection by flight_id, set track_id on loaded tracks |
| `src/components/__tests__/DBHistoryContent.test.tsx` | Update mocks + 6 new tests |
| `src/lib/__tests__/history-convert.test.ts` | 5 new tests for `recordsToFlightTracks` |
| `src/contexts/__tests__/AircraftTrackingContext.test.tsx` | 5 new tests for track_id keying |

## Verification

1. `cargo test -p adsb-data-engine` — new flight summary tests pass
2. `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --workspace --check`
3. `npm test` — all TS tests pass including new flight/track_id tests
4. Manual: `npm run tauri dev` → DB History → browse a time range → verify flights split by gaps, select/load individual flights
5. Manual: change gap threshold → list updates with different flight segmentation
6. Manual: load 2 flights of same hex_ident → "→ Analysis" → both appear as separate rows in analysis table
7. Manual: remove one flight from analysis → other flight stays
8. Manual: restart app → history table shows flight-segmented tracks from auto-load
