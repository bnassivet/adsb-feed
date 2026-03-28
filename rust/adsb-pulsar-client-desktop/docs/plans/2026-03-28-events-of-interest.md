# Events of Interest — Implementation Plan

## Context

Add a new "Events of Interest" feature to the ADS-B desktop application. Users need to annotate their tracking data with notable events (e.g., military aircraft spotted, unusual flight pattern, emergency squawk). Events have a title, description, time reference (point or interval), and optional geographic reference (point or area). They are stored persistently in DuckDB and accessible via the UI through a header button, and a map context menu for location-aware creation.

### Extensibility Requirement

The data model must support future backend-generated events beyond manual user creation:
- **Automated detection** — e.g., anomaly detectors, emergency squawk monitors, military transponder classifiers
- **External feeds** — e.g., NOTAMs, aviation news, airspace alerts
- **Aircraft linking** — events should be associable with specific aircraft (by hex_ident)

This is achieved through `source`, `category`, `metadata` (JSON), and `linked_hex_idents` fields in the schema. The initial UI only exposes manual creation, but the storage layer and query API are designed for any producer.

---

## Phase 1: Rust Backend — adsb-data-engine

### 1.1 Add `uuid` dependency

**File:** `adsb-data-engine/Cargo.toml`

Add `uuid = { version = "1", features = ["v4"] }` to `[dependencies]`.

### 1.2 Add types

**File:** `adsb-data-engine/src/types.rs`

```rust
// New types to add:
pub struct EventOfInterest {
    pub id: String,
    pub title: String,
    pub description: String,
    pub timestamp_ms: i64,
    pub end_timestamp_ms: Option<i64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub bbox_north: Option<f64>,
    pub bbox_south: Option<f64>,
    pub bbox_east: Option<f64>,
    pub bbox_west: Option<f64>,
    /// Origin of the event: "user", "detector", "news_feed", etc.
    pub source: String,
    /// Classification: "military", "emergency", "anomaly", "observation", etc.
    pub category: Option<String>,
    /// JSON blob for source-specific data (detection confidence, article URL, etc.)
    pub metadata: Option<String>,
    /// Comma-separated hex_idents of associated aircraft (e.g., "A1B2C3,D4E5F6")
    pub linked_hex_idents: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

pub struct CreateEventOfInterest {
    pub title: String,
    pub description: String,
    pub timestamp_ms: i64,
    pub end_timestamp_ms: Option<i64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub bbox_north: Option<f64>,
    pub bbox_south: Option<f64>,
    pub bbox_east: Option<f64>,
    pub bbox_west: Option<f64>,
    /// Defaults to "user" if not provided.
    pub source: Option<String>,
    pub category: Option<String>,
    pub metadata: Option<String>,
    pub linked_hex_idents: Option<String>,
}

pub struct UpdateEventOfInterest {
    pub id: String,
    // same fields as Create (all required for full replace)
    pub title: String,
    pub description: String,
    pub timestamp_ms: i64,
    pub end_timestamp_ms: Option<i64>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub bbox_north: Option<f64>,
    pub bbox_south: Option<f64>,
    pub bbox_east: Option<f64>,
    pub bbox_west: Option<f64>,
    pub source: Option<String>,
    pub category: Option<String>,
    pub metadata: Option<String>,
    pub linked_hex_idents: Option<String>,
}

pub struct EventOfInterestQuery {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// Filter by source (e.g., "user", "detector")
    pub source: Option<String>,
    /// Filter by category (e.g., "military", "emergency")
    pub category: Option<String>,
    pub limit: Option<usize>,
}
```

All derive `Debug, Clone, Serialize, Deserialize`. Query also derives `Default`.

**Design notes on extensibility fields:**
- `source` defaults to `"user"` on insert — future detectors/feeds set their own source identifier
- `category` is free-form text now; can be constrained to an enum later if needed
- `metadata` is a JSON string — avoids schema changes when detectors add new output fields (e.g., `{"confidence": 0.95, "model": "squawk_classifier_v2"}`)
- `linked_hex_idents` as comma-separated keeps the schema flat and queryable via SQL `LIKE`; future upgrade to a junction table is possible without breaking the API
- Query supports `source` and `category` filters so the UI can show "my events" vs "detected events" etc.

