# Weather service: runtime enable/disable (command), status (query), rate-limit-safe retries

## Context

`adsb-weather-server` (rust/adsb-weather-server) can only be controlled by
starting or stopping the process (`[weather].enabled`, `make up-/down-weather`).
There is no way to pause Open-Meteo fetching on a running node, for example to
save quota. There is also no way to see what the service is doing: fetching,
backing off, rate limited, or dead. The desktop only sees the grid and guesses
from `valid_time_ms`. A review of the retry path also found that
**a real Open-Meteo 429 isn't recognised as a rate limit** (§3), so a spent quota
is retried as if it were a network blip.

Goal:
- **Command**: enable/disable at runtime over a REST API, used by curl/make and by
  a toggle in the desktop UI.
- **Status**: served over REST (`GET`) and published over MQTT. The desktop reads
  status **only** from MQTT.
- **Provider calls respect rate limits on every retry path**: back-off, re-enable,
  restart, and mid-grid failure.

Decisions made with the user:
- Disabling pauses fetching only. The last grid stays retained.
- The setting is persisted to a state file, so a reboot doesn't undo a disable.
- The desktop has a toggle. The command goes over REST and the status comes from MQTT.
- REST binds `127.0.0.1` by default. `http_bind` is configurable, with no auth. A
  remote desktop needs `0.0.0.0` on the node.
- **Nothing is committed.** Work stays in the working tree on `feature/weather_layer`.
  Each step still goes test first (CLAUDE.md TDD rule).

## Design review: MQTT command/status practice and CQRS

The review checked the design against the Home Assistant MQTT `state`/`availability`
split, Homie `$state`, Sparkplug birth/death, and the AWS IoT shadow / Azure twin
desired/reported model.

| Practice | How the design meets it |
|---|---|
| **Liveness and state go on separate topics.** The LWT payload is fixed at CONNECT time, so it must not be a full status. | A retained `…/weather/availability` topic carries `online`/`offline`. `online` is the birth message on every ConnAck, `offline` is the LWT, and `offline` is also sent explicitly before a graceful disconnect. The retained `…/weather/status` keeps the last real status ("offline, was paused"). |
| **Desired vs reported state** | `WeatherStatus.enabled` is the accepted, persisted **desired** setting. `state` is the **reported** behaviour. The UI shows "pending" until they agree. |
| **CQRS: one writer per model; commands don't return the read model** | Command → desired store. Refresher → reported state. A projector joins them into `WeatherStatus`, which is the only thing the publisher and `GET` read. On the desktop, the MQTT relay is the only writer of status. `PUT` answers `202 Accepted` and the desktop reads only errors from it. |
| **Retained state, QoS 1, republish on ConnAck** | The broker has no persistence, so grid, status and availability are all republished on each ConnAck. |
| **Idempotent desired-state command** | `PUT /v1/enabled {"enabled": bool}`, not a toggle. Retries and double clicks are safe. |
| **Commands over REST, not an MQTT command topic** | Synchronous errors, no retained-command replay hazard, no MQTT 5 request/response machinery, and the desktop stays **subscribe-only** on the broker (ACL least privilege). |
| **Versioning and topic hierarchy** | Payloads carry `version`. The API is under `/v1`. Topics are `adsb/<stage>/weather/{grid,status,availability}`, so `…/weather/#` shows the whole service. |
| **The service owns the contract** | Wire types, the topic rule, route constants and a thin client live in dependency-free modules of the service crate. The desktop holds no refresh, back-off or persistence logic. |

## Design

### 1. Contract (adsb-weather-server, no service deps)

- **`status.rs`**:
  ```rust
  pub const STATUS_VERSION: u32 = 1;
  #[serde(rename_all = "snake_case")]
  pub enum ServiceState { Idle, Fetching, Retrying, RateLimited, Rejected, Disabled } // reported
  #[serde(rename_all = "snake_case")]
  pub enum RateLimitScope { Minutely, Hourly, Daily, Unknown }
  pub struct WeatherStatus {
      version,
      enabled: bool,                       // desired: the accepted, persisted setting
      state: ServiceState,                 // reported
      consecutive_failures: u32,
      rate_limit: Option<RateLimitScope>,  // set while state == RateLimited
      last_success_ms: Option<i64>, last_error: Option<String>,
      next_fetch_ms: Option<i64>,          // honours not-before (see §3)
      snapshot_valid_time_ms: Option<i64>,
      updated_at_ms: i64,
  }
  pub const AVAILABILITY_ONLINE: &str = "online";  pub const AVAILABILITY_OFFLINE: &str = "offline";
  pub struct WeatherTopics { grid, status, availability }
  impl WeatherTopics { pub fn from_grid_topic(t: &str) -> Self }
  // base = t without trailing "/grid" (else t); status = base/status, availability = base/availability
  ```
  The service derives its topics from its own `mqtt_topic`. The desktop derives
  them from `Config::weather_topic()`. Both use this one function.
