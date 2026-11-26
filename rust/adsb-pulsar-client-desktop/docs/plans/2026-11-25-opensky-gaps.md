# OpenSky gap filling — `adsb-opensky-server` + desktop overlay

## Context

The local receiver has blind spots (terrain, range limits), so a selected aircraft can drop
out of local tracking, and some areas are never covered. OpenSky Network's REST API can fill
those gaps. A new dedicated Rust server holds the OpenSky credentials and polls OpenSky for:
- (a) aircraft the user selected, by icao24;
- (b) areas the user drew (bbox).

It publishes the results on MQTT, and the desktop draws them next to local tracks with a
distinct style. **Display only: nothing is written to DuckDB.** The recorder stays "what my
receiver heard", so coverage and range statistics stay honest.

### Decisions (from the user)
- **Persistence:** display only.
- **Gap rule:** a user toggle. "Gaps only" (default) shows OpenSky for a selected aircraft only
  while its local track is stale. "Always" shows both, side by side.
- **Backfill:** on demand. A *Fill gaps* button in the details panel makes one `/tracks` call
  (`time=0`, 4 credits) and draws the waypoints as a dashed segment.
- **Watch list:** the desktop owns it and sends it over the control API. **The server does not
  persist it.** Caps:
  - Selected aircraft: polling stops 5 min after local loss, or once the aircraft is 250 NM
    from the receiver, whichever comes first.
  - Areas: an aircraft is shown only while it is inside the area.

### OpenSky facts this design depends on
- OAuth2 client credentials only (Basic auth is gone). Token URL:
  `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`.
  Tokens live 30 min, and a 401 means "refresh and retry once".
- `/states/all` takes repeated `icao24` parameters or `lamin/lomin/lamax/lomax`. The response is
  a positional 18-field array (0 icao24, 1 callsign, 3 time_position, 4 last_contact, 5 lon,
  6 lat, 7 baro_alt m, 8 on_ground, 9 velocity m/s, 10 track, 11 vrate m/s, 13 geo_alt,
  14 squawk, 16 position_source).
- Credits are counted per bucket (`/states`, `/tracks`) and per day:
  - 400 anonymous, 4,000 standard user, 8,000 active feeder.
  - Cost per call: an icao24-only query is 1; a bbox is 1 up to 25 sq°, 2 up to 100, 3 up to
    400, 4 above.
  - Time resolution is 5 s authenticated, 10 s anonymous.
  - Headers: `X-Rate-Limit-Remaining`; on a 429, `X-Rate-Limit-Retry-After-Seconds`.
  - **A fixed 10 s poll costs 8,640 credits a day, which a standard account cannot afford.** The
    poll interval therefore has to be budget-driven.
- `/tracks/all?icao24=&time=0` returns the live track as waypoints (time, lat, lon, baro_alt,
  track, on_ground). It is sparse, and OpenSky labels the endpoint *experimental*.

## Design

### Server crate `rust/adsb-opensky-server/`

New workspace member, modelled on `adsb-weather-server` (copy its patterns, do not depend on it):
- Features: `default = ["cli","client"]`; `service` (reqwest with rustls, rumqttc); `openapi`;
  `http-api`; `swagger-ui`; `metrics`; `client`. The desktop uses
  `default-features=false, features=["client"]`.
- Contract modules, free of service dependencies:
  - `api.rs`: paths and DTOs, `DEFAULT_HTTP_PORT = 8791` (free: 8787/8788/8789/8790 are taken).
  - `states.rs`: the `OpenSkyState` DTO and the parser for the positional array.
  - `status.rs`: `OpenSkyTopics::from_states_topic` (states / status / availability).
  - `budget.rs`.

**Credentials (`credentials.rs`), resolved in this order:**
1. `--client-id` / `--client-secret` (clap; env `ADSB_OPENSKY_CLIENT_ID`,
   `ADSB_OPENSKY_CLIENT_SECRET`).
2. `--credentials-file` / `ADSB_OPENSKY_CREDENTIALS_FILE`: the `credentials.json` that OpenSky's
   account page downloads (`{clientId, clientSecret}`).
3. Neither given: anonymous mode. The budget drops to 400 a day, `/tracks` is disabled, and a
   warning is logged.

The secret is never logged, never in `--print-config`, and never in the rendered `.run/*.toml`.