### 1.3 Add DuckDB table

**File:** `adsb-data-engine/src/storage.rs` — append to `SCHEMA_SQL`

```sql
CREATE TABLE IF NOT EXISTS events_of_interest (
    id                  TEXT    PRIMARY KEY,
    title               TEXT    NOT NULL,
    description         TEXT    NOT NULL,
    timestamp_ms        BIGINT  NOT NULL,
    end_timestamp_ms    BIGINT,
    latitude            DOUBLE,
    longitude           DOUBLE,
    bbox_north          DOUBLE,
    bbox_south          DOUBLE,
    bbox_east           DOUBLE,
    bbox_west           DOUBLE,
    source              TEXT    NOT NULL DEFAULT 'user',
    category            TEXT,
    metadata            TEXT,
    linked_hex_idents   TEXT,
    created_at_ms       BIGINT  NOT NULL,
    updated_at_ms       BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eoi_ts ON events_of_interest (timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_eoi_created ON events_of_interest (created_at_ms);
CREATE INDEX IF NOT EXISTS idx_eoi_source ON events_of_interest (source);
CREATE INDEX IF NOT EXISTS idx_eoi_category ON events_of_interest (category);
```

### 1.4 Add StorageHandle CRUD methods

**File:** `adsb-data-engine/src/storage.rs`

Follow the `insert_status_event_sync` / `query_status_events_sync` pattern:

| Method | Pattern | Notes |
|--------|---------|-------|
| `insert_event_of_interest_sync(&self, event: &CreateEventOfInterest) -> Result<EventOfInterest>` | Prepared INSERT, generates UUID + timestamps | Returns created event |
| `query_events_of_interest_sync(&self, query: &EventOfInterestQuery) -> Result<Vec<EventOfInterest>>` | Dynamic WHERE (time + source + category), ORDER BY created_at_ms DESC, default limit 500 | |
| `get_event_of_interest_sync(&self, id: &str) -> Result<EventOfInterest>` | SELECT WHERE id = ? | Error if not found |
| `update_event_of_interest_sync(&self, event: &UpdateEventOfInterest) -> Result<EventOfInterest>` | UPDATE SET all fields + updated_at_ms = now | Error if 0 rows affected |
| `delete_event_of_interest_sync(&self, id: &str) -> Result<()>` | DELETE WHERE id = ? | Error if 0 rows affected |

Each sync method gets an async wrapper (clone + `spawn_blocking`).

Also add `event_of_interest_count` to `get_stats_sync` and `StorageStats`.

### 1.5 Update lib.rs re-exports

**File:** `adsb-data-engine/src/lib.rs`

Add: `EventOfInterest, CreateEventOfInterest, UpdateEventOfInterest, EventOfInterestQuery`

### 1.6 Tests (~16 tests)

In `storage.rs` `#[cfg(test)] mod tests`:
- `test_insert_event_of_interest` — create, verify fields including default source="user"
- `test_insert_event_of_interest_custom_source` — create with source="detector", verify
- `test_query_events_of_interest_empty` — empty table
- `test_query_events_of_interest_time_filter` — 3 events, filter by range
- `test_query_events_of_interest_source_filter` — mixed sources, filter by source
- `test_query_events_of_interest_category_filter` — mixed categories, filter by category
- `test_query_events_of_interest_limit`
- `test_get_event_of_interest_found`
- `test_get_event_of_interest_not_found`
- `test_update_event_of_interest` — verify title/description/updated_at changed
- `test_update_event_of_interest_not_found`
- `test_delete_event_of_interest`
- `test_delete_event_of_interest_not_found`
- `test_event_with_point_location` — lat/lon round-trip
- `test_event_with_bbox` — bbox round-trip
- `test_event_with_time_range` — end_timestamp_ms round-trip
- `test_event_with_metadata_and_linked_aircraft` — metadata JSON + linked_hex_idents round-trip

---

