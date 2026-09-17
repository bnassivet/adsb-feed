# Historical weather in the desktop app

*Implemented 2026-09-17. Follows `2026-09-17-weather-persistence.md`, which created
the `weather_snapshots` table this reads.*

## The bug this fixes

The recorder stores one weather snapshot per model hour. Nothing read it.

Meanwhile the desktop drew wind barbs from **whatever `adsb:weather` last pushed** —
the current model hour — with no reference to what the user was looking at. `page.tsx`
handed the live snapshot to the map unconditionally, so browsing a week-old track in
analysis mode showed **today's winds over it**, silently.

That is worse than drawing nothing, because it looks like an answer.

The per-aircraft Wind / Headwind / Crosswind rows were not wrong but were blunt: wind was
suppressed entirely for DB-history and imported selections. The committed design doc said
why, in as many words: *"That guard exists because historical weather does not exist. This
change creates the data that makes it liftable."* This is that follow-up.

## Outcome

In history and analysis mode the barbs, the particles, the per-aircraft wind rows **and
what the chat agent is told** all describe the weather of the time being viewed, and say
which hour that is.

## Decisions

| Decision | Choice |
|---|---|
| Storage coverage | **Mirror positions**: whoever records positions records weather. Remote mode already worked through the `OBSERVED_TABLES` view; embedded mode gained a small write in the relay. |
| Which hour | **The map follows the browsed window's end; each aircraft follows its own `last_seen`.** Two time inputs, two cached lookups. |
| Scrubber | Deferred. It is additive on top of this design — it would set the map time directly, feeding the same hook and selectors, and `getWeatherHistory` already returns the hour list its ticks need. |

## Shape

Nine commits, each a Red-Green cycle.

| Piece | Role |
|---|---|
| `get_weather_history` / `get_weather_at` | Tauri commands delegating to `tool_service`. Named for the axis that differs, because `get_weather_snapshot` was already taken by the live relay — call the service functions **fully qualified**. |
| `lib/weather-history.ts` | Every pure piece: `parseRecordedSnapshot`, `nearestSnapshotTime`, `tracksTimeSpan`, `weatherTimesFor`, `selectMapWeather`, `selectAircraftWind`, `lruGet`/`lruPut`. |
| `hooks/useHistoricalWeather.ts` | Two scalar times in, two slots out. A **sibling** of `useWeatherSnapshot`, never an extension of it. |
| `WeatherControls` `history` prop | Describes the recorded hour and its distance from the viewed time. |
| `page.tsx` | `onBrowse` at both panel call sites; the derivation; both copilot configs. |

### Why the pure pieces live in `lib`

`page.tsx` has no tests of its own. Logic placed there is logic nobody can pin — and
inlining the time derivation would have left the wiring step with no Red to write.
`weatherTimesFor` is the same code either way; only its testability differs.

### Why a sibling hook

`useWeatherSnapshot` is a *control-plane* hook — four of its five state atoms are about
the MQTT weather service, and it owns two subtle mechanisms (an availability race, and a
CQRS confirm cleared during render). The sourcing models are opposites: push versus
pull-keyed-by-a-time-that-changes-as-you-browse. And the consumer needs **two** weathers
at once, which a `{ snapshot }` shape cannot express.

Keeping them apart is what makes *"the live path did not regress"* trivially true rather
than argued.

### `unsupported_source` is a claim about the live plane only

It means: weather arrives over MQTT and this session reads a dump1090 socket. It gated
**four** things in `WeatherControls`, and three are wrong for recorded weather, which
comes out of DuckDB — the disabled checkbox, the advice to change the live source, and
the *Fetch weather* switch commanding a service irrelevant to an hour already stored.

The plan named two of those four. The fourth — `{show && !unsupported}`, which wraps the
entire control body — was found only by reading the component. Had it been missed, a
socket session browsing history would have shown a working, enabled checkbox above an
empty panel.