**`auth.rs`:** a `TokenSource` that caches the token until `expires_in − 60 s`, refreshes on
expiry, and handles a 401 by refreshing and retrying once. It uses the existing `Backoff` from
`adsb-pulsar-client::backoff` for transient failures. A trait lets tests inject a fake.

**`provider.rs`:** an `OpenSkyProvider` trait with `states_by_icao(&[hex])`,
`states_in_bbox(bbox)` and `track(hex)`.
- The reqwest implementation uses a 30 s timeout and the user agent
  `adsb-opensky-server/<ver>`.
- It reads `X-Rate-Limit-Remaining` and maps errors into the classes Transient / Rejected /
  RateLimited{retry_after}, mirroring the weather server's `provider.rs` `ErrorClass`.

**`watch.rs`:** the in-memory watch set. It is **not persisted**, and every entry is a lease.
- `PUT /v1/watch` from client `<client_id>` replaces that client's
  `{ icao24: [..], areas: [{id, north, south, east, west}] }`.
- A lease expires after `lease_seconds` (default 60). The desktop renews every 20 s.
- So a crashed desktop costs nothing within a minute, and a restarted server learns the list
  again from the next renewal. The desktop also resends as soon as it sees `availability=online`.
- Server-side guards, enforced whatever the client sends:
  - at most `max_icao` hexes (20) and `max_areas` areas (4);
  - an area must be valid (south < north) and no larger than `max_area_sq_deg` (100; 2 credits);
  - an empty union means **no polling at all**.

**`budget.rs` and `scheduler.rs`:**
- A cycle is one `/states` call for the union of hexes (cost 1), plus one call per area (cost by
  area).
- Interval = `max(min_interval_s (10), cycle_cost × 86 400 / (daily_credits × spend_fraction 0.9))`.
- `X-Rate-Limit-Remaining` re-plans the rest of the day: it stretches the interval when the
  balance is lower than planned.
- A 429 waits `Retry-After` and publishes `status.rate_limited_until`.
- Pure functions on an injected `now`, as the weather server's `next_delay` does.
- Logged at startup and on each watch change: "N hexes + M areas → one poll every X s,
  ≈Y credits/day".

**`credits.rs`: credit ledger, rolling 24 h.**
- Every call made to OpenSky is recorded as `(ts_ms, bucket: states|tracks, cost)`, and so is
  every token request (cost 0, counted as a request).
- Stored as 288 slots of 5 min per bucket, which bounds memory.
- Pure functions:
  - `used_last_24h(now)`;
  - `hourly(now) -> [24 × {hour_start_ms, states, tracks}]`.
- **Persisted** in `state_path` (`.run/opensky-state.json`, atomic write, after each poll and
  debounced), so a restart does not reset the count. This is not the watch list, which stays in
  memory only, as decided.
- Next to the ledger, the server keeps the last `X-Rate-Limit-Remaining` per bucket. That is
  OpenSky's own figure, and it can differ from ours: other apps may use the same account, and
  OpenSky's reset window is not documented.
- The scheduler plans from `min(daily_credits − used_24h, remaining)`.
- Exposed in three places:
  - in the retained status: `credits: {daily_limit, states_used_24h, tracks_used_24h,
    states_remaining?, tracks_remaining?}`;
  - by `GET /v1/credits`, which returns the hourly series for the last 24 h;
  - in `/metrics`, as the counter `adsb_opensky_credits_spent_total{bucket}` and the gauge
    `adsb_opensky_credits_remaining{bucket}`.

**`publisher.rs`**, copied from the weather server's publisher:
- Client id `<source_id>-opensky` and `MAX_PACKET_BYTES = 1 MiB`, with the const assert against
  `MAX_INCOMING_PACKET_BYTES`.
- Last will `availability=offline`, retained. Status is retained. On each ConnAck it publishes
  online, then status.
- On each poll it publishes **non-retained** to `adsb/<stage>/opensky/states`:
  `{ fetched_ms, states: [OpenSkyState + matched: {icao|area:<id>}] }`. Non-retained on purpose:
  a stale retained position would mislead.

**`api_server.rs`** (axum + utoipa, loopback by default, `http_port = 0` disables it):
- `GET /v1/status`: enabled, authenticated, credits remaining, interval, watch counts, last
  error.
