# Simulation Scenario Builder — Implementation Plan

## Context

The Simulation Agent generates trajectories that are **session-only and disposable**. `page.tsx`
states it directly: *"Session-only — nothing is persisted."* Every generated aircraft lives in one
`agentTrajectories` state array, and `SimulationPanel`'s `onTrajectories(result.aircraft)`
**replaces** that array on each generation — so the second generation destroys the first.

There is consequently no way to build a multi-aircraft situation, no way to express that one
aircraft appears later than another, and no way to recover a situation after a restart.

This feature turns generation into **authoring**. A *scenario* is a named, persisted collection of
tracks, each with a start offset, stored in DuckDB. The Simulation Agent becomes the instrument for
iterating on one track at a time; the scenario is the artifact that is kept, replayed, and grown.

### Design decisions

| Question | Decision | Rationale |
|---|---|---|
| What a track persists | Baked waypoints **and** generation intent | Replay stays deterministic and agent-free; `request_json` enables Regenerate and shows provenance |
| UI placement | Grow the existing left-panel "Simulation Agent" section | `SimulationPanel` already owns generation and transport; smallest disruption |
| Playback | Scenario master clock **and** per-track controls | A scenario is defined by relative timing; per-track control stays useful while authoring |
| Chat surface | Read, write, compose, and timing tools | Authoring a scenario conversationally is the main workflow win |

### Extensibility

`request_json` stores the full `SimulateRequest` — including the simulation agent's `RoutePlan`
intent, which already supports multi-leg routes. That makes future "re-roll with a new seed",
"widen the orbit", and plan-diffing features possible without a schema change. `tags` and the
nullable `origin_lat`/`origin_lng` on `scenarios` leave room for scenario libraries and
receiver-relative scenarios later.

---

## Architecture

### The load-bearing insight

`useAgentSimulatedTracks` is a **stateless renderer**: given `(trajectories, playback)` it returns
`AircraftTrack[]`. A scenario master clock therefore does **not** require touching the rendering
hook, the map, or the trail logic. It is a pure function projecting a master time onto the existing
`PlaybackMap`:

```
projectScenario(clock, tracks) -> PlaybackMap
  T <  offset             -> stopped               (not spawned yet)
  offset <= T <= offset+d  -> {clock.state, T-offset}
  T >  offset + d          -> paused at d           (holds at final waypoint)
```

Master mode simply supplies the `PlaybackMap` in place of `useTrajectoryPlayback`'s own. Everything
downstream — `sampleTrajectory`, `trailUpTo`, `isVisible`, the route polylines — is unchanged.

### State shape in `page.tsx`

Generated results must be **stageable** before being committed, so `agentTrajectories` becomes
derived rather than directly owned:

```ts
const scenario = useScenarios();                              // CRUD + active scenario tracks
const [staged, setStaged] = useState<AgentTrajectory[]>([]);  // last generation, unsaved

const agentTrajectories = useMemo(
  () => [...scenario.tracksAsTrajectories, ...staged],
  [scenario.tracksAsTrajectories, staged],
);
```

Chat- and panel-generated results land in `staged`, preserving today's behaviour exactly — including
the chat auto-start path. "+ Add to scenario" moves a staged trajectory into the persisted scenario.

---

## Phase 1: Rust backend — `adsb-data-engine`

No dependency changes: `uuid` (v4) and `serde_json` are already present from the events-of-interest
feature.

### 1.1 Add DuckDB tables

**File:** `adsb-data-engine/src/storage.rs` — append to the `SCHEMA_SQL` const.

Two **new tables**. This codebase has no migration runner — only idempotent
`CREATE TABLE IF NOT EXISTS` executed on every `open()`. That silently fails to add *columns* to
existing tables, but is entirely safe for *new tables*. **This feature must not add columns to any
existing table.**