- **`api.rs` route constants** (always compiled): `STATUS_PATH = "/v1/status"`,
  `ENABLED_PATH = "/v1/enabled"`, and the `SetEnabled { enabled }` body.
- **`api_client.rs`** (feature `client` = `dep:reqwest` only) provides
  `set_enabled(base_url, bool) -> Result<(), ClientError>` and `get_status`. It uses
  a 5 s timeout. Errors name the URL; a refused connection hints at `http_bind`.

### 2. Service internals: one writer per channel

```
PUT /v1/enabled ─► control (persist, then desired watch) ─┐
                                                          ├─► projector ─► status watch ─┬─► publisher ─► MQTT status (retained)
refresher ──────────► reported watch ─────────────────────┘                             └─► GET /v1/status
refresher ◄── desired watch (read-only)                    publisher: availability birth/LWT/shutdown, grid (unchanged)
```

- **`state_file.rs` + `control.rs`** (feature `service`):
  - The state file is JSON `{enabled, not_before_ms}`, written atomically through a
    `write_atomic` extracted from `cache::save`.
  - `control` is the only writer of `desired: watch<bool>`. `set_enabled` persists
    first, then sends; a failed write returns an error and changes nothing.
  - A missing file means enabled with no not-before.
- **`refresh.rs` `Refresher::run`** reads `desired` and is the only writer of
  `reported: watch<ReportedState>`.
  - While disabled it never calls `provider.fetch`.
  - Disabling during a fetch cancels it (`select!` against `desired.changed()`).
  - **Resume rule** (pure fn): next fetch = `max(now, pending_deadline, not_before)`.
    Toggling can't fetch early or skip a back-off. A deadline that passed while
    disabled fires at once.
- **Projector** (`projection.rs`): the only writer of `status: watch<WeatherStatus>`.
  Pure `project(desired, &reported, now_ms)`, re-run when either input changes.
- **`publisher.rs`**, still the only MQTT writer:
  - `set_last_will(availability, "offline", QoS1, retain)`.
  - On each ConnAck it publishes `online`, then status, then grid (all retained).
  - It publishes status and grid when they change.
  - It publishes `offline` before `disconnect()` on shutdown.