- `PUT /v1/enabled`: in memory only; this deviates from the weather server because nothing is
  persisted.
- `PUT /v1/watch/{client_id}`.
- `GET /v1/track/{icao24}`: proxies `/tracks/all?time=0`. 404 when OpenSky has no live flight;
  409 when anonymous. Its credits are counted separately, in the `/tracks` bucket.
- `/v1/openapi.json`, `/swagger-ui/`, `/metrics` (outside the documented routes, as in the
  weather server).

**`api_client.rs`** (`client` feature), used by the desktop: `put_watch`, `get_track`,
`set_enabled`, `status`.

**Topic rule:** `Config::opensky_topic()` goes in `rust/adsb-pulsar-client/src/config.rs`, next
to `weather_topic()` (~line 1029): `adsb/<stage>/sbs/raw` → `adsb/<stage>/opensky/states`. The
same rule goes in `scripts/render-config.py` beside `weather_topic()` (line 171), with the
"change both or neither" comment and a test on both sides.

### Stack integration (mirror `[weather]`)
- **`adsb-stack-template.toml` `[opensky]`:**
  - `enabled = false`, commented `topic`, `daily_credits = 4000`, `min_interval_s = 10`,
    `lease_seconds = 60`, `max_icao`, `max_areas`, `max_area_sq_deg`, `http_port = 8791`,
    `http_bind = "127.0.0.1"`, `state_path = ".run/opensky-state.json"` (the credit ledger,
    stack-scoped through `run_scoped()`);
  - `client_id = ""`, `client_secret = ""` **or** `credentials_file = ""`, with a comment that
    this file is gitignored like a `.env`.
- **`scripts/render-config.py`:** `render_opensky()`, written always but **without** the
  secret. Add tests in `scripts/tests/test_render_config.py`.
- **`scripts/stack.sh`:**
  - `opensky)` / `stop-opensky` / `opensky-status|enable|disable`;
  - started by `up` when enabled;
  - the secret is passed as process env (`ADSB_OPENSKY_CLIENT_ID/SECRET`), the way
    `start_desktop` passes API keys;
  - doctor: binary present, port collision, a credential-free `curl` to the auth host, and a
    warning when enabled without credentials;
  - `desktop_live_env` exports `ADSB_OPENSKY_API_URL`.
- **Makefile:** `up-opensky`, `down-opensky`, `restart-opensky`, `opensky-status`,
  `opensky-enable`, `opensky-disable`, plus help text. Add `scripts/tests/test_stack_opensky.sh`
  (fake binary through `ADSB_BIN`).

### Desktop — Rust (`src-tauri/src/`)
- **`bridge.rs` (~line 94, MQTT only):** add `s.with_aux_topic(topics.states)`, plus the status
  and availability topics. A new relay task, as for the weather tasks 5–7, decodes in Rust and
  emits `adsb:opensky` and `adsb:opensky-service`.
- **The relay never touches `IngestPipeline`, so nothing is recorded.**
- **New `opensky.rs`:** `opensky_api_url(&config)`, payload validation, and a
  `SharedOpenSky` in `AppState` for hydration (pattern: `weather.rs`).
- **Commands (registered in `lib.rs` `generate_handler!`):**
  - `set_opensky_watch(icao24, areas)`;
  - `get_opensky_track(icao24)`;
  - `set_opensky_enabled`;
  - `get_opensky_service`.

  All of them go through `api_client`, Rust side. The webview never calls the server, so the CSP
  does not change.

### Desktop — frontend (`src/`)
- **`types.ts`:**
  - `OpenSkyState`;
  - `ExternalTrack` (`AircraftTrack` plus `source: "opensky"`, a timestamped `points`, and
    `matched`);
  - `last_position_ms` on `AircraftTrack`, set in `mergePositionInto` (`last_seen` also moves on
    messages without a position, so it cannot measure a position gap).
- **New `hooks/useOpenSky.ts`:** hydrates, then listens to `adsb:opensky` and
  `adsb:opensky-service`. It keeps a `Map<hex, ExternalTrack>` that is **separate from
  `AircraftTrackingContext`**, never merged into live data. Entries are dropped after
  2 × the poll interval without an update; that is how "leaves the area" removes an aircraft.