```sql
CREATE TABLE IF NOT EXISTS scenarios (
    id            TEXT   PRIMARY KEY,
    name          TEXT   NOT NULL,
    description   TEXT   NOT NULL DEFAULT '',
    origin_lat    DOUBLE,
    origin_lng    DOUBLE,
    tags          TEXT,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenarios_updated ON scenarios (updated_at_ms);

CREATE TABLE IF NOT EXISTS scenario_tracks (
    id             TEXT    PRIMARY KEY,
    scenario_id    TEXT    NOT NULL,
    ordinal        INTEGER NOT NULL DEFAULT 0,
    hex_ident      TEXT    NOT NULL,
    callsign       TEXT    NOT NULL,
    category       TEXT    NOT NULL,
    start_offset_s DOUBLE  NOT NULL DEFAULT 0,
    waypoints_json TEXT    NOT NULL,
    request_json   TEXT,
    created_at_ms  BIGINT  NOT NULL,
    updated_at_ms  BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenario_tracks_scenario ON scenario_tracks (scenario_id, ordinal);
```

`waypoints_json` holds the `DynamicWaypoint[]` array verbatim as produced by the simulation agent —
the engine treats it as an opaque blob and never parses it, so waypoint-schema changes (a future
`leg_index`-like field) need no storage change. `request_json` is nullable: a hand-authored or
imported track has no generating request.

DuckDB's foreign-key/cascade support is limited, so `delete_scenario_sync` deletes from
`scenario_tracks` then `scenarios` inside one transaction rather than relying on `ON DELETE CASCADE`.

### 1.2 Add types

**File:** `adsb-data-engine/src/types.rs` — mirroring the `EventOfInterest` / `CreateEventOfInterest`
pairing for serde and field conventions.

```rust
pub struct Scenario { id, name, description, origin_lat, origin_lng, tags,
                      created_at_ms, updated_at_ms, track_count }
pub struct ScenarioTrack { id, scenario_id, ordinal, hex_ident, callsign, category,
                           start_offset_s, waypoints_json, request_json,
                           created_at_ms, updated_at_ms }
pub struct ScenarioWithTracks { scenario: Scenario, tracks: Vec<ScenarioTrack> }

pub struct CreateScenario { name, description, origin_lat, origin_lng, tags }
pub struct UpdateScenario { id, name, description, origin_lat, origin_lng, tags }
pub struct CreateScenarioTrack { scenario_id, hex_ident, callsign, category,
                                 start_offset_s, waypoints_json, request_json }
pub struct UpdateScenarioTrack { id, callsign, start_offset_s, ordinal }
```

`Scenario.track_count` is computed by the list query (a `LEFT JOIN … COUNT`), so the picker can show
"Approach Rush (3)" without loading every track's waypoints.

### 1.3 Add StorageHandle CRUD methods

**File:** `adsb-data-engine/src/storage.rs`

Each is a `*_sync` method (locks the `Mutex`, does DuckDB work) plus a thin `spawn_blocking` async
wrapper of the same name, exactly matching `insert_event_of_interest_sync` / `insert_event_of_interest`:

| Method | Returns |
|---|---|
| `list_scenarios` | `Vec<Scenario>` — newest `updated_at_ms` first, with `track_count` |
| `get_scenario(id)` | `ScenarioWithTracks` — tracks ordered by `ordinal` |
| `insert_scenario(CreateScenario)` | `Scenario` (uuid v4 id, timestamps filled) |
| `update_scenario(UpdateScenario)` | `Scenario` |
| `delete_scenario(id)` | `()` — transactional, deletes tracks first |
| `insert_scenario_track(CreateScenarioTrack)` | `ScenarioTrack` — `ordinal` = current max + 1 |
| `update_scenario_track(UpdateScenarioTrack)` | `ScenarioTrack` |
| `delete_scenario_track(id)` | `()` |
| `reorder_scenario_tracks(scenario_id, ids)` | `()` — assigns ordinals by position |

Any track mutation also bumps the parent scenario's `updated_at_ms`, so the picker's ordering
reflects real activity.