- **`api.rs`** (feature `http-api` = `dep:axum`, in `cli`) follows
  `adsb-data-server/src/server.rs` (`router(state)` + `serve(bind, port)`, and a
  bind failure isn't fatal).
  - `GET /v1/status` returns 200 with `WeatherStatus`.
  - `PUT /v1/enabled` returns 202 with `{"enabled"}`. A bad body gets 400, a
    persistence failure 500.
- **`main.rs`** wires the channels, spawns everything and joins it on shutdown.

### 3. Provider rate limiting and retry strategy (review findings → changes)

The current strategy (`src/provider.rs`, `src/refresh.rs` `next_delay`, shared
`adsb_pulsar_client::backoff::Backoff`) has these problems:

| # | Finding | Evidence | Change |
|---|---|---|---|
| R1 | **A real 429 isn't classified as rate limited.** Open-Meteo returns JSON `{"error":true,"reason":"…limit exceeded…"}`. `get()` turns any non-2xx body that parses into `Decode(Api(reason))`, so the status code is lost and `is_rate_limited()` returns false. The test passes only because its body is the plain text `"slow down"`. | `provider.rs` `get()`; `tests/open_meteo_provider.rs:131` | Keep the status: `ProviderError::Status { status, reason: Option<String>, retry_after: Option<Duration> }`. Classify on status first, body second. **Regression test:** a 429 with the JSON reason body must be rate limited. |
| R2 | **One back-off for every error.** A 400 (bad model, bad coordinates) is retried at 1, 2, 4… min forever, and a 5xx and a DNS failure are treated the same. | `next_delay` has only a `rate_limited` bool | `ProviderError::class() -> ErrorClass { Transient, RateLimited { scope, retry_after }, Rejected }`. Transient covers network, timeout, 5xx and 408, and backs off exponentially, capped at refresh. Rejected covers other 4xx and API rejections that aren't 429: wait a full refresh interval and report `state: rejected` with the reason. Config is read once, so it can only change on restart. |
| R3 | **The rate-limit delay ignores which limit was hit.** Every 429 waits `max(refresh, 30 min)`. After a daily limit that means ~24 more rejected attempts that day; after a minutely limit it is an hour's gap for a 60 s window. | `next_delay` | Pure `rate_limit_scope(reason)` checks the reason text for "Minutely", "Hourly" or "Daily", falling back to Unknown. Pure `rate_limit_delay(scope, retry_after, now)`, jittered, takes the largest of: `Retry-After` when present; minutely → 60 s (+ jitter); hourly → next full UTC hour; daily → next UTC midnight; unknown → today's `max(refresh, retry.max)`. Then `max(result, refresh)` for hourly, daily and unknown, never less. |
| R4 | **A restart forgets the back-off.** `make restart-weather` or a Pi reboot after a daily 429 fetches straight away. | Deadline lives only in the loop | A rate-limit deadline is persisted as `not_before_ms` in the state file (§2) and honoured at startup, on re-enable and in `next_fetch_ms`. It is cleared after a successful fetch. |
| R5 | **A mid-grid failure throws away paid calls.** The fetch is sequential over 50-location chunks, and a failure on chunk k discards chunks 0..k-1. The retry re-buys all of them. | `OpenMeteoProvider::fetch` | The provider keeps a **chunk cache** keyed by `(url, model hour)`, holding the decoded `LocationResponse`s of chunks that succeeded. A retry for the same model hour requests only the missing chunks. The cache is dropped when the hour changes or the snapshot assembles. Test: fail chunk 2 of 3, and the retry makes exactly 1 request. |
| R6 | **Sequential chunks aren't paced against the per-minute limit.** Defaults: 187 pts × 1.5 weight ≈ 280 calls in one burst, under 600/min. At `spacing_deg = 0.5` (~750 pts) it is ~1,100 calls in seconds, which trips the minutely limit on every refresh. | `fetch` loops with no delay; `budget.rs` only checks the daily limit | A **weighted token bucket** in `budget.rs` (pure, clock injected): capacity `MINUTELY_LIMIT × 0.8`, refill per second. Before each chunk the provider awaits enough tokens for `chunk_len × call_weight(variables)`. `report_budget` also warns when one refresh exceeds the minutely or hourly limit. Tested with a paused tokio clock. |
| R7 | **No jitter.** Open-Meteo limits are per IP. Several Pis behind one NAT, or a restart after a shared outage, retry in lockstep. | `Backoff::delay` is deterministic | Add `jittered(delay, rng)` for "full jitter" (uniform in `[delay/2, delay]`) in the weather crate. It uses an injected RNG so tests stay deterministic. The shared `Backoff` used by MQTT isn't changed. |

Status exposure: `state = rate_limited`, `rate_limit = scope`, and `next_fetch_ms`
set to the honoured deadline. The desktop line reads, for example, "Open-Meteo
daily limit reached — next try 00:00 UTC".

### 4. Config + stack

- **`src/config.rs` `WeatherConfig`** gets three new fields, each with clap, env,
  serde default and `overlay!`:
  - `http_port` (`ADSB_WEATHER_HTTP_PORT`, 8789, 0 disables)
  - `http_bind` (`ADSB_WEATHER_HTTP_BIND`, `127.0.0.1`, validated `IpAddr`)
  - `state_path` (`ADSB_WEATHER_STATE_PATH`, unset means in-memory; without it, a
    not-before doesn't survive a restart and the service logs a warning)
- **`adsb-stack-template.toml` `[weather]`** gets the same keys, with comments.
  `state_path = ".run/weather-state.json"`.
- **`scripts/render-config.py` `render_weather`** passes them through, with
  `state_path` going through `run_scoped`.
- **`scripts/stack.sh`**:
  - `stack_ports` adds the weather port when enabled.
  - New subcommands `weather-status`, `weather-enable` and `weather-disable` use curl.
  - `desktop_live_env` exports `ADSB_WEATHER_API_URL=http://<mqtt host>:<http_port>`.
- **`Makefile`**: `make weather-status`, `weather-enable` and `weather-disable`, added
  to the help text.

### 5. Shared MQTT source: several aux topics

`adsb-pulsar-client/src/source/mqtt_source.rs` supports one aux topic, and a
second call replaces it.
- Change it to `aux: Vec<(String, watch::Sender<Option<Vec<u8>>>)>`.
- `with_aux_topic(t)` adds a topic, or returns another receiver for an existing one.
- `topics()` lists the SBS topic plus the distinct aux topics.
- `route_publish` returns `Route::Aux(index)`.
- Tests: three topics get three subscriptions, routing reaches the right channel,
  and an aux topic equal to SBS still routes as SBS.

### 6. Desktop: query from MQTT, command over REST

**Config**
- `adsb-pulsar-client/src/config.rs` gets `weather_api_url` (`#[serde(default)]`,
  `ADSB_WEATHER_API_URL`).
- `Config::weather_api_url()` returns the explicit value, or `http://<mqtt_broker>:8789`.
- `apply_env_overrides` in `src-tauri/src/lib.rs` reads the env var (with a test).
- There is no Settings field.
- The call goes through Rust, because the webview CSP would otherwise need widening.

**Rust (`src-tauri`)**
- `Cargo.toml`: `adsb-weather-server` with `default-features = false, features = ["client"]`.
- **Query side (`weather.rs`)**:
  - `SharedWeatherService { status, availability }`.
  - Pure `next_status_update` and `parse_availability`; an empty retained payload clears.
  - `relay_weather_service` is the only writer and emits `adsb:weather-service`.
- `bridge.rs`: register the status and availability aux topics from
  `WeatherTopics::from_grid_topic(&config.weather_topic())`, and spawn the relay tied
  to `alive_rx`.
- `state.rs` gets `weather_service`.
- **Command side (`commands.rs` + `lib.rs`)**:
  - `get_weather_service` reads the query model.
  - `set_weather_service_enabled(enabled) -> Result<(), String>` calls
    `api_client::set_enabled` and doesn't touch the query model.

**TS**
- **`src/lib/weather.ts`**: types plus pure functions.
  - `describeServiceStatus(service, nowMs)`: paused, offline (was …), failing (n×)
    retrying HH:MM, rejected: reason, rate limited (scope) next try HH:MM.
  - `serviceToggleView(availability, service, pendingDesired)` returns
    `{checked, disabled, pending}`.
- **`src/lib/commands.ts`**: `getWeatherService` and `setWeatherServiceEnabled`.
- **`useWeatherSnapshot`** exposes `service` and `setServiceEnabled(desired)`.
  - Pending clears **only** when MQTT reports `enabled === desired`, or after a
    10 s timeout with "No confirmation from the weather service".
  - A command error clears pending and shows the error.
- **`WeatherControls`** gets a "Fetch weather" switch, the status line and inline
  error text. It is separate from "Winds aloft".
- `page.tsx` passes it through.
- Tests: `weather.test.ts`, `useWeatherSnapshot.test.ts` (with fake timers) and
  `WeatherControls.test.tsx`.

The chat agent's tool list is out of scope because of the tool-description collision
risk noted in memory.

### 7. Docs

- `DESIGN.md` → Weather Layer:
  - topics, birth/LWT, desired vs reported, CQRS flow (Mermaid, no `()<>[]` in labels)
  - REST API, resume rule, persistence
  - **retry strategy table**: error classes, rate-limit scopes, not-before, chunk
    cache, token bucket, jitter
  - desktop toggle and `ADSB_WEATHER_API_URL`
- `adsb-feed/CLAUDE.md` Transports: the extra topics and the API.
- `QUICKSTART.md` and `skills/run-adsb-stack/SKILL.md`: make targets and `http_bind`.
- Template `[weather]` comment: per-minute and per-hour limits next to the daily one.
- Run `graphify update .` after code changes.

## Implementation order (test first, nothing committed)

1. R1 regression test (429 + JSON body) → error classification (R1, R2)
2. Rate-limit scope and delay, plus jitter (R3, R7) → `next_delay` rework
3. Token bucket and pacing between chunks (R6); budget warnings
4. Chunk cache for partial retries (R5)
5. Contract: `status.rs`, `WeatherTopics`, route constants
6. `write_atomic`, `state_file.rs` (enabled + not_before, R4), `control.rs`
7. Refresher: desired input, cancel-on-disable, resume rule with not-before, reported output
8. Projector
9. Publisher: availability birth/LWT/shutdown + retained status
10. Config fields + `api.rs` + `main.rs`
11. `api_client.rs` against `api::router`
12. Template, render-config (+ pytest), stack.sh/Makefile, `ADSB_WEATHER_API_URL` export
13. MqttSource multi-aux
14. `Config::weather_api_url` + env override
15. Desktop Rust query relay + command
16. Desktop TS switch + status line
17. Docs

## Verification

- Rust, from `rust/`: `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check`
- Desktop: `npm test && npm run lint`
- Tooling: `make test`
- **Rate limiting without spending real quota.** Integration tests in
  `tests/open_meteo_provider.rs` run against a local axum fake:
  - a 429 with a JSON reason for each scope, with and without `Retry-After`
  - a 400 → rejected
  - a 503 → transient
  - chunk 2 failing → a single-chunk retry
  - pacing: the second chunk waits for tokens (paused clock)
- **Refresher tests** (paused clock):
  - daily 429 → next attempt at UTC midnight
  - restart with a persisted not-before → no fetch before it
  - re-enable during rate limiting → no fetch before the deadline
- **End to end** (dev stack, `[weather] enabled = true`):
  1. `make up && make up-weather`. `docker exec <broker> mosquitto_sub -t 'adsb/dev/weather/#' -v`
     shows `availability online`, a `status` and a `grid`. `make weather-status` matches.
  2. `make up-desktop`: the switch is on and the status line shows.
  3. Switch off in the UI. It shows pending, then settles when MQTT reports
     `enabled:false, state:disabled`. No new fetches appear in `make logs N=weather`,
     and the map keeps the last grid.
  4. `make restart-weather`: still disabled. `make weather-enable` flips the desktop
     switch through MQTT alone.
  5. Simulate a provider rate limit: set `base_url` to a local fake returning a daily
     429, then restart-weather. The status shows `rate_limited` (daily) with
     `next_fetch_ms` at UTC midnight. Restart again: still no request is made.
  6. `kill -9` the weather PID: `availability offline` arrives through the LWT, the
     retained status is unchanged, and the switch is disabled.
  7. Set `http_port = 0`, restart-weather, then click the switch: an inline error
     names the URL.
  8. `git status` shows the work uncommitted.

## Implementation notes (where the code differs from the plan above)

- The HTTP layer is three modules, not one: `api.rs` holds only the contract
  (routes, `EnabledSetting`, `ApiError`, `DEFAULT_HTTP_PORT`) and is always
  compiled; `api_server.rs` (feature `http-api`, part of `cli`) and
  `api_client.rs` (feature `client`, reqwest only) build on it.
- `state_file.rs` owns the whole durable file (`enabled` and `not_before_ms`)
  behind a single `StateStore`, because it has two writers (control and the
  refresh loop); `control.rs` serialises commands on top of it.
- The desktop derives the default API URL in `src-tauri/src/weather.rs`
  (`weather_api_url`), not in the feed `Config`, so the port constant stays in
  the weather crate. `Config` only stores `weather_api_url`.
- The shell test for `weather-status|enable|disable` fakes curl
  (`ADSB_CURL`) rather than running a stub server: a separate loopback listener
  could not be reached from the test environment, and the real HTTP path is
  covered by `tests/control_api.rs`.

## Addendum: OpenAPI and Swagger UI

Requested after the control API landed: the HTTP API exposes its OpenAPI
document and a Swagger UI.

- **Generated, not hand-written.** utoipa derives the document from the code:
  `ToSchema` on the contract types (`WeatherStatus`, `ServiceState`,
  `RateLimitScope`, `EnabledSetting`, `ApiError`), `#[utoipa::path]` on the two
  handlers. utoipa-axum's `OpenApiRouter` registers each route from the same
  attribute that documents it, so routing and the document cannot diverge.
- **Contract stays dependency-free.** The derives sit behind a new `openapi`
  feature (`cfg_attr`); the desktop's `client`-only build never compiles utoipa.
- **Routes.** `GET /v1/openapi.json` (always, with `http-api`) and Swagger UI at
  `/swagger-ui/` (feature `swagger-ui`, part of `cli`). Constants in `api.rs`.
- **No network at build time.** utoipa-swagger-ui with `vendored`: the UI
  assets come from a crate, so offline and arm64 Docker builds still work.
- **Tests** (`tests/openapi.rs`): the document lists exactly the contract's
  routes and methods, documents 202/400/500 for the command, carries the
  schemas with the same enum strings serde writes, every documented operation
  is actually routed, and the Swagger UI page is served pointing at the spec.
- **Gap fixed on the way:** `client` joins the default features, so
  `cargo test --workspace` runs `control_api` and `openapi` instead of silently
  skipping them.
