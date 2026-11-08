# Map render benchmark — findings

Question: should the desktop map leave Leaflet for speed, and if so for what?
Five variants were measured on identical synthetic data (seeded, 10k → 1M
positions, Montréal bbox), with the same colours and sizes:

| Variant | What it is |
|---|---|
| **leaflet** | the shipping `MapInner`, unmodified (canvas `DotsLayer`, react-leaflet `Polyline`s) |
| **canvas** | Leaflet kept; dots/lines drawn from typed arrays on ONE `L.Canvas` subclass (`src/lib/canvas-dots*.ts`), no GPU, no per-point objects. Added after the first runs |
| **deckgl** | Leaflet kept for the map; dots/lines drawn by a deck.gl overlay (vendored bridge, `src/lib/deck-leaflet/`; binary attributes) |
| **maplibre** | MapLibre GL 6, GeoJSON sources, circle/line layers |
| **openlayers** | OpenLayers 10 `WebGLVectorLayer`, flat styles, one `Feature` per point |

Plan: `docs/plans/2026-11-08-map-render-benchmark.md`. Harness: `src/bench/`,
pages `src/app/bench/*/page.bench.tsx` (built only with `BENCH=1`), driver
`bench/run.mjs` (`npm run bench`). Run of 2026-11-08: Apple M4 Max, WebKit
(Tauri's engine on macOS) and Chromium, 5 repetitions, medians. Raw output in
`bench/results/` (gitignored).

## Results that do not depend on the display

### Data load — `setData` until the library reports it has rendered (ms)

| Dots | 10k | 50k | 200k | 1M |
|---|---:|---:|---:|---:|
| WebKit leaflet | 14 | 41 | 141 | 721 |
| WebKit **deckgl** | 20 | 23 | **30** | **50** |
| WebKit maplibre | 81 | 241 | 810 | 4006 |
| WebKit openlayers | 37 | 118 | 409 | 2102 |
| Chromium leaflet | 22 | 78 | 252 | 1242 |
| Chromium **deckgl** | 16 | 19 | **22** | **40** |
| Chromium maplibre | 69 | 227 | 824 | 4710 |
| Chromium openlayers | 33 | 118 | 423 | 2229 |

Line style is cheaper for everyone (one object per track, not per point):
Leaflet 119 ms (WebKit) / 183 ms (Chromium) at 1M, deck.gl 28 / 27, OpenLayers
325 / 301, MapLibre 713 / 631.

### JS heap after GC, Chromium (MB)

| Dots | 10k | 50k | 200k | 1M |
|---|---:|---:|---:|---:|
| leaflet | 59 | 105 | 268 | 1166 |
| **deckgl** | 17 | 20 | **29** | **79** |
| maplibre | 24 | 36 | 125 | 504 |
| openlayers | 33 | 99 | 370 | **1834** |

GPU buffers are not in these figures; for deck.gl they are a few bytes per point.

## Frame-rate results (rerun, display verified)

These come from a separate run (`npm run bench -- --scenarios panzoom,live`,
2026-11-08 15:52). The refresh rate was checked before every measurement:

- **Chromium** was at 119–121 Hz in every run.
- **WebKit** was at 60 Hz (its cap), except the first 21 runs (dots at 10k, and one repetition at 50k). Those were throttled to 30 Hz for all four variants equally, so that cell is left out.

### Pan/zoom, dots: one identical gesture (4 drags and 4 zooms), times in ms

The p95 frame time hides Leaflet's cost, because the cost is **one long freeze
per `moveend`**, not many slow frames. The worst frame, the frame count and the
settle time show it.

| Dots | worst frame 200k | worst frame 1M | frames in gesture at 1M | settle at 1M (median / max) |
|---|---:|---:|---:|---:|
| **WebKit** leaflet | 346 | **1789** | 278 (p95 222) | 1297 / 1976 |
| WebKit deckgl | 21 | 29 | 453 | 27 / 30 |
| WebKit maplibre | 18 | 44 | 437 | 33 / 34 |
| WebKit openlayers | 102 | 312 | 373 | 22 / 26 |
| **Chromium** leaflet | 500 | **2550** | 588 | 1065 / 2520 |
| Chromium deckgl | 24 | 33 | 957 | 10 / 29 |
| Chromium maplibre | 10 | 9 | 942 | 16 / 17 |
| Chromium openlayers | 58 | 126 | 890 | 4 / 7 |

This is `DotsLayer` deleting and recreating every marker on each `moveend`/`zoomend`, even though `subsamplePositions` has already culled them to the viewport. At 200k the freeze is already about a third of a second. With lines, Leaflet stays smooth (worst frame 105–125 ms at 1M), and so do all the others.

OpenLayers reports fewer `moveend`s for the same gesture (4–6 vs 8), because it merges consecutive interactions into one. Its settle medians are therefore over fewer samples.

### Live — 500 aircraft, trails appended every 500 ms for 10 s

| | WebKit p95 | WebKit worst | update cost (WebKit / Chromium) |
|---|---:|---:|---:|
| leaflet, dots | **41 ms** | 126 ms | 69 / 89 ms |
| deckgl, dots | 18 ms | 23 ms | **15 / 8 ms** |
| maplibre, dots | 18 ms | 95 ms | 149 / 140 ms |
| openlayers, dots | 19 ms | 107 ms | 85 / 107 ms |
| leaflet, line | 33 ms | 122 ms | 32 / 30 ms |
| deckgl, line | 18 ms | 24 ms | 15 / 8 ms |

In WebKit, the engine the app actually ships on, live dots with Leaflet drop to about 25 fps at p95. Every GPU variant holds 60 fps at p95, but only deck.gl also never stalls: MapLibre and OpenLayers rebuild their GeoJSON or `Feature` objects on every update. In Chromium at 120 Hz the p95 is about 10 ms for all variants, and the difference shows only in the worst frame and the update cost.

The live baseline draws DOM triangle icons for the heads, while the GPU variants draw circles, so the baseline is doing slightly more work.

## Canvas renderer vs deck.gl (separate run, 2026-11-08 18:18)

Is the baseline's cost the per-point **objects** or the **drawing**? The
canvas variant keeps Leaflet and its 2D canvas and only drops the objects:

- positions are projected once to zoom-0 world pixels;
- they are counting-sorted into 1000 ft altitude bins;
- the canvas is redrawn with one `fill()` per colour after each `moveend`.

The run compared leaflet, canvas and deckgl only, with 5 repetitions, every run at
full refresh rate and no failures.

| 1M dots | load WebKit / Chromium | heap | worst pan/zoom frame WebKit / Chromium | settle WebKit (median / max) | live p95 WebKit / update cost |
|---|---:|---:|---:|---:|---:|
| leaflet | 731 / 1194 ms | 1169 MB | 1847 / 2542 ms | 1320 / 2058 ms | 43 ms / 71 ms (25k pts) |
| **canvas** | 120 / 101 ms | **77 MB** | 472 / 125 ms | 282 / 370 ms | 30 ms / 22 ms |
| deckgl | **53 / 42 ms** | 75 MB | **30 / 33 ms** | **27 / 30 ms** | **18 ms / 15 ms** |

At 200k dots, canvas has a worst frame of 118 ms in WebKit and 34 ms in Chromium, and settles in 76 ms in WebKit. deckgl manages 22 / 33 ms and settles in 28 ms. At 50k and below, canvas matches deckgl and loads 2–5× faster, because it has no GPU upload. With lines, canvas is the fastest variant to load, at 71 ms in WebKit and 36 ms in Chromium at 1M.

What this shows:

- **The objects were most of the cost.** The same Leaflet canvas, with no `L.CircleMarker` objects, loads 6–12× faster and uses 15× less heap.
- **The rest of the cost is the CPU redraw.** It grows with the number of points on screen. WebKit's 2D canvas is about 4× slower at it than Chromium's (472 vs 125 ms worst frame at 1M), and WebKit is the engine the app ships on. deck.gl's cost stays flat with size, because the GPU redraws on every frame.
- **Canvas has no hover tooltips or click-to-select yet.** The baseline attaches a tooltip to every marker, which is part of its cost. Canvas would need its own lookup of the point under the cursor, for example a grid index over the projected pixels. deck.gl provides this already (`pickable`).

## Findings

1. **Leaflet + deck.gl overlay is the fastest variant on every measure that matters here.** At 1M points it loads in 40–50 ms instead of 0.7–1.2 s. It uses 79 MB of heap instead of 1.2 GB. Its worst frame during pan or zoom is 33 ms, against Leaflet's 1.8–2.6 s freeze. With 500 live aircraft it updates in 8–15 ms, the only variant with no stall. Below about 50k points every variant is fine, so the difference only matters for DB history and density-scale data.
2. **MapLibre gives the smoothest interaction but the slowest data load.** Its worst frame is 10 ms at any size. But converting to GeoJSON and tiling it in the worker makes it 3–6× slower than Leaflet to show new data (4–4.7 s at 1M). Getting that back would need a non-GeoJSON data path. All of that would come on top of rewriting the whole map, including tiles, weather, labels, tooltips and selection.
3. **OpenLayers WebGL, the original question, doesn't pay for itself.** It settles quickly after a pan, but creating one `Feature` per point makes it about 2× slower than Leaflet to load and 1.6× heavier in memory at 1M points. A full migration would trade one bottleneck for two.
4. **Line style is not the problem.** Leaflet draws 1M positions as lines in 120–180 ms. The problem is per-point dots.
5. **A canvas renderer with no GPU removes most of the problem.** Removing the per-point objects alone cuts load time 6–12× and heap 15× (section above). What remains is a CPU redraw after each pan or zoom: under about 120 ms up to 200k points, but 0.3–0.5 s at 1M in WebKit.

## Recommendation

Keep Leaflet for the map: tiles, controls, live aircraft icons, labels and weather. Replace only the per-point `L.CircleMarker` objects in `DotsLayer`. There are two ways to do that, and both are now in the repo:

- **deck.gl overlay** (`src/lib/deck-leaflet/`, a vendored copy of deck.gl-leaflet 1.3.1, MIT). This is the choice if DB-history views can reach about 200k points or more. It is the only variant that stays at full frame rate in WebKit at every size. Hover and click picking are built in. It costs a dependency: `@deck.gl/core` and `@deck.gl/layers` move from devDependencies to dependencies.
- **Canvas renderer** (`src/lib/canvas-dots*.ts`). This is the choice if realistic views stay under about 200k points. It adds no dependency and loads fastest at small sizes, but tooltips and selection would need a hit-test index.

Either one also makes `subsamplePositions` and the rebuild on every `moveend` unnecessary for those layers. The deciding question is the typical point count of a DB-history view in real use, which this synthetic benchmark can't answer.

**Why the bridge is vendored.** The npm `deck.gl-leaflet` 1.3.1 hasn't had a release since 2024, and it pins `@deck.gl/core ^9`. Its package is also mis-declared: its CommonJS `main` sits inside a `"type": "module"` package, so a plain import resolves `LeafletLayer` to `undefined`. Its 232 lines now live in `src/lib/deck-leaflet/`, with the view maths split out and tested.

## Measuring frame rates reliably

The frame-rate results from the first full run were discarded. Partway through it, every variant's frame rate changed together (432 → 35 frames per gesture, 950 → 269). That happened because:

- the display went to sleep after 10 minutes (`pmset displaysleep 10`), and
- the browser windows opened on different monitors of a three-display setup, one of them a **30 Hz** 4K.

A shift that hits all variants at once is the environment, not the code. The driver now:

- holds `caffeinate -dimsu` for the duration of the run;
- pins Chromium to the main display (`--window-position=0,0`); and
- records the idle refresh rate before each measurement (`idleHz` on every result), flagging any run below 45 Hz in the log (`⚠ idle 30 Hz (throttled?)`).

WebKit's window position can't be set, and macOS denies moving it from a script without Accessibility permission. So keep the active screen at 60 Hz or more, and check the log for `⚠`.

Other caveats:

- WebKit caps at 60 Hz and Chromium follows the display, so compare variants within one engine, not across engines.
- MapLibre zooms one level lower for the same view (512 px tiles).
- The CopilotKit overlay from the root layout is on every page, so it affects all variants equally.
- No basemap tiles are loaded by any variant.