## Phase 2: Tauri Commands

### 2.1 Add 5 commands

**File:** `src-tauri/src/commands.rs`

```rust
create_event_of_interest(event: CreateEventOfInterest, state) -> Result<EventOfInterest, String>
get_events_of_interest(query: EventOfInterestQuery, state) -> Result<Vec<EventOfInterest>, String>
get_event_of_interest(id: String, state) -> Result<EventOfInterest, String>
update_event_of_interest(event: UpdateEventOfInterest, state) -> Result<EventOfInterest, String>
delete_event_of_interest(id: String, state) -> Result<(), String>
```

All follow the standard storage read-lock pattern.

### 2.2 Register commands

**File:** `src-tauri/src/lib.rs`

Add all 5 to `generate_handler![]`. Add imports for new types from `adsb_data_engine`.

---

## Phase 3: Frontend Types & Commands

### 3.1 TypeScript types

**File:** `src/lib/types.ts`

Mirror the Rust types: `EventOfInterest`, `CreateEventOfInterest`, `UpdateEventOfInterest`, `EventOfInterestQuery`. Include `source`, `category`, `metadata`, `linked_hex_idents` fields. The `source` field on `CreateEventOfInterest` is optional (defaults to `"user"` on backend).

### 3.2 Command wrappers

**File:** `src/lib/commands.ts`

5 new functions: `createEventOfInterest`, `getEventsOfInterest`, `getEventOfInterest`, `updateEventOfInterest`, `deleteEventOfInterest`.

### 3.3 Tests

**File:** `src/lib/__tests__/commands.test.ts`

Add tests for all 5 command wrappers (verify invoke name + arguments).

---

## Phase 4: React Hook

### 4.1 `useEventsOfInterest`

**File:** `src/hooks/useEventsOfInterest.ts`

State: `events: EventOfInterest[]`, `loading: boolean`, `error: string | null`

- Fetch on mount via `getEventsOfInterest({})`
- Expose: `events`, `loading`, `error`, `createEvent()`, `updateEvent()`, `deleteEvent()`, `refresh()`
- Each mutation calls backend then re-fetches list
- Handle "Storage not available" gracefully (empty list, no error)

### 4.2 Tests

**File:** `src/hooks/__tests__/useEventsOfInterest.test.ts`

- Fetches on mount
- Create triggers refresh
- Delete triggers refresh
- Handles storage unavailable

---

## Phase 5: UI Components

### 5.1 Event Form Dialog

**File:** `src/components/EventFormDialog.tsx`

Floating modal (fixed position, z-[1200], above event panel z-[1100]) for create/edit:
- Title (text input, required)
- Description (textarea, required)
- Category (optional text input or dropdown with common values: "observation", "military", "emergency", "anomaly", "airspace")
- Time: "Point" / "Range" toggle → datetime-local input(s)
- Location: "None" / "Point" / "Area" toggle → lat/lon or bbox inputs
- Linked aircraft (optional text input for hex_idents, comma-separated — could pre-fill from selected aircraft)
- Save / Cancel buttons
- Pre-fill support: lat/lng from map context menu, current time as default, selected aircraft hex_idents
- Note: `source` is always `"user"` for manual creation (not shown in form); `metadata` is not exposed in the UI form (reserved for backend producers)

### 5.2 Events of Interest Panel

**File:** `src/components/EventsOfInterestPanel.tsx`

Floating window (same pattern as DBHistoryPanel floating mode):
- Fixed position, z-[1100], draggable title bar
- Header: "Events" + "New Event" button + close button
- Scrollable list of events showing: title, source badge, category badge, formatted time, location indicator
- Source badge: colored pill (e.g., amber for "user", cyan for "detector", green for "news_feed")
- Click event → edit via EventFormDialog (only user-created events are editable; backend events are read-only)
- Delete button with confirmation (`ask()`)
- Optional filter by source/category (simple dropdown or toggle — keeps panel usable when mixed sources exist)

### 5.3 Map Context Menu

**File:** `src/components/MapContextMenu.tsx`

