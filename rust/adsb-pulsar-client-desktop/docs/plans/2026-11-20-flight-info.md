# Flight info from the web (adsbdb.com) — route, airline, aircraft, photo

## Context
The desktop app knows only what the receiver hears: hex, callsign, position. Users want to see
*where a flight is going* (origin → destination), the airline, the aircraft type/registration and
a photo, for the selected aircraft and from the AI agent. Filed ICAO flight plans are not public;
**adsbdb.com** (free, keyless) gives everything else in one call:
`GET https://api.adsbdb.com/v0/aircraft/{hex}?callsign={cs}` →
`response.aircraft` (type, icao_type, manufacturer, registration, registered_owner, owner country,
`url_photo`, `url_photo_thumbnail`) + `response.flightroute` (airline name/ICAO/IATA, origin and
destination airports: ICAO/IATA, name, municipality, country, lat/lon). Unknown → HTTP 404
`{"response":"unknown aircraft"}` (also partial: aircraft known, route unknown).

Decisions (user): adsbdb only; fetched only when the user clicks **"Show Flight Infos"** in the
Aircraft Details Panel, and never for simulated flights; show in that panel; expose as an agent tool;
persist lookups in DuckDB; also show the aircraft picture. Out of scope: route line on the map,
joining routes into history charts/flight summary (easy follow-up once the table exists).

Branch: `feature/flight-info`. TDD, one red-green-refactor per commit. No refactors folded in.

## Design
One lookup implementation, shared by the desktop command and the agent tool — it lives in
`adsb-data-server` because that crate already has `reqwest` (`Cargo.toml:47`) and **its
`server::serve` is the desktop's embedded tool server** (`src-tauri/src/lib.rs:149`), sharing the
same `SharedStorage`. Fetch in Rust → no CSP change, no key handling.

### 1. Cache tables — `adsb-data-engine/src/storage.rs`
Add to `SCHEMA_AUTHORED_SQL` (line 180; authored tables exist in embedded *and* remote mode,
unlike observed ones):
- `aircraft_info(hex_ident PK, found BOOL, icao_type, type_name, manufacturer, registration, owner, owner_country, photo_url, photo_thumb_url, fetched_at_ms BIGINT)`
- `flight_routes(callsign PK, found BOOL, airline_name, airline_icao, airline_iata, origin_icao, origin_iata, origin_name, origin_city, origin_country, origin_lat, origin_lon, dest_… (same 7), fetched_at_ms BIGINT)`