- **New `lib/opensky-watch.ts`** (pure, unit tested):
  - `computeWatch(selected, liveTracks, receiver, mode, now)` gives the icao24 list:
    - a selected hex is watched while selected;
    - in "gaps" mode only while its local position is older than `GAP_THRESHOLD_MS` (20 s);
    - it stops once `now − last_position_ms > 5 min` or the OpenSky position is more than
      250 NM from the receiver.
  - `visibleExternal(...)` applies the gap rule for display. In "gaps" mode an external track is
    hidden when a local track with the same hex is fresh.
- **New `hooks/useOpenSkyWatch.ts`:**
  - computes the watch with a value signature (CLAUDE.md gotcha on array deps);
  - calls `set_opensky_watch` when it changes, and every 20 s as the lease renewal;
  - resends when availability turns online.
- **Areas:** reuse `MapPickerLayer` area mode (`MapInner.tsx:251`) through the existing
  `mapPickingMode` / `handleMapPickComplete` (`page.tsx:1395`). A small discriminator says who
  asked for the pick (event form or OpenSky).
  - Areas are kept in `useLocalStorage("adsb-opensky-areas")`, client side, as decided.
  - They are drawn as dashed violet rectangles, like event bboxes (`MapInner.tsx:220`).
  - The UI warns when an area costs more than 1 credit.
- **New `components/OpenSkyControls.tsx`**, a nested section under "Map Layers" in `Filters.tsx`:
  - *Fetch from OpenSky* switch, with confirm-by-status as in `WeatherControls.tsx` and
    `useWeatherSnapshot.ts:111`;
  - Gaps / Always toggle;
  - area list (add with "Draw area", remove);
  - status line: credits left, interval, rate limit.
- **Map (`MapInner.tsx`):** a new `OpenSkyLayer`.
  - Hollow aircraft icon in the altitude colour, with an "OpenSky" tooltip.
  - Dashed trail.
  - For a selected aircraft, a dashed connector from its last local position to the first
    OpenSky point, so the gap reads as a gap.
  - Backfill waypoints as a dashed polyline.
  - Props go through `page.tsx`, then `Map.tsx`, then `MapInner`.
- **Table:** a new `TrackSection` `"opensky"` with an `OSKY` badge. Rows are selectable, but
  flight-info lookup and recording are not applicable.
- **Credit counter, bottom bar (`MetricsBar.tsx`):** a new optional `openSkyCredits` prop.
  - Shows `OpenSky: 1,234 / 4,000 (24h)`.
  - Colour: slate below 70%, amber from 70%, red from 90% or while rate-limited.
  - Tooltip: per-bucket use, OpenSky's own `remaining` figure, the current poll interval and any
    rate-limit deadline.
  - Hidden when the service is not enabled or not seen. The data comes from the status topic
    through `useOpenSky`, so the counter updates without polling.
- **Credit counter, Analytics panel (`DBHistoryAnalytics.tsx`):** a new section, *OpenSky
  credits — last 24 h*.
  - Hourly stacked bars (`/states`, `/tracks`) with a reference line at the hourly average the
    budget allows, plus a total.
  - Labelled as always covering the last 24 h, independent of the panel's time range.
  - Data from a new Tauri command `get_opensky_credits`, which calls `GET /v1/credits` through
    `api_client`. Refreshed on open and every 60 s while the panel is open.
  - Tests use the Recharts jsdom harness (fixed-size `ResponsiveContainer`, animation off).
- **`AircraftDetailsPanel.tsx`:**
  - *Fill gaps (OpenSky)* button, which calls `get_opensky_track`; disabled when anonymous or for
    simulated tracks;
  - "Last OpenSky position Xs ago" line.

### Explicitly out of scope
- Recording to DuckDB.
- Agent or chat tools.
- `/states/own` (feeder self-view).
- Pi arm64 build target (can be added later in `rust/Makefile`).

### Refactors this implies (none silently)
- No shared extraction is needed. OpenSky's budget is a daily credit pool, not the weather
  server's per-minute `TokenBucket`. The only reuse is `Backoff`, already shared in
  `adsb-pulsar-client`.
- Small edits to existing code, listed for approval:
  - `last_position_ms` on `AircraftTrack` and in `mergePositionInto`;
  - a requester discriminator on `mapPickingMode`;
  - a new `TrackSection` value.

## Files