Positioned div on right-click:
- "Create Event Here" option
- Styled consistent with app theme (dark slate)
- Dismissed on click elsewhere or map move

### 5.4 Map Integration

**File:** `src/components/MapInner.tsx`

- New prop: `eventsOfInterest: EventOfInterest[]`
- Point events → distinct markers (star/pin icon, amber/gold color)
- Area events → `<Rectangle>` with semi-transparent fill
- Tooltips showing event title + time
- `contextmenu` event handler → passes lat/lng up to parent

### 5.5 Dashboard Integration

**File:** `src/app/page.tsx`

- Add "Events" toggle button in header left group (next to "DB History")
- State: `eventsOpen`, `eventFormOpen`, `eventFormInitialData`
- Use `useEventsOfInterest` hook
- Render `EventsOfInterestPanel` when open
- Render `EventFormDialog` when creating/editing
- Pass events + context menu handler to Map
- Handle map context menu → open form with pre-filled lat/lng

### 5.6 Component Tests

- `EventFormDialog.test.tsx` — form rendering, validation, submit
- `EventsOfInterestPanel.test.tsx` — list rendering, empty state, delete
- `MapContextMenu.test.tsx` — render, callback

---

## Future Extension Points (not implemented now, but enabled by this design)

The `StorageHandle` methods are callable from any Rust code with access to the handle:

1. **Bridge-level detectors** — A future detection module in `bridge.rs` could call `storage.insert_event_of_interest()` with `source: "detector"` when it detects anomalies (e.g., emergency squawk 7700, military ICAO ranges, unusual altitude changes). The `metadata` field carries detector-specific output.

2. **External feed ingestion** — A new Tauri command or background task could poll an external API (NOTAMs, aviation news) and insert events with `source: "notam_feed"` or `source: "news"`. The `metadata` field stores the raw feed data.

3. **Batch import** — The existing import/export pattern (`preview_import` / `import_database`) will naturally include `events_of_interest` since it copies all tables.

4. **UI filtering** — The `EventOfInterestQuery.source` and `.category` filters allow the panel to show subsets (e.g., "only my annotations" vs "all detected events"). The panel's source badge makes mixed lists scannable.

5. **Aircraft linking** — When a user right-clicks an aircraft marker (future), they could "Create event for this aircraft" with `linked_hex_idents` pre-filled. Detectors would also populate this field automatically.

---

## Critical Files

| File | Action |
|------|--------|
| `adsb-data-engine/Cargo.toml` | Add uuid dependency |
| `adsb-data-engine/src/types.rs` | Add 4 new types |
| `adsb-data-engine/src/storage.rs` | Add table SQL + 5 sync methods + 5 async wrappers + stats update |
| `adsb-data-engine/src/lib.rs` | Add re-exports |
| `src-tauri/src/commands.rs` | Add 5 Tauri commands |
| `src-tauri/src/lib.rs` | Register commands + imports |
| `src/lib/types.ts` | Add TS types |
| `src/lib/commands.ts` | Add 5 command wrappers |
| `src/hooks/useEventsOfInterest.ts` | New hook |
| `src/components/EventFormDialog.tsx` | New component |
| `src/components/EventsOfInterestPanel.tsx` | New component |
| `src/components/MapContextMenu.tsx` | New component |
| `src/components/MapInner.tsx` | Add event markers + context menu |
| `src/app/page.tsx` | Add button + state + panel wiring |

## Verification

1. **Rust tests:** `cargo test -p adsb-data-engine` — all new tests pass
2. **Clippy/fmt:** `cargo clippy --workspace -- -D warnings && cargo fmt --workspace --check`
3. **TS tests:** `npm test` — all new tests pass
4. **Lint:** `npx next lint`
5. **Manual test:** `npm run tauri dev`
   - Click "Events" button in header → panel opens
   - Click "New Event" → form opens, fill in title/description/time, save → appears in list
   - Right-click on map → "Create Event Here" → form opens with lat/lng pre-filled
   - Edit an event → changes persist
   - Delete an event → removed from list and map
   - Event markers visible on map for events with locations
   - Close and reopen app → events persist in DuckDB