Keyed separately because a hex keeps its airframe for years while a callsign's route changes.
`found=false` rows are negative-cache entries (don't re-ask adsbdb about unknown hex every click).
New `StorageHandle` methods: `get_aircraft_info(hex)`, `upsert_aircraft_info(&row)`,
`get_flight_route(callsign)`, `upsert_flight_route(&row)` — `INSERT OR REPLACE` of a full row is
correct here since every field comes from one response (contrast the COALESCE lesson for partial
updates). Add both tables to the export at `storage.rs:3264`. Types in `adsb-data-engine/src/types.rs`.

### 2. Lookup module — new `adsb-data-server/src/flight_info.rs`
Follows the `seamarks.rs`/`metar.rs` shape: pure, testable core with an injected fetch.
- `parse_adsbdb(status, body) -> Result<Parsed, String>`: 200 → aircraft + optional route; 404 → not found; other → error.
- `async fn lookup(storage, hex, callsign, now_ms, fetch) -> FlightInfo`:
  read cache (TTL: aircraft 30 d, route 24 h, negatives 24 h) → if fresh return `origin:"cache"`;
  else fetch, upsert (write failure non-fatal, e.g. storage released), return `origin:"web"`;
  on fetch failure return the stale row with `stale:true, error:…` (never fails as a whole, like the
  existing snapshot commands). Callsign trimmed/uppercased; empty callsign → aircraft-only query.
- `fetch_adsbdb(client, hex, callsign)` — real reqwest call, `USER_AGENT` header, 8 s timeout.
- `FlightInfo` serde struct (camelCase): `aircraft?`, `route?`, `photoUrl?`, `origin`, `stale`, `error?`.

### 3. Photo
`aircraft_info.photo_thumb_url` from adsbdb (airport-data.com). Desktop command
`get_aircraft_photo(hex)` fetches the thumbnail bytes in Rust, caches them on disk under
`stack_data_dir(..)/aircraft-photos/{hex}.jpg` (static `tokio::sync::Mutex` lock, like seamarks),
returns a `data:image/jpeg;base64,…` URL → works offline, no `img-src` CSP change. Panel shows a
"Photo: airport-data.com" credit linking `photo_url`. Many airframes have no photo → section hidden.

### 4. Desktop wiring
- `src-tauri/src/commands.rs`: `get_flight_info(hex, callsign)` → `flight_info::lookup` with the
  existing `http_client(timeout)` helper (`commands.rs:1550`); `get_aircraft_photo(hex)`.
  Register both in `generate_handler!` (`lib.rs:162`).
- `src/lib/types.ts`: `FlightInfo`, `AircraftInfo`, `FlightRoute`, `Airport` types.
- `src/lib/commands.ts`: typed `getFlightInfo`, `getAircraftPhoto` wrappers (like `getGroundElevation`, :477).
- **On demand only — nothing is fetched on selection.** `src/hooks/useFlightInfo.ts` (patterned on
  `useGroundElevation.ts`) exposes `{ state: idle|loading|loaded|error, info, photo, request() }`.
  `request()` is called by the button; the state resets to `idle` when the selected `hex|callsign`
  changes. A `useRef` asked-key drops answers that arrive for a previous aircraft (StrictMode-safe),
  and the photo fetch runs after the info answer.
- `src/components/AircraftDetailsPanel.tsx`: a **"Show Flight Infos"** button under Identity (:250),
  shown with new optional props `flightInfo`, `onRequestFlightInfo` and `isSimulated`. After a click
  the panel shows: airline · `LFPG → KJFK` (airport name and city on hover), type + registration,
  thumbnail + credit, and muted states such as "No route known" or "offline (cached)". Formatting
  helpers go in `src/lib/aircraft-details.ts`.
- **Simulated flights are never sent to the web.** Tracks carry no simulated flag. `page.tsx`
  merges `tracks`, `simulatedTracks` (:339) and `agentSimulatedTracks` (:415) at :565, so add a pure
  helper `isSimulatedTrack(hex, simulatedTracks, agentSimulatedTracks)` in `src/lib/` and pass
  `isSimulated` to the panel. When it is true the button is disabled with the tooltip "Not available
  for simulated flights", and `request()` is a no-op. Unit tests cover both.

### 5. Agent tool — `lookupFlightInfo({hex?, callsign?})`
- `adsb-data-server/src/server.rs` `dispatch` (:58): new arm → `flight_info::lookup` with a real
  fetch. If only callsign given, resolve hex from the latest `flights`/`positions` row (tool_service
  helper); if only hex, use its latest callsign.
- `adsb-agent/src/adsb_agent/server_tools.py`: schema in `SERVER_TOOLS` with a description that
  says "origin/destination airport, airline, aircraft type/registration from the public adsbdb
  database — not a filed flight plan", worded to avoid colliding with `getFlightSummary`/
  `getTrajectory`/`selectAircraft`. Update the agent's tool-description tests; probe the real local
  model in-process with "where is AFR123 going?" (memory: tool description collisions).
- Simulated guard on the server side: return a "simulated aircraft, no web lookup" result without
  fetching when the hex or callsign is in `scenario_tracks`. Limitation: agent-generated tracks that
  were never saved are not in the DB, so the tool description also says "live aircraft only".
- Not a frontend tool (backend names must not be re-registered in `useCopilotTools.ts`).

## Tests (written first)
- `adsb-data-engine`: round-trip upsert/get for both tables, negative row, tables present in export.
- `flight_info.rs`: parse fixtures (full 200, route missing, 404, malformed JSON); lookup with fake
  fetch — cache hit skips fetch, expired → refetch, fetch error → stale row + error, negative cache,
  storage `None` → still returns web result, callsign normalisation.
- `server.rs`: `dispatch("lookupFlightInfo")` with bad args → error value; callsign→hex resolution.
- Desktop photo cache: pure helper (path, data-URL encoding) unit test.
- TS: `useFlightInfo.test.ts` (no invoke before `request()`, mockInvokeResponse, StrictMode,
  stale-answer drop, reset to idle on selection change, no-op when simulated),
  `isSimulatedTrack` tests, panel button tests (click calls handler; disabled + tooltip when simulated),
  `AircraftDetailsPanel` component test (route rendered, rows absent when no info, photo credit),
  `aircraft-details` helper tests.

## Verification
- `cd adsb-feed/rust && cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check`
- `cd adsb-pulsar-client-desktop && npm test && npm run lint`
- Agent: its pytest suite (`uv sync --all-extras` first).
- Manual: `make up-desktop`, select a live airliner: nothing is fetched until you click "Show Flight Infos", then route, airline,
  type and photo appear. Enable demo flights and select one: the button is disabled. Click again on
  a live aircraft →
  served from cache (`origin: cache`); disconnect network → cached values with "offline" marker.
  `curl -X POST localhost:8788/tools/lookupFlightInfo -d '{"callsign":"AFR1234"}'`; ask the agent
  "where is <callsign> going?". Then `graphify update .`

## As built (2026-11-21) — deviations from the plan above

- **`adsb-data-server` had reqwest only as a dev-dependency** (the Pi recorder
  deliberately avoids a TLS stack). The lookup core is pure there with an
  injected fetch; the real fetch is behind a new optional `web-lookup` feature,
  enabled only by the desktop. Without it, `lookupFlightInfo` answers "not
  available in this build".
- **Two requests, not one combined call**: `/v0/aircraft/{hex}` and
  `/v0/callsign/{cs}` separately, so each part is cached and refreshed on its
  own TTL and an unknown hex does not hide a known route.
- `FlightInfo.origin` was renamed **`source`** (`cache | web | none`) to avoid
  confusion with the origin airport; a `simulated` flag was added.
- The cache tables are **not** added to `export_database_sync`: it exports only
  observed tables (scenarios and events aren't exported either).
- The cache methods live in a child module `adsb-data-engine/src/storage/flight_cache.rs`
  rather than growing `storage.rs`; same for `aircraft_photo.rs` in the Tauri crate.
- Real-model probe (the configured chat model via the MLflow gateway, 2 runs each, production
  context placement): route/airline/type questions by callsign or hex, French
  included, 8/8 → `lookupFlightInfo`; "selected aircraft" questions with UI
  context 6/6; neighbours (`selectAircraft`, `searchLiveFlights`,
  `getFlightSummary` path) unchanged.