### 1.4 Update lib.rs re-exports

**File:** `adsb-data-engine/src/lib.rs` — re-export the new types alongside the event ones.

### 1.5 Tests

Inline `#[cfg(test)] mod tests` in `storage.rs`, against in-memory DuckDB via the existing
`test_config()` helper. Coverage:

- create / list / get / update / delete round-trips for both tables
- `delete_scenario` removes its tracks (the cascade substitute)
- `ordinal` auto-increments; `reorder_scenario_tracks` renumbers
- `track_count` is correct, including a scenario with zero tracks
- `request_json = NULL` round-trips as `None`
- track mutation bumps the scenario's `updated_at_ms`
- one `#[tokio::test]` exercising the async wrappers

---

## Phase 2: Tauri commands

### 2.1 Shared read path

**File:** `src-tauri/src/tool_service.rs` — `list_scenarios` / `get_scenario` as free functions over
`&SharedStorage`, returning the canonical `STORAGE_UNAVAILABLE` when the handle is `None`. This is
what lets the same logic serve both IPC and the localhost agent tool server, as
`get_events_of_interest` already does.

### 2.2 Commands

**File:** `src-tauri/src/commands.rs` — one `#[tauri::command]` per storage method. Reads delegate to
`tool_service`; writes take the read-lock directly and `ok_or_else(|| "Storage not available")?`,
following `create_event_of_interest`.

### 2.3 Registration

**File:** `src-tauri/src/lib.rs` — add each command to the `generate_handler![]` list.

**No `capabilities/default.json` change is required** — custom commands are authorised by
registration alone; the capability file governs only Tauri plugin permissions.

### 2.4 Agent tool server

**File:** `src-tauri/src/tool_server.rs` — add `"listScenarios"` and `"getScenario"` arms to
`dispatch`. The tool server stays **read-only**: scenario writes go through CopilotKit frontend
tools instead, following the `createEventOfInterest` precedent, so every mutation passes through the
UI layer that can render a confirmation.

### 2.5 Tests

In `tool_service.rs`: `Arc::new(RwLock::new(None))` for the unavailable path, an in-memory
`StorageHandle` for the happy path. In `tool_server.rs`: dispatch arms return a well-formed
`{ok, data}` envelope, and an unknown scenario tool name still yields `ok:false`.

---

## Phase 3: Frontend types, commands, and pure logic

### 3.1 TypeScript types

**File:** `src/lib/types.ts` — `Scenario`, `ScenarioTrack`, `ScenarioWithTracks` matching the Rust
serde output.

### 3.2 Command wrappers

**File:** `src/lib/commands.ts` — `invoke` wrappers for every new command, following the existing
event-of-interest wrappers. Tests in `src/lib/__tests__/commands.test.ts` via the `tauri.ts` invoke mock.

### 3.3 `src/lib/scenario-playback.ts` (new, pure)

```ts
export interface ScenarioClock { state: PlaybackState; elapsedS: number }
export function scenarioDurationS(tracks: ScenarioTrackTiming[]): number
export function projectScenario(clock, tracks): PlaybackMap
export function tickScenario(clock, tracks, dtS): ScenarioClock
export function seekScenario(clock, tracks, elapsedS): ScenarioClock
export function startScenario / pauseScenario / stopScenario (clock): ScenarioClock
```

Mirrors `trajectory-playback.ts` in style: pure, identity-preserving when nothing changed, and
directly unit-testable without React. The scenario ends by **pausing at its full duration**, matching
the existing per-track hold-at-end behaviour that makes backward scrubbing work.

### 3.4 `src/lib/scenario-convert.ts` (new, pure)

```ts
export function trackToTrajectory(track: ScenarioTrack): AgentTrajectory
export function trajectoryToCreateTrack(t, scenarioId, offsetS, request): CreateScenarioTrack
export function uniqueHexIdent(existing: string[], desired: string): string
export function scenarioTrackSummary(track: ScenarioTrack): TrajectorySummary
```