- **New:**
  - `rust/adsb-opensky-server/**`;
  - `src-tauri/src/opensky.rs`;
  - `src/hooks/useOpenSky.ts`, `useOpenSkyWatch.ts`;
  - `src/lib/opensky-watch.ts`;
  - `src/components/OpenSkyControls.tsx`;
  - `scripts/tests/test_stack_opensky.sh`;
  - `docs/plans/2026-11-24-opensky-gaps.md` (this plan, saved first per `rust/CLAUDE.md`).
- **Modified:**
  - `rust/Cargo.toml` (member);
  - `adsb-pulsar-client/src/config.rs` (`opensky_topic`);
  - `src-tauri/{Cargo.toml,bridge.rs,state.rs,commands.rs,lib.rs}`;
  - `src/lib/types.ts`;
  - `src/contexts/AircraftTrackingContext.tsx`;
  - `src/app/page.tsx`;
  - `src/components/{Map.tsx,MapInner.tsx,Filters.tsx,AircraftTable.tsx,AircraftDetailsPanel.tsx}`;
  - `scripts/{render-config.py,stack.sh}`;
  - `Makefile`;
  - `adsb-stack-template.toml`;
  - `DESIGN.md` (new "OpenSky Gap Filling" section), `CLAUDE.md` (crate row, transports note),
    `QUICKSTART.md`.

## Build order (TDD, one red-green-refactor per commit, branch `feature/opensky_gaps`)

1. **Server contract:** `states.rs` parser (fixture JSON with nulls, string/number edge cases),
   `budget.rs` (cost by area, interval for 4,000 and 8,000 credits, re-plan from Remaining),
   `credits.rs` (rolling-window expiry at 24 h, hourly series, a state-file round-trip that
   survives a restart, planning from the tighter of the ledger and Remaining),
   `watch.rs` (lease expiry, union, caps, oversize area rejected).
2. **Server I/O:**
   - `auth.rs` against a local axum fake token endpoint (cache, expiry, 401 retry once);
   - `provider.rs` against a fake OpenSky (repeated `icao24` query, bbox params, 429 with
     Retry-After, Remaining header);
   - the scheduler on a paused tokio clock;
   - the publisher's decision functions and the topic/const asserts.
3. **Control API:** `control_api.rs` and `openapi.rs` integration tests (doc matches the routes;
   `/metrics` undocumented); loopback default test; secret-redaction test on `--print-config`.
4. **Topic rule** in both Rust and Python, with tests; render and stack scripts, with tests.
5. **Desktop Rust:** payload validation and hydration unit tests in `opensky.rs`.
6. **Desktop TS:** `opensky-watch.test.ts` (gap threshold, 5 min cap, 250 NM cap, "Always"
   mode, signature stability); `useOpenSky` (drop after 2 intervals); `OpenSkyControls`
   (confirm-by-status, area cost warning); details-panel button state; `MetricsBar` counter
   (hidden when the service is absent, colour thresholds); `DBHistoryAnalytics` credits section
   (renders the 24 bars and the total).
7. **Docs:** DESIGN.md, CLAUDE.md and QUICKSTART.md, then `graphify update .`.

## Verification
- From `rust/`: `cargo test --workspace && cargo clippy --workspace -- -D warnings &&
  cargo fmt --all --check`.
- From the desktop directory: `npm test && npm run lint && npx tsc --noEmit`.
- `make test-scripts`.
- Live check:
  - set `[opensky] enabled = true` and the credentials in `adsb-stack.toml`;
  - `make doctor`, `make up-desktop`;
  - `make opensky-status` should show authenticated, 0 watches and no polling;
  - draw an area over a busy sector: hollow OpenSky aircraft appear and the logged interval
    matches the budget;
  - `mosquitto_sub -t 'adsb/dev/opensky/#' -v` should show states, status and availability;
  - select a local aircraft leaving coverage: once it is stale for more than 20 s, a dashed
    OpenSky continuation appears and stops after 5 min or 250 NM;
  - *Fill gaps* draws the waypoints;
  - the bottom-bar counter rises by the cost of each cycle and matches `/v1/credits`; the
    Analytics section shows the current hour's bar; after a server restart the counter keeps
    its 24 h total;
  - kill the desktop: the server stops polling within 60 s (lease);
  - restart the server: the desktop re-sends its watch on `online`;
  - `make verify` and the DuckDB row counts show no OpenSky rows.
