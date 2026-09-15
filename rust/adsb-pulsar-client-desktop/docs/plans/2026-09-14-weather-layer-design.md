# Weather Layer — winds aloft + pressure on the map

## Context

The map shows traffic but not the air it flies through. Aircraft at FL340 can ride a
150 kt jet stream while the surface is calm, and SBS-1 carries only ground speed/track
(no TAS/heading), so wind **cannot be derived from our own feed** — it must come from a
weather model. Goal: a dedicated Rust service fetches gridded winds aloft + MSL pressure
from Open-Meteo and publishes them on the existing MQTT edge bus; the desktop renders a
toggleable weather layer and shows the wind each selected aircraft is experiencing.

## Scope decisions

| Topic | Decision |
|---|---|
| Purpose | Aviation context: winds aloft at pressure levels + MSL pressure |
| Time | Current only (no forecast slider, no history, no DuckDB persistence) |
| Provider | Open-Meteo, behind a `WeatherProvider` trait (one impl) |
| Placement | New workspace crate `rust/adsb-weather-server`, standalone binary |
| Transport | **MQTT only**, retained message. No HTTP API |
| Desktop link | Reuses the live-feed MQTT connection → weather available **only when `source_kind=mqtt`**; socket mode shows layer as unavailable |
| Extent | Receiver-centred grid, ±300 NM, 1° spacing (~11×15 = 165 pts), hourly |
| Model | `best_match` default, `[weather] model` configurable |
| Rendering v1 | Wind barbs at grid points; hover tooltip = MSL pressure + wind at level |
| Level UX | Manual picker SFC/850/700/500/300/250/200 hPa **+** per-aircraft wind |
| Per-aircraft | Selected-aircraft details panel: wind at its altitude, head/tail + crosswind |
| Particles | Same branch, **after** barbs are proven end-to-end (separate commits) |
| Stack | `[weather] enabled = false` by default (needs internet) |
| Failure | Last-good snapshot (memory + disk cache), backoff, UI stale badge > 3 h |
| Agents/sim | Out of scope for v1 |

**Explicitly out of scope:** HTTP endpoint, METAR/TAF, forecast/history playback,
isobars/colour fields, agent tools, simulation wind drift, weather in socket mode.

## Facts that shape the design (verified)

- Open-Meteo pressure-level vars (`wind_speed_250hPa`, `wind_direction_250hPa`, …) are
  **`hourly=` only**, not `current=` → request `past_hours=1&forecast_hours=2` and pick the
  hour nearest now. Multi-location = comma-separated lat/lon, response is a JSON **array**
  (an object when there is a single location — handle both).
- Free tier: 10k/day, 5k/h, 600/min, non-commercial, **CC BY 4.0 attribution required**.
  >10 variables counts fractionally (15 vars = 1.5 calls); treat each location as a call.
- Budget: 3 surface vars (`pressure_msl`, `wind_speed_10m`, `wind_direction_10m`) + 6
  levels × 2 = 15 vars → 165 × 1.5 × 24 ≈ **5.9k/day**. Adding `geopotential_height` (21
  vars) would hit 8.3k — **dropped**: SBS altitude is barometric pressure altitude, so the
  ISA formula `p = 1013.25·(1 − 6.8756e-6·h_ft)^5.2559` maps an aircraft directly to hPa.
- `MqttSource` (`adsb-pulsar-client/src/source/mqtt_source.rs`) broadcasts raw payload
  lines with **no topic**; a second topic on the same connection needs topic routing, or
  weather JSON would reach the SBS-1 parser.
- Desktop gets `mqtt_topic` from `Config` (`adsb-pulsar-client/src/config.rs`);
  `stack.sh` exports `ADSB_MQTT_TOPIC` for `make client`.
- Convention: topics `adsb/<stage>/…`, publisher client id must be unique on the broker.
- Broker runs with persistence off: retained messages die with a broker restart → the
  service republishes on every `ConnAck`.

## Design

### 1. `rust/adsb-weather-server` (new workspace member)

Features: `service` (default: reqwest w/ rustls + json, clap, toml, rumqttc via
`adsb-pulsar-client` `default-features=false, features=["mqtt"]` — no protoc) vs. bare lib
exposing only the snapshot types, so the Tauri crate can depend on it with
`default-features = false` (same pattern as `adsb-data-server`).

| Module | Responsibility |
|---|---|
| `snapshot.rs` | `WeatherSnapshot { version, source, attribution, model, fetched_at, valid_time, grid: GridSpec, surface, levels }`, flat row-major `Vec<Option<f32>>` |
| `grid.rs` | Receiver-centred `GridSpec` from lat/lon/radius_nm/spacing (lon extent widened by 1/cos φ) + `points()` |
| `budget.rs` | `estimated_daily_calls(points, vars, refresh_minutes)`; warn at startup if > 8k |
| `provider.rs` | `WeatherProvider` trait |
| `open_meteo.rs` | URL builder (chunked), response parsing, nearest-hour selection, configurable base URL |
| `cache.rs` | Load/save last-good snapshot, atomic write (temp + rename) |
| `publisher.rs` | Retained publish, client id `<receiver.id>-weather`, republish on every ConnAck |
| `refresh.rs` | Fetch loop, keep last-good on error, capped exponential retry (1 → 30 min) |
| `config.rs` / `main.rs` | TOML config + clap, mirroring `adsb-data-server` |

### 2. Stack integration (`adsb-feed/`)