**`hex_ident` uniqueness is a genuine correctness trap.** `PlaybackMap` is keyed by `hex_ident`. The
generator can return the same hex for two separate generations; once both are in one scenario their
clocks collide and one aircraft becomes unreachable. `uniqueHexIdent` reassigns on collision, and
`addTrackToScenario` must call it. This has an explicit test because the failure is silent.

### 3.5 Tests

`scenario-playback`: projection boundaries (T exactly at an offset, one tick before, past the end),
zero-duration tracks, empty scenario, identity preservation.
`scenario-convert`: waypoint JSON round-trip, malformed `waypoints_json` handled without throwing,
hex collision reassignment.

---

## Phase 4: React hook

### 4.1 `src/hooks/useScenarios.ts`

Owns the scenario list, the active scenario id and its tracks, and CRUD actions; exposes a
`tracksAsTrajectories` memo for `page.tsx`. Active scenario id persists via `useLocalStorage` so the
app reopens where the user left off.

Degrades gracefully when storage is unavailable: commands reject with `"Storage not available"`, and
the hook surfaces that as a disabled scenario bar rather than an error boundary — matching how the
DB history panel behaves.

### 4.2 Tests

Via `src/test/mocks/tauri.ts`: load/select/create/delete flows, storage-unavailable path, and that
selecting a scenario replaces `tracksAsTrajectories` rather than appending.

---

## Phase 5: Master clock

**File:** `src/hooks/useTrajectoryPlayback.ts` — accept an optional scenario clock; when one is
active, yield `projectScenario(...)` instead of the hook's own map. Per-track transport continues to
drive the internal map when no scenario clock is running.

**Preserve the StrictMode fix.** `requestAutoStart` must keep consuming its ref in the *effect body*,
never inside a `setState` updater — React double-invokes updaters under StrictMode and keeps the
second result, which previously froze chat-generated aircraft while every non-Strict test passed.
Tests for this phase render under `StrictMode`, as `chatTrajectoryFlow.test.ts` does.

---

## Phase 6: UI

### 6.1 `src/components/ScenarioBar.tsx` (new)

Scenario `<select>` plus New / Rename / Delete / Duplicate, and the master transport: Play / Pause /
Stop, a master `<input type="range">` scrubber, and an `m:ss` readout via the existing `formatClock`.

### 6.2 `src/components/SimulationPanel.tsx`

- Render `ScenarioBar` above the existing generation form.
- Add a "Tracks in scenario" list: callsign, summary, a start-offset input, Remove, Regenerate
  (re-POSTs `request_json`; disabled when it is null).
- Change the results block from *replace* to **staged** results carrying "+ Add to scenario".
- Keep the existing per-track transport and the render-phase new-id adoption rule.

### 6.3 `src/app/page.tsx`

Wire `useScenarios`, derive `agentTrajectories`, and pass scenario props to `SimulationPanel` and
`useCopilotTools`.

### 6.4 Tests

Extend `SimulationPanel.test.tsx`; add `ScenarioBar.test.tsx` covering transport states, the empty
scenario case, and a delete confirmation.

---

## Phase 7: Chat tools

**File:** `src/hooks/useCopilotTools.ts`

| Group | Tools |
|---|---|
| Read | `listScenarios`, `getScenario` |
| Write | `createScenario`, `renameScenario`, `deleteScenario` |
| Compose | `addTrajectoryToScenario`, `removeTrackFromScenario` |
| Timing | `setTrackStartOffset` |

`deleteScenario` is destructive: render through `ActionConfirmCard` and word the description so the
model calls it only on an explicit user request, as `createEventOfInterest` does.

**Tool descriptions are the interface the model programs against.** This repo has already been bitten
by description collisions — `toggleDemoFlights` stole "start simulated flights", starting 20 canned
routes and generating nothing — and prose assertions in `useCopilotTools.test.ts` and
`test_simulation_tool_disambiguation.py` exist because it regressed silently. Word the scenario tools
around *scenario* / *saved* / *collection* nouns so they never compete with
`generateSimulatedTrajectory`, and add matching prose assertions.

