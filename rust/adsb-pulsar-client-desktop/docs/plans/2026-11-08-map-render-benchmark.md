# Map render benchmark: Leaflet (current) vs Leaflet + deck.gl vs MapLibre GL vs OpenLayers WebGL

## Context
We're considering moving away from Leaflet for speed. Before any migration, compare four options on the same data:
1. **Baseline**: the real `MapInner` component (Leaflet with `preferCanvas`, `DotsLayer` and react-leaflet `Polyline`s).
2. **Leaflet + deck.gl overlay**: keep Leaflet and draw dots and lines through `deck.gl-leaflet` with `ScatterplotLayer` and `PathLayer`.
3. **MapLibre GL**: a native WebGL map with `circle` and `line` layers fed by GeoJSON.
4. **OpenLayers with GPU rendering**: `ol` 10.x `WebGLVectorLayer` (`ol/layer/WebGLVector`) draws both dots and lines through flat styles. The style computes colour on the GPU from an `alt` feature property, using an expression with the same altitude bands as `cachedAltitudeToColor`. `WebGLPointsLayer` is the fallback if `WebGLVectorLayer` lines misbehave. If that happens, note it in the findings, because it would show how mature OpenLayers' WebGL path is. This variant settles the original question with numbers instead of assumptions.

Decisions already made: run on **WebKit** (the engine Tauri ships on macOS) and **Chromium** (adds heap and long-task metrics). Use **synthetic, seeded data** at 10k, 50k, 200k and 1M points. New libraries go in **devDependencies only**, and the bench pages are built only when `BENCH=1`, so the shipped bundle doesn't change.

One baseline cost the benchmark should expose: `DotsLayer` (`src/components/MapInner.tsx:938`) removes and recreates **every** circle marker on each `moveend` and `zoomend`, through the `viewState` dependency at line 1092.

## Layout
Work on branch `feature/map-render-bench`. Commit only, never push.

```
src/bench/
  data.ts            seeded generator → AircraftTrack[] (columnar Float64Array positions)
  stats.ts           percentiles, frame summary, ratio-vs-baseline, markdown table
  harness.ts         in-page runner: window.__bench = { run(scenario) → Result }
  adapters.ts        MapAdapter interface: setData, panBy, zoomTo, idle, destroy
  __tests__/data.test.ts, stats.test.ts
src/app/bench/{leaflet,deckgl,maplibre,openlayers}/page.bench.tsx   (dynamic import, ssr:false)
bench/run.mjs        Playwright driver → bench/results/<date>-<engine>.json + .md
```

- **Routes appear only for bench builds.** In `next.config.ts`, set `pageExtensions: process.env.BENCH ? ["tsx","ts","bench.tsx"] : ["tsx","ts"]`. A normal build then ignores `page.bench.tsx`, because with the default extensions the file name would be `page.bench`, which is not a page.
- **The baseline is the real component.** The leaflet page mounts `MapInner` with `dbHistoryTracks=<synthetic>`, empty live tracks and no weather, density or labels. That way the measurement covers the code that actually ships, not a copy of it.
- **The prototypes use the same visuals.** Colours come from `cachedAltitudeToColor` (`src/lib/colors.ts:131`), and dots and lines use the same sizes and opacity as `DotsLayer`. The prototypes don't use `subsamplePositions` (`src/lib/subsample.ts:22`), because GPU layers don't need it. That difference is part of what is being compared.
- **No basemap** in any of the three variants. Tile network latency would only add noise.

## Scenarios (each variant × size × trajectoryStyle `dots` and `line`)
1. **Initial render**: time from `setData` to the first frame after the map reports idle.
2. **Scripted pan and zoom**: a fixed 8 s sequence of `panBy` steps and zoom in/out, the same for every adapter. Record frame times with requestAnimationFrame and report p50, p95 and max, plus the percentage of frames over 16.7 ms and over 50 ms.
3. **Settle after the map stops moving**: time from `moveend` to the next frame painted. This captures the baseline's marker rebuild.
4. **Live updates**: 500 aircraft, with positions appended every 500 ms for 10 s, recording frame-time stats.
5. **Memory (Chromium only)**: `performance.memory.usedJSHeapSize` after a forced GC (`--js-flags=--expose-gc`).

The page runs each scenario itself, so Playwright's communication overhead doesn't affect the frame times. Playwright only calls `__bench.run` and collects the result.

## Measurement rules
Rules from the memory note "Perf tests: ratios, not ms budgets":
- Load a fresh page for every run, and use **5 repetitions with the variants in rotating order**. Report the median, and the ratio against the baseline in the same run.
- **Run headed.** Headless Chromium falls back to SwiftShader software rendering, which makes WebGL numbers meaningless. Record GPU and renderer details (WEBGL_debug_renderer_info) with each result.
- Stop a run after 60 s and record it as **DNF** (did not finish). The baseline at 1M points may hang, and a hang is itself a result.
- The benchmark never gates CI. `npm run bench` is run by hand.

## TDD
Following the project's CLAUDE.md, each item gets a red-green commit:
- `data.ts`: the same seed gives the same output, the point count is exact, positions are columnar and within the bounding box, altitudes are realistic and include null gaps.
- `stats.ts`: percentiles on known arrays, frame-summary thresholds, ratio and DNF handling, and the markdown table shape.

The adapters and bench pages are not unit tested, for the same reason `MapInner.tsx` isn't. The bench run itself is their check.

## Steps
1. Add devDependencies with exact versions: `maplibre-gl`, `ol`, `@deck.gl/core`, `@deck.gl/layers`, `deck.gl-leaflet`, `@playwright/test`. Then run `npx playwright install webkit chromium`.
2. Write `data.ts` and `stats.ts` test-first.
3. Write `harness.ts`, `adapters.ts` and the three pages, plus the `pageExtensions` gate in `next.config.ts`.
4. Add `bench/run.mjs` and the `"bench"` npm script (`BENCH=1 next build --webpack`, a static server, then Playwright).
   - **Check first:** whether `output: "export"` with a custom `distDir` still writes to `out/`. If it does, the script moves the export to `.bench-out/`, so the export Tauri ships is never left containing bench pages. Also check `src-tauri/tauri.conf.json` `beforeBuildCommand`.
5. Run the benchmark, then write a short findings section with the tables and a recommendation in `docs/DESIGN.md` (or a new `docs/MAP_BENCH.md`).

## Verification
- `npm test && npm run lint` and `cargo` gates stay green.
- A normal `npm run build` contains no `bench` routes: `ls out/bench` must fail.
- `npm run bench -- --sizes 10000 --reps 1` finishes on both engines and produces JSON and markdown.
- Sanity check: at 10k points the four variants should be within a small factor of each other. A large gap at that size means a harness bug, not a real difference.
- Then run the full matrix and review the tables.