- `adsb-stack-template.toml`: `[weather]` section, `enabled = false`.
- `scripts/render-config.py`: `render_weather()` → `.run/weather.toml`.
- `scripts/stack.sh`: start after the broker when enabled; `down` stops it; `doctor` checks
  topic stage and budget. Export `ADSB_MQTT_WEATHER_TOPIC` next to `ADSB_MQTT_TOPIC`.
- `Makefile`: include the new binary in `make build`.

### 3. MQTT source + Tauri bridge

- `Config::mqtt_weather_topic` + `weather_topic()` (explicit, else derived from
  `…/sbs/raw` → `…/weather/grid`, else `None`).
- `MqttSource::with_aux_topic(topic) -> watch::Receiver<Option<Bytes>>`; pure
  `route_publish(topic, sbs, aux)`. `MessageSource` trait unchanged.
- `bridge.rs`: MQTT source attaches the aux receiver; a task parses the snapshot, stores it
  in `AppState.weather`, emits `adsb:weather`.
- `commands.rs`: `get_weather_snapshot`, `weather_availability`.

### 4. Frontend

- `lib/weather.ts`: parse, ISA pressure altitude, interpolation, wind components, barb
  parts, staleness, levels.
- `hooks/useWeatherSnapshot.ts`.
- `MapInner.tsx`: `WeatherBarbsLayer` + Open-Meteo attribution.
- `page.tsx` / `Filters.tsx`: toggle, level picker, stale badge, unavailable reason.
- `AircraftDetailsPanel.tsx`: wind row with head/tail + crosswind.

### 5. Animated particles (follow-up)

Spike `leaflet-velocity` against react-leaflet / React 19 / React Compiler; fall back to a
custom canvas particle layer.

**Decision (2026-09-15): custom canvas layer, no dependency.** `leaflet-velocity` 2.1.4 is
unmaintained since March 2023, registers itself on the global `L`, ships no types, and wants
GRIB-JSON (north-to-south rows, separate u/v records) — a second conversion of data we already
interpolate correctly in `lib/weather.ts`. The grid is ~190 points; the particle maths is
~150 lines and, written as pure functions, unit-testable, which the plugin would not be.

| Piece | Role |
|---|---|
| `lib/wind-particles.ts` | Pure. `createWindField(snapshot, level)` precomputes u/v once (typed arrays, NaN = missing) and samples bilinearly without allocating; `fieldBounds`, `intersectBounds`; `createParticles` / `stepParticles` over struct-of-arrays state; `degreesPerPixel(zoom)`, `particleCount(w, h)`, `speedBucket(kt)` |
| `WindParticlesLayer` (`MapInner.tsx`) | Imperative, via `useMap()`: a `<canvas>` in its own pane (z 450: above tiles and density, below every marker, `pointer-events: none`), `requestAnimationFrame` loop, trails by fading the previous frame with `destination-in` |
| `WeatherControls` | Two display toggles under "Winds aloft": **Barbs** (default on) and **Particles** (default off — it is a continuous animation, so opt in). Persisted as `adsb-weather-barbs` / `adsb-weather-particles` |

Motion model:

- Particles live in **geographic** coordinates, so the pure step needs no projection. Speed is
  a constant number of **screen pixels per knot per second** at every zoom (real wind speed
  would be invisible — 100 kt is 0.0005°/s). One pixel is `D = 360 / (256·2^zoom)` degrees of
  longitude, and `D·cos φ` degrees of latitude on Web Mercator, so
  `Δlon = u·k·dt·D`, `Δlat = v·k·dt·D·cos φ` — isotropic on screen.
- A particle is **re-seeded** (and draws no segment that frame, or it would streak across the
  map) when it ages out, leaves the visible∩grid bounds, or reaches a cell with a missing
  corner. Ages start randomised so particles don't all respawn on the same frame.
- `dt` is clamped (0.1 s): after a backgrounded tab resumes, particles must not teleport.
- Pan/zoom: clear and stop on `movestart`/`zoomstart`; on `moveend`/`zoomend`/`resize`,
  re-anchor the canvas at the container origin, resize for `devicePixelRatio`, re-seed, resume.
- Colours: 6 speed buckets (<20, 20–40, …, ≥100 kt), one `stroke()` per bucket per frame.

Out of scope: antimeridian-crossing view bounds (a receiver-centred ±300 NM grid does not reach
it in practice), `prefers-reduced-motion` (the toggle defaults off).

Particle commits (TDD): (a) `lib/wind-particles.ts`; (b) `WeatherControls` display toggles;
(c) `WindParticlesLayer` + page wiring; (d) docs.

## Build sequence (TDD, one red-green-refactor per commit)

1. Crate skeleton + snapshot + grid + budget.
2. Open-Meteo URL builder + parsing + HTTP fixture test.
3. Cache + refresh loop with fake provider.
4. Publisher + config + main.
5. Stack integration.
6. `Config::weather_topic`, `route_publish`, `MqttSource::with_aux_topic`.
7. Tauri state, bridge task, commands.
8. `lib/weather.ts`.
9. Hook + Filters.
10. Barbs layer + page wiring.
11. Details panel wind row.
12. Particles.
13. Docs.

## Verification

- `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check`
- `npm test && npm run lint`
- End to end with `[weather] enabled = true`: retained snapshot visible via
  `mosquitto_sub`, survives broker restart, barbs change with level, aircraft wind row,
  stale badge with an old cache, socket mode shows the layer as unavailable.