New card: `src/components/chat/ScenarioCard.tsx`, exported from the `chat/index.ts` barrel, matching
`EventsCard`.

---

## Regressions to protect

Each of these is documented in the desktop `CLAUDE.md` and each has already cost a debugging session:

- **Demo flights stay decoupled.** `showSimulation` gates only the 20 hardcoded routes; scenario
  playback must never touch it.
- **Never read-and-clear a ref inside a `setState` updater** (StrictMode double-invocation).
- **Chat trajectories still auto-start**; panel-generated ones stay stopped.
- **Agent coordinates are absolute** — no `SIMULATION_ORIGIN` offset on scenario tracks either.
- **Arrival selection rule** adopts only *new* ids, so a deliberate deselection sticks.

---

## Critical files

| File | Change |
|---|---|
| `adsb-data-engine/src/storage.rs` | DDL + 9 `*_sync` methods + async wrappers + tests |
| `adsb-data-engine/src/types.rs` | 8 new types |
| `adsb-data-engine/src/lib.rs` | Re-exports |
| `src-tauri/src/tool_service.rs` | Shared read fns |
| `src-tauri/src/commands.rs` | 9 commands |
| `src-tauri/src/lib.rs` | `generate_handler!` registration |
| `src-tauri/src/tool_server.rs` | 2 read-only dispatch arms |
| `src/lib/scenario-playback.ts` | **new** — pure master clock |
| `src/lib/scenario-convert.ts` | **new** — conversion + hex uniqueness |
| `src/lib/types.ts`, `src/lib/commands.ts` | Types + invoke wrappers |
| `src/hooks/useScenarios.ts` | **new** |
| `src/hooks/useTrajectoryPlayback.ts` | Optional master projection |
| `src/components/ScenarioBar.tsx` | **new** |
| `src/components/SimulationPanel.tsx` | Scenario list, staged results |
| `src/components/chat/ScenarioCard.tsx` | **new** |
| `src/hooks/useCopilotTools.ts` | 8 tools |
| `src/app/page.tsx` | Wiring |

---

## Verification

```bash
# Rust — from adsb-feed/rust/
cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check

# TypeScript — from adsb-pulsar-client-desktop/
npm test && npm run lint
```

End-to-end, with both Python agents running:

```bash
cd adsb-feed/rust/adsb-simulation-agent && uv run python -m adsb_simulation_agent   # :8300
cd adsb-feed/rust/adsb-agent            && uv run python -m adsb_agent 2>&1 | tee /tmp/adsb-agent.log
cd adsb-feed/rust/adsb-pulsar-client-desktop && npm run tauri dev
```

Manual acceptance:

1. Left panel → Simulation Agent → **New scenario** "Approach Rush".
2. Generate a helicopter → **+ Add to scenario**. Generate an airliner → add it. Both persist.
3. Set the airliner's start offset to 90s.
4. Press **master Play**: the helicopter flies immediately, the airliner appears at 1:30. Scrub the
   master timeline backwards and confirm trails shorten.
5. Restart the app, reopen the scenario — both tracks and the offset survive, **with both Python
   agents stopped** (proving replay is agent-free from `waypoints_json`).
6. In chat: *"list my scenarios"*, *"generate a fighter and add it to Approach Rush"*, *"make it show
   up 30 seconds in"*.
7. Confirm *"show simulated flights"* still toggles only the 20 demo routes and creates no scenario.

Storage check (app closed, so DuckDB is not locked):

```bash
duckdb ~/Library/Application\ Support/<bundle-id>/adsb_history.db \
  -c "SELECT s.name, t.callsign, t.start_offset_s
      FROM scenarios s JOIN scenario_tracks t ON t.scenario_id = s.id
      ORDER BY s.name, t.ordinal;"
```
