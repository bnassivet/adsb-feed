# CLAUDE.md - ADS-B Desktop App (Tauri + Next.js)

This file provides guidance to Claude Code when working with the Tauri desktop application.

## Project Overview

Desktop aircraft tracker built with Tauri v2 (Rust backend) + Next.js 16 + React 19. Connects to dump1090 via the `adsb-pulsar-client` library and displays real-time aircraft positions on an interactive Leaflet map.

## Architecture

### Stack

- **Backend**: Tauri v2 Rust (`src-tauri/src/`)
- **Shared library**: `adsb-data-engine` (workspace crate) — SBS-1 parser + DuckDB persistent storage
- **Frontend**: Next.js 16 App Router + React 19 (`src/`)
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
- **Sharing the DB over Quack**: `StorageHandle::start_sharing()` calls `quack_serve()` on the
  instance the engine already owns, so other DuckDB clients (`webapp`, spark, a `duckdb` CLI)
  can `ATTACH` while the app keeps recording — the alternative to releasing the file lock.
  Opt-in via the metrics-bar toggle (token generated on the spot, shown and copied as a
  ready-to-paste `ATTACH`), or via environment variables read in `init_storage`:
  `ADSB_SHARE_AUTO_START`, `ADSB_SHARE_URI`, `ADSB_SHARE_TOKEN`,
  `ADSB_SHARE_ALLOW_OTHER_HOSTNAME`. Setting only `ADSB_SHARE_TOKEN` pre-seeds the token so
  it can be known in advance while still requiring a deliberate click. `share_status` on the
  engine is the single authority for live state. Three things to know:
  1. The `quack` extension is **not statically linked** — it is autoinstalled from
     `extensions.duckdb.org` on first use, so enabling it offline yields
     `ShareStatus::Unavailable { reason }` and storage keeps working (never fatal).
  2. **A token grants full read AND write on every table.** Quack's authorization hook is a SQL
     macro and macros cannot execute DML, so table-level rules are impossible without shipping a
     custom DuckDB extension. Bind stays localhost unless `allow_other_hostname`; no TLS.
  3. `ShareStatus` is serde-tagged with **`state`**, not `type` — the TS union must match or
     every status silently renders as "off".
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

