# Map render benchmark — findings

Question: should the desktop map leave Leaflet for speed, and if so for what?
Four variants were measured on identical synthetic data (seeded, 10k → 1M
positions, Montréal bbox), with the same colours and sizes:

| Variant | What it is |
|---|---|
| **leaflet** | the shipping `MapInner`, unmodified (canvas `DotsLayer`, react-leaflet `Polyline`s) |
| **deckgl** | Leaflet kept for the map; dots/lines drawn by a deck.gl overlay (`deck.gl-leaflet`, binary attributes) |
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

### Pan/zoom stalls — Chromium, dots, 120 Hz throughout (ms)

The p95 frame time is the same for all four (~10 ms), because Leaflet's cost is
one long freeze per `moveend`, not many slow frames. The worst frame and the
`moveend` → painted time show it:

| Dots | worst frame 200k | worst frame 1M | settle 1M (median / max) |
|---|---:|---:|---:|
| leaflet | 418 | **2417** | 1069 / 2355 |
| deckgl | 25 | 27 | 12 / 28 |
| maplibre | 10 | 10 | 17 / 17 |
| openlayers | 50 | 126 | 4 / 8 |

Leaflet also delivers a third fewer frames during the same 1M gesture (≈620 vs
≈960). This is `DotsLayer` deleting and recreating every marker on each
`moveend`/`zoomend` — even with `subsamplePositions` already culling to the viewport.

## Findings

1. **Leaflet + deck.gl overlay is the fastest variant on every measure that matters here.** At 1M points it loads in 40–50 ms instead of 0.7–1.2 s. It uses 79 MB of heap instead of 1.2 GB, and it never freezes during pan or zoom. Below about 50k points every variant is fine, so the difference only matters for DB history and density-scale data.
2. **MapLibre gives the smoothest interaction but the slowest data load.** Its worst frame is 10 ms at any size. But converting to GeoJSON and tiling it in the worker makes it 3–6× slower than Leaflet to show new data (4–4.7 s at 1M). Getting that back would need a non-GeoJSON data path. All of that would come on top of rewriting the whole map, including tiles, weather, labels, tooltips and selection.
3. **OpenLayers WebGL, the original question, doesn't pay for itself.** It settles quickly after a pan, but creating one `Feature` per point makes it about 2× slower than Leaflet to load and 1.6× heavier in memory at 1M points. A full migration would trade one bottleneck for two.
4. **Line style is not the problem.** Leaflet draws 1M positions as lines in 120–180 ms. The problem is per-point dots.

## Recommendation

Keep Leaflet for the map: tiles, controls, live aircraft icons, labels and weather. Move only the **dense point layers** (`DotsLayer` for DB history and density-scale data) onto a deck.gl `ScatterplotLayer` with binary attributes. That would also make `subsamplePositions` and the rebuild on every `moveend` unnecessary for those layers.

Before adopting it, decide how to depend on the bridge. `deck.gl-leaflet` 1.3.1 hasn't had a release since 2024, and its package is mis-declared: its CommonJS `main` sits inside a `"type": "module"` package, so a plain import resolves `LeafletLayer` to `undefined`. The bench imports `dist/deck.gl-leaflet.esm.js` directly to work around this. The bridge is small, so a thin in-house overlay (a Leaflet layer that syncs a `Deck` view state on `move`/`zoom`) is a reasonable alternative to vendoring it.

## Not concluded from this run, and why

The tables for pan/zoom p95, live updates, and WebKit settle/pan-zoom are **not used** above. Partway through the run, every variant's frame rate changed together, for example 432 → 35 frames per gesture, and 950 → 269. That happened because:

- the display went to sleep after 10 minutes (`pmset displaysleep 10`), and
- the browser windows opened on different monitors on a three-display setup (120 Hz ProMotion, 120 Hz, and a **30 Hz** 4K).

A shift that hits all variants at once is the environment, not the code. The driver now:

- runs `caffeinate -dimsu` for the duration of the run;
- records the idle refresh rate before each measurement (`idleHz` on every result); and
- flags any run below 45 Hz in the log (`⚠ idle 30 Hz (throttled?)`).

To re-measure the frame-rate scenarios, keep the active screen (where new windows open) on a display running at 60 Hz or more, then run:

```bash
npm run bench -- --scenarios panzoom,live
```

Other caveats:

- WebKit caps at 60 Hz and Chromium follows the display, so compare variants within one engine, not across engines.
- In the live scenario, the baseline draws DOM triangle icons for aircraft heads while the GPU variants draw circles.
- MapLibre zooms one level lower for the same view (512 px tiles).
- The CopilotKit overlay from the root layout is on every page, so it affects all variants equally.
- No basemap tiles are loaded by any variant.