So `unsupported` split into `browsing` and `liveUnsupported`, and each gate reads as what
it means. The fourth case then falls out correctly instead of depending on anyone noticing
it. **Naming a concept precisely is what turns a missed case into an impossible one.**

### Validity forks; `isStale` does not

`isStale` is **signed on purpose**: a model hour slightly in the future is the short
forecast the service publishes for the back half of each hour, not staleness. It was left
alone. History asks a different question — distance in *either* direction from the viewed
time — answered by `snapshotOffsetMs` / `isOffHour` / `describeRecordedValidity`.

`describeRecordedValidity` deliberately avoids the word *"valid"*: in `weather.ts` that
means "relative to now", and two lines that read alike must not mean different things
depending on the mode. `"valid 6 d ago"` would read as a fault rather than as the answer.

### The agent sees what the map shows

Leaving the copilot live-only would have reproduced the map's bug **in prose**, which is
worse — text carries no visual cue that it is describing the wrong day. Both weather tools'
`unsupported_source` early returns became live-only, and the context readable gained a
`mode` field.

`windReport` needed a caller-side fork rather than a change: it reports `validity` and
`stale` against the wall clock, which is right for its other (all live) callers and would
otherwise have handed the agent *"valid 2 d ago, stale: true"* for a snapshot describing
the viewed instant exactly.

The copilot configs read a `viewWeatherSnapshot` that is **not** `mapWeather.snapshot`:
the latter goes null when the layer is switched off, and the chat tools answer wind
questions with the layer hidden today. Tying them to the drawn snapshot would have broken
that quietly.

## Traps met

1. **`get_weather_snapshot` collides twice** — the Tauri command name *and* the Rust fn.
2. **Remote mode must never INSERT** into what is a view there.
3. **StrictMode**: bump the request id in the effect body, never inside a `setState`
   updater — the rule CLAUDE.md records from `useTrajectoryPlayback`.
4. **Live-event vs historical-fetch race**: select on *mode*, never on "whichever is
   non-null". The MQTT subscription keeps running while history is on screen.
5. **`levels` is comma-separated TEXT**, not JSON; `payload_bytes` is on `Meta` only.
6. **No migration mechanism** — `parseRecordedSnapshot` rejects an unknown `version`
   rather than half-rendering it.
7. **`doBrowse` depends on `onBrowse` identity** — `useCallback`, both call sites.
8. **Hook ordering.** The copilot calls had to move *below* the weather derivation: they
   consume the view-selected snapshot, which is not known until the selection and browsed
   span resolve. Placing them earlier is a TDZ error that no test catches, because no test
   renders `page.tsx`.

## Verification

**(a) No fabrication needed.** List recorded hours, browse a Custom window bracketing one,
select flights, → Analysis. Expect barbs plus *"model hour N min earlier/later"*. **The
regression check is the mirror image:** browse a window with *no* recorded hour and confirm
the map goes empty with *"No weather was recorded for this time."* Today it would show
current winds. That one comparison demonstrates the fix.

**(b) Synthetic past hours** via the `duckdb` CLI (app stopped) or `ATTACH` over the Quack
share. Shift `valid_time_ms` by whole days **and patch the payload's own `valid_time_ms`**
with `json_merge_patch` — the frontend renders from the payload, so a row whose payload
keeps the original hour looks right in the listing and then renders with the wrong
validity. Verify `select valid_time_ms, payload->>'valid_time_ms'` agree on every row.

**(c) Remote mode** against the Pi daemon — exercises the `OBSERVED_TABLES` view path and
confirms the desktop does **not** write through the view.

Finish in `npm run tauri dev`, not just Vitest: Vitest runs against source, so React
Compiler behaviour must be checked at runtime.

## Still open

- The scrubber (deferred above).
- `tsc --noEmit` is **not** in the documented CI gate, and Vitest strips types without
  checking them. 55 pre-existing type errors sit in five test files as a result. Two
  separate bugs in this work — a TDZ ordering error and a props mismatch — were caught
  only because `tsc` was run deliberately.
