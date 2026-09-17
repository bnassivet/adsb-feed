# Weather in CopilotKit + agent — chat control of the wind layer

## Context

The weather layer (barbs, particles, level picker, per-aircraft wind) is on
`feature/weather_layer`, but chat cannot see or drive any of it. The weather
controls in the Filters panel (`WeatherControls`: Winds aloft, level, Barbs,
Particles) have no CopilotKit tool, the agent's ambient context says nothing
about weather, and the model cannot answer "what's the wind at FL340 over the
receiver?". Goal: the same control surface in chat, plus a read tool, plus
ambient context — following the existing client-tool pattern.

Weather data only lives in the frontend (Tauri state → `useWeatherSnapshot`);
the Tauri tool server has none. So **both new tools are client tools** (like
`searchLiveFlights`), not `SERVER_TOOL_NAMES` entries.

## Design

### 1. Pure helpers — `src/lib/weather.ts` (tested)

- `resolveWeatherLevel(input: string, levels: number[]) → { level } | { error }`
  Accepts `"surface"`/`"sfc"`, `"250"`, `"250hPa"`, `"FL340"` (nearest available
  level by `hpaToFlightLevel`). Error text lists the valid options via `levelLabel`.
  A string param, not a `"surface" | number` union: local models handle an
  `anyOf` schema badly.
- `windReport(snapshot, { lat, lon, altitudeFt?, level?, trackDeg? }, nowMs)`
  → `{ fromDeg, speedKt, level label / altitudeFt, headwindKt?, crosswindKt?,
  validity, stale }` or `{ error }` (outside grid / missing data). Reuses
  `interpolateWind`, `interpolateWindAtLevel`, `windComponents`,
  `describeValidity`, `isStale`. Rounded values so the LLM quotes clean numbers.

### 2. Tools — `src/hooks/useCopilotTools.ts`

New optional `weather?: WeatherToolsConfig` on `DisplayToolsConfig` (optional
like `scenarios`, so existing tests/callers keep working; tools report
"weather unavailable" when absent):
`{ snapshot, availability, show, level, showBarbs, showParticles, setShowWeather,
setWeatherLevel, setShowWeatherBarbs, setShowWeatherParticles }`.

- **`setWeatherLayer`** — params all optional: `enabled`, `level` (string),
  `barbs`, `particles`. Only provided fields change. Refuses with an explanatory
  error when `availability === "unsupported_source"` (weather needs
  `source_kind = mqtt`), mirroring the disabled checkbox. Turning on barbs or
  particles also turns the layer on (otherwise the call visibly does nothing).
  Returns the resulting state + validity. Render: `DisplaySettingCard "Weather Layer"`.
- **`getWindAloft`** — params: `hexIdent?`, `latitude?`, `longitude?`,
  `altitudeFt?`, `level?`. Resolution order: aircraft (position, altitude, track
  → head/crosswind) → explicit point → receiver location; altitude beats level;
  default level is the one on screen. Errors for no snapshot / unsupported source
  / aircraft not found / outside grid. Render: `DisplaySettingCard "Wind"`.
- `setLayerVisibility` description gains "weather/wind is controlled by
  setWeatherLayer" — one owner per verb (the toggleDemoFlights lesson).

### 3. Ambient context — `src/hooks/useCopilotContext.ts`

Optional `weather` field → one `useAgentContext` "Weather layer (winds aloft)":
`{ availability, shown, level: levelLabel, barbs, particles, validity, stale }`,
or `"unsupported: live source is not MQTT"`.

### 4. Wiring — `src/app/page.tsx`

Pass the existing `weather`, `showWeather`, `weatherLevel`, `showWeatherBarbs`,
`showWeatherParticles` state and setters into both hooks (setters wrapped so
`setWeatherLevel` gets a resolved `WeatherLevel`). No new state.

### 5. Agent — `rust/adsb-agent`

- `tools.py` fallback list: add `setWeatherLayer` and `getWindAloft` with the same
  schemas/descriptions (keep in sync, per the toggleDemoFlights note).
- `prompt_sections.yaml` guideline: weather → `setWeatherLayer` to show/hide/change
  level/barbs/particles; `getWindAloft` to read wind (aircraft, point, or
  receiver) — call it rather than guessing; weather needs the MQTT live source;
  report direction as "from", knots, and the validity.
- Not server tools: `SERVER_TOOL_NAMES` in `graph.py` unchanged.

### Out of scope

Weather in the Tauri tool server / `adsb-data-server` tool API, MSL pressure
queries, simulation wind drift, voice-specific handling.

## Build sequence (TDD, one red-green-refactor per commit)

0. Save this plan as `adsb-pulsar-client-desktop/docs/plans/2026-09-15-weather-copilot-tools.md`.
1. `resolveWeatherLevel` + `windReport` tests → impl (`src/lib/__tests__/weather.test.ts`).
2. `setWeatherLayer` tests (partial update, unsupported refusal, bad level, barbs
   implies enabled, missing config) → impl; bump "registers all N tools".
3. `getWindAloft` tests (aircraft head/crosswind, point, receiver default,
   altitude vs level, errors) → impl; `setLayerVisibility` description assertion.
4. `useCopilotContext` weather readable tests → impl; `page.tsx` wiring.
5. Agent: `tests/test_tools.py` (tools present, schemas valid) + a prose test
   (setLayerVisibility points to setWeatherLayer; guideline mentions both) →
   `tools.py` + `prompt_sections.yaml`.
6. Docs: DESIGN.md → AI Agent client-tools table (§~4006) and Weather Layer
   section ("Chat control"), DOCUMENTATION.md if a pattern is worth it, desktop
   CLAUDE.md note; `graphify update .`; graphify commit.

## Verification

- `cd adsb-pulsar-client-desktop && npx vitest run src/lib/__tests__/weather.test.ts src/hooks/__tests__/useCopilotTools.test.ts src/hooks/__tests__/useCopilotContext.test.ts && npm test && npm run lint`
- `cd adsb-agent && uv run pytest tests/test_tools.py tests/test_system_prompt_render.py && uv run pytest`
- `npx next build --webpack` (React Compiler) succeeds.
- Live (stack with desktop on MQTT + agents): in chat — "show winds at FL340 with
  particles" → layer on, level 250 hPa, particles on; "what's the wind for
  <callsign>?" → from/speed + head/crosswind matching the details panel;
  "hide the barbs" → barbs off only. With `ADSB_SOURCE_KIND=socket`, the tool
  answers that weather needs the MQTT source.