**adsb-data-engine** crate (~180 tests, in `adsb-data-engine/src/`):

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
| `src/lib/__tests__/` | ~476 | `altitudeToColor`, `zoomToH3Resolution`, `computeH3Density`, `formatBytes`/`timeAgo`, `track-ordering`, `aircraft-icon`, `verticalTendency`/`formatVerticalRate`/`altitudeHistory`/`altitudeSparklinePoints`/`altitudeRange`/`formatTrackTime`, **DuckDB command wrappers** (`commands.test.ts` — incl. import), **scenario playback/convert/commands** (`scenario-*.test.ts`, incl. `scenario-describe-api`) |
| `src/contexts/__tests__/` | ~23 | `appendPosition`, `mergePositionInto` message_count accumulation |
| `src/hooks/__tests__/` | ~278 | `useLocalStorage`, `useAircraftTracks` filter logic, `useSimulatedTracks` heading/interpolation, **`useAgentSimulatedTracks`** time-based sampling + hold-then-despawn, **`useScenarios`** CRUD + hex-collision guard, **`useScenarioPlayback`** master clock (under StrictMode), **scenario chat tools** |
| `src/components/__tests__/` | ~426 | `ConnectionStatus` states, `MetricsBar` formatting + import button, `Filters` interactions, `AircraftTable` selection/RxTS/Msg#, `AltitudeLegend`, `AircraftDetailsPanel` fold/unfold/identity/tendency/sparkline/axes, **`SimulationPanel`** form/error/clear + scenario add/remove/offset, **`ScenarioBar`** picker/transport/delete-confirm |

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
npm test && npm run lint
```

> **Build note**: `next build` is pinned to `--webpack` in `package.json`. Next.js 16's default
> Turbopack bundler currently fails the static export while prerendering the internal
> `/_global-error` route (upstream bug vercel/next.js#87719); `dev` still uses Turbopack.
> ESLint runs via flat config (`eslint.config.mjs`); the legacy `.eslintrc.json` was removed and
> `next lint` no longer exists in Next 16.
>
> **React Compiler**: enabled via `reactCompiler: true` in `next.config.ts` (needs the
> `babel-plugin-react-compiler` devDep). It auto-memoizes components; builds are slower (Babel).
> `react-hooks/refs` and `react-hooks/immutability` are enforced at **error** (all violations
> fixed). `react-hooks/set-state-in-effect`, `purity`, and `incompatible-library` stay at **warn**
> — their remaining occurrences are legitimate (data-fetch/async/UUID/animation effects, intentional
> render reads, CopilotKit integration). The compiler bails out per-component on those, so they
> don't affect correctness. Vitest runs against source (not compiled output), so verify compiler
> behavior at runtime via `npm run tauri dev`.

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

### Simulated tracks — two independent sources

| Source | Data | Playback | Lifetime |
|--------|------|----------|----------|
| `useSimulatedTracks` | `SIMULATED_FLIGHTS` (20 hardcoded routes in `simulation-data.ts`) | Fixed progress-per-tick; `ground_speed` is a display field only | Loops forever |
| `useAgentSimulatedTracks` | `AgentTrajectory[]` from the simulation agent | Sampled from each trajectory's own playback clock against its waypoints' `t_offset_s`, so speed is real | User-driven: start / pause / resume / stop, per aircraft |

The second source now has **two feeds of its own**, both ending up in the single
`agentTrajectories` array that `page.tsx` derives:

| Feed | Where it comes from | Persisted? |
|------|---------------------|------------|
| **Scenario tracks** | The active scenario's rows in DuckDB, via `useScenarios().tracksAsTrajectories` | Yes — survive restart, replay with no Python agent running |
| **Staged trajectories** | The last generation (panel form *or* chat), held in `stagedTrajectories` | No — until "+ Add to scenario" commits them |

**Generation stages, it does not replace.** `onTrajectories` is wired to
`setStagedTrajectories`, so Generate and Clear only affect the unsaved set and
aircraft already saved into the scenario survive both. Before scenarios existed
this was a plain `setAgentTrajectories`, and each generation destroyed the last.

### Simulation scenarios

A *scenario* is a named, persisted collection of tracks, each with a
`start_offset_s`. Design doc:
`docs/plans/2026-08-18-simulation-scenario-builder-design.md`.

| Piece | Role |
|-------|------|
| `scenarios` / `scenario_tracks` tables | `SCHEMA_SQL` in `adsb-data-engine/src/storage.rs`; `waypoints_json` is stored **verbatim and never parsed** by the engine, `request_json` keeps the generating `SimulateRequest` so a track can be regenerated |
| `lib/scenario-playback.ts` | Pure master clock: `ScenarioClock`, `projectScenario`, `mergeScenarioPlayback`, `tick/seek/start/pause/stop` |
| `lib/scenario-convert.ts` | `trackToTrajectory`, `trajectoryToCreateTrack`, `uniqueHexIdent`, `trackDigest` |
| `lib/scenario-describe-api.ts` | `POST /scenario/describe` on adsb-agent — the AI description button |
| `hooks/useScenarios.ts` | Scenario list, active scenario + tracks, all CRUD |
| `hooks/useScenarioPlayback.ts` | Owns the master clock and its timer |
| `components/ScenarioBar.tsx` | Picker, new/rename/delete, master transport + scrubber |
| `components/ScenarioDescription.tsx` | Description editor + "Generate from trajectories" |

**The master clock is a projection, not a second playback engine.** Because
`useAgentSimulatedTracks` is a stateless renderer over a `PlaybackMap`,
`projectScenario` maps scenario time onto that same map — `T < offset` →
stopped, within the span → the master state at `T - offset`, past the end →
paused at the final waypoint. Sampling, trails, route polylines and `isVisible`
needed no changes at all. `mergeScenarioPlayback` returns the per-track map
untouched while the scenario clock is stopped, so per-track Start/Pause/Stop
still works for authoring one aircraft at a time.

**`useScenarioPlayback` is deliberately separate from `useTrajectoryPlayback`.**
The latter owns the StrictMode-sensitive `requestAutoStart` path documented
below; folding a master clock into it risked reintroducing that bug for no gain.

**`hex_ident` must be unique *across both feeds*, not just within the scenario.**
This bit twice, in two different ways:

1. Within a scenario, `PlaybackMap` is keyed by hex, so two tracks sharing one
   share a clock and an aircraft silently becomes unreachable.
   `useScenarios.addTrajectory` calls `uniqueHexIdent` to prevent it.
2. Across the saved/staged split, React keys map markers by hex and threw
   *"Encountered two children with the same key"* from `MapInner`. Committing a
   trajectory refetches the scenario **before** the staged set is filtered, so
   for one render the same aircraft is in both feeds. A fresh generation can
   also return a hex the scenario already holds.

Two guards, both needed and both pure:

| Function | Role |
|----------|------|
| `stageTrajectories(incoming, existingHexes)` | Reassigns colliding hexes **as trajectories are staged**, so a generated aircraft is never hidden behind a saved one |
| `dedupeTrajectoriesByHex(list)` | Safety net where the feeds are concatenated in `page.tsx`; scenario tracks are first, so the saved aircraft wins |

Dedupe alone is not enough — it would drop the newcomer and the user would
press Generate and see nothing appear. Staging alone is not enough either,
because it cannot close the async window during a commit.

#### Scenario descriptions

A scenario carries a prose `description`, written by hand or drafted by the LLM
from the tracks it contains.

**`update_scenario_sync` must stay a partial update.** It used to overwrite
every column, with `description.unwrap_or_default()` turning an omitted
description into `""`. The rename path sends only `{ id, name }` — so renaming a
scenario silently destroyed its description, origin and tags. It now uses
`COALESCE(?, column)` like `update_scenario_track_sync`: `None` preserves,
`Some("")` is a deliberate clear. Pinned from both sides
(`test_update_scenario_rename_preserves_description_and_origin` in Rust, *"does
not send a description when renaming"* in `useScenarios.test.ts`). Any new
setter on a scenario must send **only** the fields it means to change.

**The AI button uses a REST endpoint, not the chat.** It lives in the left panel,
outside `AIChatContent`'s tree, and must work with the chat closed — the same
reason `/simulate/trajectory` exists. `POST /scenario/describe` makes a
single-shot LLM call in `adsb-agent/describe.py` with **no graph and no tools**,
so the model cannot wander off calling DuckDB tools instead of writing two
sentences. Chat gets `setScenarioDescription` as a tool instead.

**Reasoning is off by default (`ADSB_AGENT_REASONING_EFFORT`).** Reasoning tokens
are charged against the *same* `max_tokens` budget as the answer, so a model that
deliberates hits `finish_reason='length'` with **empty content** — which the user
experiences as the button hanging, not as an error. `reasoning.py` maps every
plain word for "off" onto `reasoning_effort="none"`, the one value a toggle-style
model like `gemma-4-12b-qat` actually honours (4 s / 162 tokens with it, 23 s /
1083 without). Set it to `on` to restore the model's default, or a graded level
for providers with a real dial. Ported from `adsb_simulation_agent.server`, which
hit this first; `graph.py` does not use it yet and could.

**`max_retries=0` on the describe model.** The OpenAI client retries twice by
default, so one call is three attempts and `describe_timeout` is silently tripled
— a 60 s budget becomes 180 s, long after the user gave up. A description is not
worth a transport-level retry.

**Only digests are sent, never waypoints.** `trackDigest` summarises each track
(phases, altitude/speed envelope, extent, offset) into the shape of the Python
`TrackDigest` model. Keeps the prompt small and points the model at what a
description needs.

**The route hint beats derived kinematics.** `request_json` stores the
`SimulateRequest` an aircraft was generated from, and `trackDigest` lifts its
`routeHint` into `route`. When present, `_describe_track` emits *only* identity,
timing and the route — "orbit the port then land downtown" says what the aircraft
is doing, where "altitude 0–2500 ft, speed 0–110 kts" only says it is a
helicopter. Identity and timing always survive: neither is derivable from a hint.

`request_json` was dead until this landed — nothing populated it.
`SimulationPanel` now keeps its last successful request and hands it to
"+ Add to scenario". It is scoped **by callsign, not `hex_ident`**, because
`page.tsx` runs incoming aircraft through `stageTrajectories`, which reassigns a
colliding hex — the ids coming back as props need not be the ones sent up.
Scoping it at all is the point: chat-generated aircraft share the list, and
attaching the panel's route hint to one would describe it as something it is not.

**Generated text is a draft, never auto-saved.** It lands in the textarea; the
user edits and saves deliberately. One save path serves both authoring modes.

**Cancel is not an error.** `describeScenario` rethrows `AbortError` untouched,
duck-typed on `.name` — a `DOMException` is *not* `instanceof Error` under jsdom
(nor in every browser), so an instanceof guard silently misses it and every
deliberate cancel surfaces as "agent unreachable". `simulate-api.ts` still has
this latent bug; it is invisible only because that path never aborts.

**`agentTrajectories` is a derived list, and chat tools must not treat it as
"things not yet saved".** `addTrajectoryToScenario` searched it for a match, but
it is *scenario tracks + staged* — so aircraft already in the scenario matched
just as readily, `addTrajectory` called `uniqueHexIdent`, the colliding hex was
renamed to `AAA111-2`, and a **second row** was inserted. Asking chat to add one
aircraft recreated the ones already saved.

The tool now refuses anything `scenarios.tracks` already holds, matching on
callsign as well as hex — callsign is the load-bearing half, because a duplicate
created before the fix carries a renamed hex but the original callsign. It
returns `{ added: false, alreadyInScenario: true }`, not an error.

Consequence, accepted deliberately: a freshly generated aircraft that reuses a
saved callsign is refused from chat. That is correct — `removeTrackFromScenario`
and `setTrackStartOffset` both address tracks *by callsign*, so two tracks
sharing one would make them ambiguous. The panel's "+ Add" button still allows it.

Every test missed this because the harness only put the staged trajectory in
`agentTrajectories`, which never happens in the running app. **When a fixture
stands in for derived state, build it from both sources.**

**Scenario writes never reach the agent tool server.** `tool_server.rs` exposes
only `listScenarios` / `getScenario`; every mutation goes through a CopilotKit
frontend tool (as `createEventOfInterest` does) so it passes through a UI layer
that can confirm it. `scenario_writes_are_not_reachable_from_the_tool_server`
pins that boundary.

### Agent trajectory playback

Three pieces, deliberately separated so the logic is testable without React:

| Piece | Role |
|-------|------|
| `lib/trajectory-playback.ts` | Pure state machine: `stopped \| playing \| paused` + `elapsedS` per trajectory, plus `tickPlayback`/`startPlayback`/`seekPlayback`/… |
| `hooks/useTrajectoryPlayback.ts` | Owns the `PlaybackMap` and drives the clocks (`PLAYBACK_TICK_MS = 500`) |
| `hooks/useAgentSimulatedTracks.ts` | **Stateless** renderer — given trajectories + playback it returns tracks |

Each aircraft has **its own clock**, so they start and stop independently. Generated trajectories arrive **stopped**; nothing moves until the user presses Start. Reaching the end **pauses at the final waypoint** rather than despawning, so the scrubber can be dragged back.

`trailUpTo()` derives the trail from the route rather than accumulating it over time — that is what makes scrubbing backwards shorten the trail instead of leaving the earlier path drawn.

**The panel is laid out in three zones.** The "Demo flights" shortcut and the scenario bar stay visible; **generation** sits in a `<details>` that folds away; the **trajectory list** comes last, bounded by `max-h-[40vh] overflow-y-auto` so the transport row below it never scrolls out of reach.

The fold's open state is `useLocalStorage<boolean | null>("adsb-sim-generate-open", null)`. The `null` third value is load-bearing: while the user has expressed no preference the fold is *derived* — open while `trajectories` is empty, closed once it fills — and a deliberate toggle is remembered and wins from then on. Deriving it during render (`genOpenPref ?? trajectories.length === 0`) keeps it out of an effect that would fight the user under StrictMode. Two-valued state cannot tell "closed by default" from "the user closed it".

The `SimulationPanel` lists each trajectory (waypoints, duration, altitude range, leg count when >1, phases), supports multi-select, and exposes Start/Pause/Resume/Stop plus a per-trajectory `<input type="range">` timeline. `MapInner` draws the **planned route** of every visible trajectory as a dashed polyline (`simulatedRoutes` prop) so the generated geometry is visible in full.

**Multi-leg routes are drawn per leg.** A generated route can now be a sequence of legs — "come from here, work this area, then head over there" — and each waypoint carries an optional `leg_index`. `routeLegs()` splits the route at those boundaries and `MapInner` draws one polyline per leg, cycling `SIM_LEG_COLORS`; a single-leg route keeps the original blue, so nothing changes for simple results. Each leg repeats the previous leg's last point as its own first, otherwise there is a visible gap at every boundary. Playback needs no changes at all: `t_offset_s` stays monotonic across legs, so `sampleTrajectory`/`trailUpTo` are unaffected.

**Show/hide is a third axis, independent of transport.** `isVisible(entry)` is
just `state !== "stopped"`, so before this existed the only way to take an
aircraft off the map was to Stop it — which rewinds `elapsedS` to 0. Hiding
leaves the clock alone: un-hiding reveals the aircraft where it should be by now.

**Marker and route take different rules, because they answer different
questions.** The *marker* is "where is it now" and genuinely needs a clock —
`isVisible`, applied per entry in `useAgentSimulatedTracks`. The *route overlay*
is "where will it go": static geometry, worth seeing before anything has been
played. So `visibleRouteTrajectories(trajectories, hidden?)` consults **only the
eye**, never playback. A shown trajectory draws its planned route with the
scenario stopped; that is the point of being able to inspect a scenario you have
not run yet. Tying the route to playback (as the first cut did) made a freshly
generated scenario invisible until Start was pressed.

**The eyes reuse `hiddenSections`, they do not add a second hidden set.**
Simulated aircraft are ordinary members of `allTracks`, so their *markers* were
already filtered by `filterBySection("live", …)` — the panel's eye and the
aircraft table's eye are the same switch for the same aircraft. Their **route
overlays** were not filtered at all, so a hidden simulated aircraft kept drawing
its dashed route; `visibleRoutes` now applies the hidden set (and nothing else). Session state
only — nothing is persisted, everything is visible again on restart.

**A subset toggle must not replace the section's set.** `handleToggleGroupVisibility`
does `set(section, new Set(hexIdents))`, which is right for the table (its hexes
*are* the whole section) and wrong for the panel, whose trajectories are a subset
— it would silently reveal every other hidden live aircraft.
`toggleScopedVisibility` (`lib/track-visibility.ts`) unions/subtracts only the
hexes it is given and is pinned by its own tests; `handleToggleTrajectoriesVisibility`
is its only caller. The shared `EyeIcon` lives in `components/EyeIcon.tsx`.

**The two sources are independent.** `showSimulation` gates **only** the 20 hardcoded demo flights. Its checkbox now lives at the top of `SimulationPanel` (it moved out of `Filters` — it is the cheapest way to put aircraft on the map, so it belongs beside the other simulation controls), but *proximity is not coupling*: it must stay wired to `useSimulatedTracks` alone. Agent trajectories render purely from their own playback state — Stop or Clear removes them. Coupling the two meant pressing Start in the Simulation Agent panel also launched all 20 demo flights; don't reintroduce it (there are regression tests in `useCopilotTools.test.ts` and `useTrajectoryPlayback.test.ts`).

**The tool descriptions also have to keep them apart.** Both tools once described
themselves in terms of "simulated flights", so "start simulated flights" made the
model call `toggleDemoFlights` — 20 canned routes started and nothing was
generated. `generateSimulatedTrajectory` now claims the start/run/create verbs and
`toggleDemoFlights` reads as a fixed built-in layer that "creates no aircraft",
in **both** `useCopilotTools.ts` and the Python `tools.py` (plus a guideline in
`prompt_sections.yaml`). Descriptions are the interface the model programs
against; there are prose assertions in `useCopilotTools.test.ts` and
`test_simulation_tool_disambiguation.py` because this regressed silently once.

**Trajectories arrive selected.** Every transport button acts on the panel's
`selected` set alone, so an unselected trajectory is inert. The form used to
select its own results while chat results — which arrive as props — were selected
by nobody, leaving Start/Pause/Stop dead for them. One render-phase rule in
`SimulationPanel` now adopts *new* ids (new, so a deliberate deselection sticks),
covering both paths.

**Never read-and-clear a ref inside a `setState` updater.** React double-invokes
updaters under StrictMode — which Next.js enables by default — and keeps the
**second** result. `useTrajectoryPlayback`'s auto-start did exactly this: the
first pass consumed the request and returned "playing", the second saw an empty
request and returned "stopped", so chat-generated aircraft arrived frozen in the
real app while every non-Strict test passed. Consume the ref in the effect body,
before calling `setPlayback`. Tests that assert hand-off behaviour should render
under `StrictMode` (`chatTrajectoryFlow.test.ts` reproduces the page wiring and
was what finally caught it — the hook-only StrictMode test did not).

Chat-generated trajectories auto-start via `requestAutoStart` — asking the agent to "simulate a helicopter" should show it flying. Panel-generated ones stay stopped until the user presses Start. `requestAutoStart` exists because playback entries only appear after the sync effect, so calling `start()` immediately after handing over trajectories would find nothing. Agent coordinates are **absolute** — the agent already generated around the receiver, so no `SIMULATION_ORIGIN` offset is applied (applying it would double-shift the route).

**Agent trajectories reach the app two ways**, both ending at `setAgentTrajectories`:
- **Chat**: the Python agent proxies `generateSimulatedTrajectory` over A2A, then synthesizes an `applySimulatedTrajectory` client-tool call carrying the payload. Both tools are registered in `useCopilotTools.ts` — `generateSimulatedTrajectory` executes *server*-side but must still be declared here, since `partition_tool_names` intersects against the frontend-supplied tool list (same as `getStorageStats`).
- **Panel**: `SimulationPanel.tsx` → `simulate-api.ts` → `POST /simulate/trajectory` on adsb-agent, bypassing chat.

Requires `adsb-agent` (:8000) and `adsb-simulation-agent` (:8300) running; without them the panel shows a readable error and the rest of the app is unaffected.

## Gotchas

- Editing docs under `adsb-data-engine/` used to restart the dev app: it is a path
  dependency, so `tauri dev` watches its whole directory. `adsb-data-engine/.taurignore`
  excludes `docs/`, notebooks and markdown. **That file is read once, at `tauri dev`
  startup** — changing it does nothing until you restart the dev session.

- Root `.gitignore` has `lib/` which silently ignores `src/lib/`. Negated with `!**/src/lib/`
- Tauri v2 commands silently fail without proper permissions in `capabilities/default.json`
- `create-next-app` fails if `src-tauri/` exists — scaffold manually or use temp dir
- Workspace dep names use hyphens (`adsb-pulsar-client`), Rust `use` statements use underscores (`adsb_pulsar_client`)
- DuckDB historical query commands return `"Storage not available"` if init failed — callers must handle this gracefully
- `sbs_parser.rs` is in `adsb-data-engine` crate, NOT in `src-tauri/src/` (was moved as part of shared library refactor)
- A hook whose effect depends on an **array prop** must key that effect on a value-derived signature, not array identity. `useAgentSimulatedTracks` calls `setTracks` inside its effect, so an inline-array caller would otherwise loop forever (caught by its own tests)
