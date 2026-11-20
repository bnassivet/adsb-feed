# Map engines: Leaflet, OpenLayers, Cesium, MapLibre

Question: should the desktop map move to a "more advanced" engine, OpenLayers
or Cesium.js, and could the engine be a choice next to Leaflet?
This is an analysis. No product code changed.

It follows [MAP_BENCH.md](MAP_BENCH.md) (2026-11-08). That benchmark measured
OpenLayers in its naive form, one `Feature` per point. It found OpenLayers 2×
slower to load than Leaflet and 1.6× heavier. This second test checks
whether that verdict was OpenLayers' fault or the variant's. It also measures
Cesium for the first time, and MapLibre + deck.gl (flat and pitched) in a
second run. A later section maps the wanted layers (terrain, ICAO charts,
weather, sea, 3D buildings) to open sources, engines and a cache policy.

## Recommendation: the way forward (2026-11-19)

Synthesis of everything below. The evidence is in the sections it cites.

**Decision.**
- **Today:** keep Leaflet + deck.gl. It is the fastest on every measure and
  every app layer exists there.
- **3D target:** MapLibre + deck.gl, with deck.gl *interleaved*. It is the only
  candidate that covers terrain, 3D buildings, airspace volumes and offline
  PMTiles with open, keyless data. Measured level with Leaflet when flat or
  pitched, and adding terrain and buildings costs almost nothing.
- **How:** move to it as a **replacement** for Leaflet, not as a second engine
  next to it. Running two engines means writing every map feature twice
  (*Engine as a runtime choice*). Pitch is a camera setting, so the flat view
  remains available.
- **Ruled out:**
  - **OpenLayers.** It has no 3D. It is only worth revisiting if OGC weather
    editing outweighs 3D.
  - **Cesium.** Choose it only if a true globe becomes a requirement. Its cost
    is a 13 MB bundle, build workarounds and a full rewrite of every layer.

**Phases.** Each phase decides whether the next one happens.

| # | What | Engine | Go/no-go for the next phase |
|---|---|---|---|
| 0 | New layers in the app as it is: OpenAIP airspaces, one GeoJSON per AIRAC cycle, labelled with the cycle and drawn as deck.gl polygons; METAR stations, which also provide QNH; a radar WMS; OpenSeaMap and EMODnet; a pre-made relief raster | Leaflet | Are terrain, relief and airspaces actually used? If not, stop here and stay on Leaflet. |
| 1 | Close the open measurements: tiles over the network during gestures, a weaker GPU, a visual check that a hill or building hides an aircraft, and the deck.gl / MapLibre 6 `map.transform` issue (upstream fix, or pin MapLibre 5) | bench | Every item passes, or has a mitigation that is written down. **Done 2026-11-19: go, with three written mitigations** (*Phase 1 results*). |
| 2 | Port: MapLibre style; the tile cache behind `addProtocol`, keeping `store.ts`, `loadTile.ts` and `prefetch.ts`; the deck.gl data layers, which move almost unchanged; markers, popups and the context menu; label layout reworked for a pitched view. `exposeTransform` moves from `src/bench/` to `src/lib/`, together with its tests | MapLibre | Feature parity with today's flat map, checked layer by layer against `MapInner.tsx`. |
| 3 | 3D content: Terrarium terrain, buildings around airports only, airspace volumes, and aircraft heights corrected with QNH | MapLibre | — |
| 4 | Offline: PMTiles extracts served from Rust through a Tauri custom protocol. This is the "local tile server" the 2026-11-08 cache decision was waiting for | MapLibre | — |

**Risks to carry.**
- **deck.gl and MapLibre 6.** deck.gl 9.4.1 reads `map.transform`, which
  MapLibre 6 moved. That breaks **every interleaved overlay and every map with
  terrain**, not only terrain as first thought (*Phase 1 results*). The shim is
  five lines but depends on a private field. A canary test
  (`deck-compat-canary.test.ts`) fails once deck.gl stops reading it; recheck it
  on every upgrade of either library.
- **No hardware GPU.** With software WebGL, MapLibre draws a frame in about
  2 s, flat or pitched, where Leaflet only stalls now and then. The port
  requires hardware WebGL2 (*Phase 1 results*).
- **Live latency.** Interleaving adds one frame of latency to live updates.
  That is negligible next to the 500 ms bridge flush, but it should stay
  measured.
- **Labels.** Collision-free labels are the least portable piece, because once
  the map is pitched, screen projection is no longer affine.
- **Licences.** OpenAIP is CC BY-NC-SA, so non-commercial use only. The OACI
  1:500,000 chart is restricted: check the terms before caching it.
- **CSP.** Every new remote host goes into both CSP files.
- **Hardware.** All numbers so far come from one M4 Max. Phase 1 added proxies
  (slow network, software GPU, Retina, slow CPU), but a real weaker GPU (an
  integrated Intel or AMD chip) is still unmeasured. The command is ready:
  `npm run bench -- --variants leaflet,deckgl,maplibre-deckgl-3d-il,maplibre-deckgl-terrain,maplibre-deckgl-buildings --sizes 200000 --styles dots`.

## Phase 1 results (2026-11-19)

Plan: `docs/plans/2026-11-19-map-engine-phase1-bench.md`. Same M4 Max, 200k
dots (the real 24 h view), 3 repetitions unless stated, Chromium 158 and WebKit
27.2. Raw output: `bench/results/2026-11-19T*` and `checks-2026-11-19T20-22-02/`
(gitignored). **Verdict: go for phase 2**, with the three mitigations in bold
below written into it.

### 1. Tiles over the network during gestures

New `--net` option. The driver adds latency per request and queues every
response on one shared link (`src/bench/net.ts`). It applies to fixture tiles
only: *dsl* is 60 ms at 8 Mbit/s, *mobile* is 150 ms at 2 Mbit/s. New metric
`idleMs`: time from the end of the gesture until MapLibre's `idle` (every tile
in).

| | WebKit p95 / worst frame | Chromium p95 / worst | `idleMs` WebKit (local / dsl / mobile) | `idleMs` Chromium |
|---|---|---|---|---|
| terrain (zoom 7) | 18 / 23–29 ms on every profile | 9.1–9.2 / 9.4–17 | 0 / 1.2 s / 11 s | 0 / 1.0 s / 15.6 s |
| city (terrain, zoom 15) | 18 / 22–23 | 9.1–9.3 / 9.4–9.5 | 0 / 0 / 0 | 0 / 0 / 0 |
| buildings | 18 / 23–24 | 9.2 / 9.4 | 0 / 1.9 s / 19 s | 0 / 1.8 s / 26.7 s |

- **Frames do not depend on the network.** Tiles decode in MapLibre's workers,
  so a slow link never blocks a frame. p95 and the worst frame are identical on
  every profile.
- **What a slow link costs is completeness.** The new tiles finish arriving
  1–2 s after a gesture on DSL and 11–27 s on the mobile profile. Meanwhile the
  terrain shows coarser levels and buildings pop in late. The city view needs
  nothing new, because its DEM is a few overzoomed tiles that are already in.
- **Mitigation, for phase 2:** terrain and buildings go through the tile cache
  (`addProtocol`) from the start, prefetched around the receiver like the
  raster basemap today. Phase 4's PMTiles takes them off the network entirely.
  Also check whether the style's two DEM sources (terrain and hillshade, same
  URL, as MapLibre advises) fetch every tile twice; the cache would dedupe them.

### 2. A weaker GPU

No second machine was available, so three proxies were used, each at 200k dots:

| | Load (ms) | Pan/zoom p95 / worst frame | Live update |
|---|---|---|---|
| **Retina, DPR 2** (4× the pixels; the bench had always run at 1), WebKit | — | Leaflet 18 / 38 ms · deckgl 18 / 26 · interleaved 18 / 22 · terrain 18 / 27 · buildings 18 / 22 | Leaflet 44 ms · MapLibre 32 ms (one frame, as before) |
| **CPU ×4 slower** (CDP), Chromium | Leaflet 300 · deckgl 73 · MapLibre 87–89 | MapLibre 9.2 / ≤ 17 ms · Leaflet 9.2 / 42 | Leaflet 72 ms · MapLibre 16 ms |
| **Software WebGL** (SwiftShader), Chromium | Leaflet 80 · deckgl 31 · MapLibre 30–33 | Leaflet 17 / 2517 ms · deckgl 17 / 3800 · **MapLibre flat 2290 / 6900 · pitched 3900–5200 / 8800–9300** | about 15 ms everywhere |

- **Retina and a slow CPU cost the MapLibre variants nothing visible.** They
  stay at the display's frame rate. The shipping Leaflet, with its DOM icons,
  is the one that slows (38–42 ms worst frames, 300 ms load).
- **With no GPU, MapLibre is unusable.** It redraws its whole WebGL scene on
  every gesture frame, which costs about 2 s per frame in software, even flat.
  So the cost is not the pitch or the terrain, only the absence of a GPU.
  Leaflet pans by CSS transform, so it only stalls now and then.
  - Where that happens: a VM, remote desktop, or a blocklisted driver, i.e. the
    Linux build on WebKitGTK. Never on a Mac: WKWebView always has Metal.
  - **Mitigation, for phase 2:** hardware WebGL2 is a stated requirement. At
    start-up the map reads the renderer (`WEBGL_debug_renderer_info`). If it
    names SwiftShader, llvmpipe or "Software", it says so in the status bar
    rather than leaving the map to stutter without explanation.
- **Still open:** a real integrated GPU. The proxies bound the result from both
  sides (an M4 Max, and no GPU at all) but are not that machine.

### 3. Occlusion, checked visually and by pixels

`npm run bench:checks` opens `/bench/occlusion` (`src/bench/OcclusionProbe.tsx`).

- **Camera:** placed explicitly with `calculateCameraOptionsFromTo`.
- **Probe pair:** from the rendered surface, the page computes one aircraft
  whose line of sight a summit or tower blocks, and one at the same altitude
  whose line is clear (`src/bench/occlusion.ts`, tested on synthetic walls).
- **Measurement:** it shows each aircraft in turn and counts the pixels it
  changes in a screenshot.
- **Scenes:**
  - *terrain*: Mount Washington, inside the Terrarium fixture, 15 km out;
  - *buildings*: the tallest tower in the Montréal fixture, on terrain.

| Scene, mode | Hidden aircraft (px changed) | Visible twin (px) | Line-of-sight margins |
|---|---:|---:|---|
| terrain, interleaved | **0** | 210 | blocked by 117 m, clear by 107 m |
| terrain, overlaid | 206 | 210 | same |
| buildings, interleaved | **3** | 317 | blocked by 97 m, clear by 14 m |
| buildings, overlaid | 316 | 314 | same |

Identical in WebKit and Chromium.

- **Interleaved hides exactly what geometry says it should.** It holds for
  terrain and for extrusions, through the shared depth buffer.
- **Overlaid paints an aircraft that is behind a tower onto the tower's
  face.** The screenshots show it plainly. So **the port must be
  interleaved**, and it pays the one frame of live latency measured earlier.
- **Lesson:** MapLibre's default `maxPitch` (60°) silently clamps
  `calculateCameraOptionsFromTo`. The first run's camera sat 9 km higher than
  asked, and no aircraft could be hidden. The probe sets `maxPitch: 85`. The
  port should too, if low "approach" views are wanted.

### 4. deck.gl 9.4.1 on MapLibre 6.17: `map.transform`

The same probe with the shim (`exposeTransform`) off:

| Without the shim | Overlaid | Interleaved |
|---|---|---|
| flat | ✅ draws | ❌ `transform.height` on every frame, nothing drawn |
| terrain | ❌ `transform.elevation` in `addControl` | ❌ same |

With the shim, all four cases draw, in both engines.

- **Wider than first noted.** `getViewport` reads `map.transform.height` for
  interleaved rendering whether or not terrain is on. Only an overlaid, flat map
  works unshimmed.
- **Neither listed fix is available here:**
  - no deck.gl release newer than 9.4.1 could be checked from this session (no
    registry access);
  - pinning MapLibre 5 would mean a dependency change and losing 6.x, which
    CopilotKit's `overrides` entry already points at.
- **Mitigation, for phase 2:**
  - keep the shim, moved to `src/lib/` with its tests, as already planned;
  - keep `deck-compat-canary.test.ts`, which fails once deck.gl stops reading
    `map.transform`, which is when the shim should go;
  - keep `npm run bench:checks`, which shows whether the upgraded pair works
    without the shim.

### Bench changes behind these numbers

- `bench/run.mjs`: `--net`, `--gpu software`, `--dpr` and `--cpu-throttle`;
  the `idleMs` metric; and a network profile as a row in each table
  (`variant @dsl`).
- `bench/server.mjs`: the build, server and browser setup, shared with
  `bench/checks.mjs`.
- `npm run bench:summary` prints every metric of a result, where the Markdown
  report shows only the primary one.

## What was measured (2026-11-18)

Same harness, data, colours and gesture as MAP_BENCH.md (`npm run bench`), with
3 repetitions (medians). Hardware: Apple M4 Max, WebKit (Tauri's engine on macOS)
and Chromium. Every run finished, and every frame measurement ran at full
refresh rate. Raw output: `bench/results/2026-11-18T19-48-07.*` (gitignored).

| Variant | What it is |
|---|---|
| **leaflet** | the shipping `MapInner`, unmodified. **Since the first run its dots go through `DeckDotsOverlay` (deck.gl)**, which is why it is now 4–6× faster than in MAP_BENCH.md |
| **deckgl** | Leaflet with the bench's minimal deck.gl overlay (no tooltips, labels or other app layers) |
| **openlayers** | OL 10.11 `WebGLVectorLayer`, one `Feature` per point (the first run's variant) |
| **openlayers-noindex** | same, with `VectorSource({ useSpatialIndex: false })` |
| **openlayers-binned** | one `MultiPoint` feature per 1000 ft altitude bin (`src/bench/ol-binned.ts`) |
| **openlayers-deckgl** | OL as the map, data drawn by deck.gl inside a custom OL `Layer` (`src/bench/deck-ol-view.ts`). Same deck layers as **deckgl** |
| **cesium** | Cesium 1.147 3D globe, `PointPrimitiveCollection` / `PolylineCollection`, positions **at their true altitude**, with no Ion, no imagery and ellipsoid terrain |

No variant loads basemap tiles (the driver blocks the network), so these
numbers are about drawing aircraft data.

### Data load, dots: `setData` until rendered (ms)

| | 10k | 50k | 200k | 1M |
|---|---:|---:|---:|---:|
| WebKit leaflet (shipping) | 5 | 13 | 40 | 187 |
| WebKit deckgl | 30 | 28 | 25 | **52** |
| WebKit openlayers | 32 | 87 | 313 | 2150 |
| WebKit openlayers-noindex | 32 | 83 | 307 | 2062 |
| WebKit openlayers-binned | 33 | 31 | 47 | 151 |
| WebKit openlayers-deckgl | 30 | 28 | 25 | **52** |
| WebKit cesium | 25 | 32 | 71 | 383 |
| Chromium leaflet (shipping) | 12 | 22 | 73 | 280 |
| Chromium deckgl | 26 | 27 | 31 | **48** |
| Chromium openlayers | 48 | 128 | 448 | 2257 |
| Chromium openlayers-binned | 13 | 33 | 59 | 199 |
| Chromium openlayers-deckgl | 24 | 21 | 27 | **49** |
| Chromium cesium | 21 | 40 | 112 | 523 |

Lines at 1M (WebKit / Chromium): deck.gl variants 26 / 30 ms, Leaflet 119 / 196,
OpenLayers (any variant) 310–317 / 304–307, Cesium 334 / 445.

### JS heap after GC, Chromium (MB)

| | dots 200k | dots 1M | lines 1M |
|---|---:|---:|---:|
| leaflet (shipping) | 70 | 98 | 233 |
| deckgl | 34 | 79 | 131 |
| openlayers | 386 | **1797** | 207 |
| openlayers-noindex | 374 | 1687 | 206 |
| openlayers-binned | 54 | 155 | 207 |
| openlayers-deckgl | 34 | 79 | 131 |
| cesium | 177 | 696 | 583 |

GPU memory is not included. Cesium also holds its globe tiles, and every
variant holds its vertex buffers.

### Pan/zoom and live

| Dots | worst frame 200k (WebKit / Chromium) | worst frame 1M | live p95 / worst (WebKit) | live update cost (WebKit / Chromium) |
|---|---:|---:|---:|---:|
| leaflet (shipping) | 23 / 25 ms | 38 / 41 | 34 / 125 | 28 / 33 ms |
| deckgl | 21 / 33 | 38 / 34 | 18 / 20 | 16 / 8 |
| openlayers | 98 / 59 | **328 / 118** | 19 / 114 | 85 / 107 |
| openlayers-noindex | 112 / 52 | 319 / 126 | 19 / 152 | 124 / 125 |
| openlayers-binned | 23 / 34 | 61 / 59 | 18 / 34 | 32 / 23 |
| openlayers-deckgl | 20 / 35 | **19 / 33** | 18 / 21 | 16 / 8 |
| cesium | 27 / 10 | 37 / 10 | 18 / 33 | 22 / 21 |

Chromium runs at 120 Hz, so a 33 ms worst frame there is about four frames.
Cesium's flat 10 ms in Chromium comes from its own render loop, which runs
every frame and spreads the work out. Settle times after a gesture are 4–33 ms
for every variant, so none of them freezes the way the old Leaflet dots did.
Cesium settles in a constant 33 ms (WebKit) or 16 ms (Chromium) because it
redraws continuously.

The shipping app's live p95 in WebKit (34 ms) is the slowest of the dots
variants. That cost is its DOM aircraft icons and labels, which the bench
variants don't draw, not the dots.

## OpenLayers, second test: what changed the verdict

1. **The R-tree was not the cost.** `useSpatialIndex: false` saves 3–7% on
   load. Live updates are even slower without it: 124 vs 85 ms per
   update in WebKit.
2. **The per-point `Feature` objects were the whole cost.** Binning into 50
   `MultiPoint`s makes OpenLayers 14× faster to load at 1M points (2150 → 151 ms
   in WebKit). It uses 12× less heap (1.8 GB → 155 MB) and cuts the worst pan
   frame 5× (328 → 61 ms). That puts it level with the shipping app. It is
   still 3× slower than deck.gl and uses twice the heap.
   The catch: a `MultiPoint` is one feature, so OL's hit detection returns the
   bin, not the aircraft. Hover tooltips and click-to-select on a dot would need
   a separate lookup, like the canvas variant in MAP_BENCH.md.
3. **With deck.gl drawing the data, the basemap engine doesn't matter.**
   `openlayers-deckgl` matches `deckgl` to within 1 ms and 0 MB on every measure.
   Its worst pan frame at 1M is even lower (19 ms in WebKit), because OL
   batches view changes into one render per frame.

So **OpenLayers is not slow. Its feature model is.** Moving to OL would not cost
performance as long as aircraft are drawn with deck.gl (or binned). Whether to
move is then decided by OL's features, not its speed.

## The candidates

### Leaflet + deck.gl (what ships)

- **Performance:** already at the fastest result on every measure that matters.
- **Gives:** a small, well-understood 2D map. Every app layer exists and is
  tested: the tile cache, H3 density, wind barbs and particles, collision-free
  labels, the area/point picker, range lines, events, the context menu, and fly-to.
- **Lacks:** rotation, pitch, 3D, real projections, and OGC services.
- **Cost:** none.

### OpenLayers

- **Gives:**
  - OGC services (WMS/WMTS/WFS). For example, a weather radar or SIGMET overlay
    from a national met service.
  - Any projection through proj4, map rotation, vector tiles, and mature
    drawing and editing interactions (useful for events-of-interest areas).
- **Performance:** fine if aircraft are drawn by deck.gl (as above). Very poor
  with one `Feature` per point. Lines are about 2.5× Leaflet's load cost at
  1M (310 vs 119 ms), still well under the 24 h view's needs.
- **Porting cost:** every Leaflet-specific layer in `MapInner.tsx` (about 12:
  `CachedBasemap`, `DensityLayer`, `WeatherBarbsLayer`, `WindParticlesLayer`,
  `TrackLabelsLayer`, `MapPickerLayer`, `RangeLinesLayer`, `EventMarkersLayer`,
  context menu, fly-to, attribution, the DivIcon aircraft) has to be rewritten.
  The tile cache needs a custom `tileLoadFunction`. The deck.gl bridge exists now
  (`deck-ol-view.ts` plus a 15-line layer).
  The pure logic in `src/lib/` carries over: colours, `h3-density`,
  `label-layout`, the wind maths, `subsample`, `deck-dots`.
- **Bundle:** `ol` is tree-shaken, so only what's imported ships. Not
  measured here.
- **Fit:** good, but nothing in the app today needs what it adds. The first
  real trigger would be an OGC weather source.

### Cesium.js

- **Gives:**
  - The only real step change in what the map can show: a **3D view**.
    Trails at their real altitude, climb and descent profiles, approach and
    holding stacks, and range rings against terrain.
  - glTF aircraft models oriented by heading, a time-dynamic `Clock` that
    fits the scenario playback naturally, and a camera that can follow an aircraft.
- **Performance:**
  - Smooth while moving: worst frame 37 ms in WebKit and 10 ms in Chromium at 1M.
  - Heavy to load: 383 / 523 ms and 696 MB at 1M dots, because Cesium creates a
    JS object per `PointPrimitive`.
  - At the real 24 h view (about 200k points, MAP_BENCH.md) it is 71 / 112 ms and
    177 MB. That's acceptable, but it is 2–3× the shipping app.
  - deck.gl has no maintained Cesium integration, so the deck.gl advantage
    doesn't carry over. The faster routes are a custom `Primitive` with typed
    vertex buffers, or 3D Tiles point clouds, both of which are more work.
- **Bundle:** `Cesium.js` is 6.1 MB (1.8 MB gzipped), plus 7.4 MB of Workers,
  Assets, ThirdParty and Widgets, which are fetched at runtime. That's
  irrelevant to a local Tauri app's network, but it does count toward app size.
- **Build:** it **cannot go through the app's webpack build**. Next's minifier
  corrupts a template literal in Cesium's ESM build ("Octal escape sequences
  are not allowed in template strings", seen only as a `ChunkLoadError`).
  The bench loads the prebuilt `Cesium.js` as a script with `CESIUM_BASE_URL`
  set first, and also needs `Widgets/widgets.css`, otherwise the canvas stays
  300×150. In the app, these files would ship as static assets.
- **Local-first fit:**
  - The defaults assume **Cesium Ion** (a cloud token) for imagery and terrain.
  - Without Ion, the imagery works through `UrlTemplateImageryProvider` (Esri or
    OSM, as now) and the globe is a smooth ellipsoid.
  - Real terrain without Ion needs a self-hosted quantized-mesh server.
  - The IndexedDB tile cache would need a custom `ImageryProvider` wrapper.
- **CSP (`src-tauri/tauri.conf.json`):** scripts and workers would come from
  `'self'`, which the current policy already allows. Imagery is fetched, so tile
  hosts need `connect-src` as well as `img-src`, which matches what the tile
  cache already requires. glTF models with Draco or KTX2 compression would add
  `'wasm-unsafe-eval'`. These are untested in Tauri; the bench ran in plain
  browsers.
- **Porting cost:**
  - The highest of the three. Nothing Leaflet-shaped transfers.
  - Labels become `LabelCollection` (the screen-space collision layout in
    `label-layout.ts` would need reprojection every frame).
  - Density becomes ground primitives, wind particles a custom primitive or
    post-process, and the picker a `ScreenSpaceEventHandler` with globe picking.
  - Tests: as with `MapInner.tsx`, the viewer itself is untestable in jsdom.

### MapLibre + deck.gl (measured in a second run)

MapLibre has pitch, rotation and a globe, and deck.gl integrates with it
officially (`@deck.gl/mapbox` `MapboxOverlay`). Two variants were added, both
drawing the **same deck.gl layers** as **deckgl** (`buildLayers` in
`DeckGlLeaflet.tsx`):

| Variant | What it is |
|---|---|
| **maplibre-deckgl** | MapLibre 6.17 map, flat, deck.gl via `MapboxOverlay` (overlaid, not interleaved) |
| **maplibre-deckgl-3d** | same, pitched 60°, positions carry **altitude as z** (feet → m, unknown altitude on the ground; `src/bench/deck-positions.ts`) |

Run `bench/results/2026-11-18T21-20-56.*`, 3 repetitions, with leaflet, deckgl,
maplibre (its own GeoJSON path, from MAP_BENCH.md) and openlayers-deckgl as
references. No run failed. 31 of 648 runs were flagged at a 30 Hz idle refresh
(the multi-monitor trap): 30 load runs and 1 pan/zoom run. Load time barely
depends on refresh rate, and the frame numbers below agree with the first run.

**Load, dots, `setData` until rendered (ms):**

| | 10k | 50k | 200k | 1M |
|---|---:|---:|---:|---:|
| WebKit deckgl | 30 | 29 | 40 | 53 |
| WebKit openlayers-deckgl | 30 | 28 | 40 | 46 |
| WebKit **maplibre-deckgl** | 30 | 28 | 40 | **43** |
| WebKit **maplibre-deckgl-3d** | 30 | 29 | 40 | **55** |
| WebKit maplibre (GeoJSON) | 82 | 231 | 826 | 4171 |
| Chromium deckgl | 24 | 29 | 31 | 47 |
| Chromium **maplibre-deckgl** | 28 | 28 | 26 | **48** |
| Chromium **maplibre-deckgl-3d** | 24 | 26 | 29 | **51** |
| Chromium maplibre (GeoJSON) | 80 | 246 | 850 | 4639 |

Lines are the same picture: at 1M, 29–30 ms in WebKit for every deck.gl variant,
against 699 ms for MapLibre's GeoJSON path.

**JS heap after GC, Chromium (MB):**

| | dots 200k | dots 1M | lines 200k | lines 1M |
|---|---:|---:|---:|---:|
| deckgl | 34 | 79 | 42 | 131 |
| maplibre-deckgl | 45 | 82 | 51 | 134 |
| maplibre-deckgl-3d | 46 | 86 | 52 | 138 |
| maplibre (GeoJSON) | 127 | 506 | 60 | 220 |

MapLibre itself costs about 10 MB more than Leaflet as a base. The z
coordinate costs 4 bytes per point (3–4 MB at 1M).

**Pan/zoom and live:**
- WebKit pan/zoom: every variant holds the frame rate, at 431–458 frames and
  p95 17–19 ms. The worst frame at 1M is 25 ms dots and 32 ms lines for
  maplibre-deckgl, 29 and 33 ms pitched, and 33 and 34 ms for deckgl.
- Chromium pan/zoom: MapLibre's worst frame is 10–25 ms against about 33 ms
  for the Leaflet and OL bridges. Its 1M lines peak at 42 ms flat and 52 ms
  pitched, the only result where 3D costs anything visible.
- Live (25k, an update every second): deck.gl applies the update in 15–16 ms
  in WebKit and 7–8 ms in Chromium, the same as deckgl, with p95 18 ms and a
  worst frame of 20–24 ms. MapLibre's own GeoJSON path takes 149 ms per update.

**What it means for the app:**
- **Performance is a non-issue.** MapLibre + deck.gl is level with Leaflet +
  deck.gl everywhere, flat or pitched. Altitude in 3D is free at the data layer.
- **It is the cheap 3D.** It gives a pitched, rotatable view with trails at
  their true height, using the same `deck-dots` / binary-attribute code the app
  already ships. Altitude is an attribute size of 3 instead of 2.
- **Unlike Cesium,** it has no build workarounds (only the worker URL, already
  solved for the bench), no Ion, and a bundle of about 1.6 MB
  (≈ 440 KB gzipped: `maplibre-gl.mjs` plus its worker), against Cesium's 13 MB.
- **What it does not give:** a true ellipsoid with terrain occlusion. Its globe
  projection is good enough for a receiver's ~250 NM range. Vertical
  exaggeration and ground "curtains" under the trails are deck.gl options
  (`PathLayer` with z scaling, `ColumnLayer`), not engine features.
- **Porting cost:** high, as for OpenLayers. Raster tiles and the IndexedDB
  tile cache move to a MapLibre style plus a `addProtocol` handler. Leaflet
  panes, popups and the context menu become MapLibre markers and events. The
  data layers on deck.gl move almost unchanged. Labels and screen-space layout
  need rework once the map is pitched, because screen projection is no longer
  affine. With terrain, deck.gl 9.4.1 also needs a small shim on MapLibre 6
  (see *Measured: interleaved, 3D terrain and buildings*).
- **CSP:** `worker-src blob:` is not needed when the worker is served as a
  file, as in the bench. Both cases need WebGL, which deck.gl already requires.

## Target layers: terrain, ICAO charts, weather, sea, 3D buildings

The layers wanted next are terrain, ICAO/OACI aeronautical charts, weather,
sea/ocean and 3D buildings. This section maps each to open sources, engine
support and a cache policy. It is from documentation, not measured. Every
link was checked on 2026-11-18. Licences and access rules change, so check
them again before building on a source.

### Sources

**Basemap (OpenStreetMap, ODbL: "© OpenStreetMap contributors" must be shown)**
- [OpenFreeMap](https://openfreemap.org/): hosted vector tiles, no key. Its
  [Liberty style](https://tiles.openfreemap.org/styles/liberty) already draws
  3D buildings. Online only.
- [Protomaps](https://docs.protomaps.com/): PMTiles, a single file that works
  offline. [Daily worldwide builds](https://maps.protomaps.com/builds/) can be
  cut to a region with [`pmtiles extract`](https://github.com/protomaps/go-pmtiles).
  [Styles](https://github.com/protomaps/basemaps) come in light, dark and
  grayscale, with [fonts and icons](https://github.com/protomaps/basemaps-assets)
  for offline use.
- The [OSM tile servers' usage policy](https://operations.osmfoundation.org/policies/tiles/)
  forbids downloading ahead, so the current raster OSM layer may only cache
  viewed tiles.

**Terrain and elevation**
- [Terrarium tiles on AWS](https://registry.opendata.aws/terrain-tiles/), no
  key, include sea depth:
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
  ([encoding](https://github.com/tilezen/joerd/blob/master/docs/formats.md)).
- [Copernicus DEM GLO-30/90](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)
  ([AWS mirror](https://registry.opendata.aws/copernicus-dem/)), to build your own
  tiles. Cesium without Ion needs this route:
  [cesium-terrain-builder](https://github.com/geo-data/cesium-terrain-builder).

**Aeronautical (ICAO / OACI)**
- [OpenAIP](https://www.openaip.net/) ([API](https://docs.openaip.net/)):
  airspaces, airfields, navaids. It needs a free key, and its licence is
  **non-commercial** (CC BY-NC-SA).
- The OACI 1:500,000 chart (IGN / [SIA](https://www.sia.aviation-civile.gouv.fr/))
  is listed in the [IGN catalogue](https://cartes.gouv.fr/decouvrir/rechercher-une-donnee/).
  **Access is restricted**, so check its conditions first.
- Airspaces are best drawn as deck.gl volumes from floor to ceiling, with
  aircraft at their real altitude. That needs a pitched view.

**Weather**
- [AviationWeather.gov API](https://aviationweather.gov/data/api/): METAR,
  TAF, SIGMET, no key.
- [DWD open data](https://opendata.dwd.de/): radar and models over WMS, no key
  (`https://maps.dwd.de/geoserver/ows?service=WMS&request=GetCapabilities`).
- [Météo-France API portal](https://portail-api.meteofrance.fr/web/) (free key)
  and [meteo.data.gouv.fr](https://meteo.data.gouv.fr/).
- [EUMETSAT View](https://view.eumetsat.int/): satellite imagery over WMS.
- [Open-Meteo](https://open-meteo.com/): forecast grids, free tier
  non-commercial. [RainViewer](https://www.rainviewer.com/api.html): radar, free
  tier reduced.
- Gridded data (wind and the like) stays on deck.gl and the existing weather
  layers, whatever the engine.

**Sea and ocean**
- [OpenSeaMap](https://map.openseamap.org/): seamarks as a transparent raster
  overlay, CC BY-SA, `https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png`.
- [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry): European
  waters (`https://ows.emodnet-bathymetry.eu/wms?service=WMS&request=GetCapabilities`).
- [GEBCO](https://www.gebco.net/): worldwide depth over
  [WMS](https://www.gebco.net/data-products/gebco-web-services/web-map-service).
- The Terrarium tiles above already include sea depth, so one relief layer
  can cover land and sea.

**3D buildings**
- OSM buildings with heights are already in the OpenFreeMap and Protomaps
  tiles.
- [IGN BD TOPO](https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_BD-TOPO):
  France, measured heights, Etalab licence.
- [Overture Maps buildings](https://docs.overturemaps.org/guides/buildings/):
  worldwide ([download tool](https://github.com/OvertureMaps/overturemaps-py)).
- Photorealistic tiles (Google, Cesium OSM Buildings) are **not open**: they
  need a key or an Ion token and restrict offline use.

### Engine support

| Goal | Leaflet | OpenLayers | MapLibre + deck.gl | Cesium |
|---|---|---|---|---|
| Raster and WMS overlays (charts, weather, sea) | ✅ (`L.tileLayer.wms` built in) | ✅✅ best OGC support: WMS time steps, WMTS discovery, [OGC API Tiles](https://openlayers.org/en/latest/apidoc/module-ol_source_OGCMapTile-OGCMapTile.html), other projections | ✅ URL templates (`{bbox-epsg-3857}` for WMS) | ✅ imagery providers |
| Shaded relief | pre-made raster only | ✅ computed live | ✅✅ built in: [`hillshade`](https://maplibre.org/maplibre-style-spec/layers/) | ✅ |
| 3D terrain | ❌ | ❌ | ✅ [built in](https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/), keyless | ✅✅ true globe, but terrain self-hosted |
| 3D buildings | ~ old 2.5D plugin | ❌ | ✅ [`fill-extrusion`](https://maplibre.org/maplibre-gl-js/docs/examples/display-buildings-in-3d/), also on terrain | ✅✅ via 3D Tiles (best data not open) |
| Airspace volumes with aircraft | ❌ | ❌ | ✅ deck.gl, already benchmarked | ✅ |
| Offline (PMTiles) | ~ [protomaps-leaflet](https://github.com/protomaps/protomaps-leaflet) | ✅ ol-pmtiles | ✅✅ [`pmtiles`](https://github.com/protomaps/PMTiles) + `addProtocol` | custom provider |

OpenLayers falls out for this goal because it has no 3D. Cesium only wins for
photorealistic cities, whose best data is not open. MapLibre + deck.gl covers
the whole list with open, keyless data that can work offline.

**Points specific to ADS-B:**
- **Scale.** Buildings appear from about zoom 14, while a receiver's range of
  ~250 NM sits at zoom 7–9. They help mainly around airports: taxi, take-off,
  approach.
- **Occlusion.** In deck.gl's *overlaid* mode
  ([`MapboxOverlay`](https://deck.gl/docs/api-reference/mapbox/mapbox-overlay)
  `interleaved: false`) an aircraft behind a hill or a building is still drawn
  in front of it. Terrain and buildings need `interleaved: true` to share
  MapLibre's depth buffer. Measured below.
- **Height reference.** ADS-B altitude is pressure altitude (referenced to
  1013.25 hPa). Terrain elevation is above sea level, and building heights are
  above the ground. Near an airport the difference shows, so a correct picture
  needs QNH, which the METAR layer provides.

### Measured: interleaved, 3D terrain and buildings (2026-11-19)

Same harness as above, run `bench/results/2026-11-18T23-12-45.*`, 3
repetitions, WebKit and Chromium. 900 results, none failed, and none flagged
for a throttled display. Every variant is pitched 60° with aircraft at their
altitude:

| Variant | What it adds |
|---|---|
| **maplibre-deckgl-3d** | reference: deck.gl *overlaid*, nothing else (as earlier) |
| **maplibre-deckgl-3d-il** | deck.gl *interleaved* (shares MapLibre's depth buffer) |
| **maplibre-deckgl-terrain** | + 3D terrain and hillshade, receiver-range view (zoom 7) |
| **maplibre-deckgl-city** | + 3D terrain, downtown Montréal at zoom 15 |
| **maplibre-deckgl-buildings** | + OSM 3D buildings, same city view: the densest case near the bench centre |

Real tiles, served locally from `bench/fixtures/` (`npm run bench:fixtures`):
- 345 AWS Terrarium elevation tiles (22.5 MB), z0–9 over 10° × 7°;
- 157 OSM vector tiles (15.9 MB) from the Protomaps build of 2026-11-18,
  z0–15 over downtown. About a third of the buildings there carry a `height`;
  the others get 6 m.

The page waits for MapLibre's first `idle` (tiles and terrain loaded) before
measuring, so **load** times the aircraft data alone. **Pan/zoom** includes the
tiles each gesture brings in, from local disk.

**Load, 1M points, `setData` until rendered (ms):**

| | WebKit dots | WebKit lines | Chromium dots | Chromium lines |
|---|---:|---:|---:|---:|
| 3d (overlaid) | 50 | 28 | 49 | 33 |
| 3d-il | 50 | 32 | 51 | 35 |
| terrain | 55 | 31 | 52 | 34 |
| city | 53 | 33 | 53 | 35 |
| buildings | 57 | 33 | 52 | 34 |

**Pan/zoom, 1M points:** in WebKit, every variant keeps p95 at 18 ms (the
60 Hz frame). The worst frame for dots is 26 ms overlaid, 26 interleaved,
29 with terrain, 23 city and 25 with buildings; for lines, 31–34 ms across all
five. In Chromium (about 100 Hz here), p95 stays at 9–10 ms, and the worst
frame at 1M lines is 35–50 ms in every variant, the overlaid reference included.
Settle time after a gesture is one frame everywhere.

**Live (25k, an update every 500 ms):** frame p95 is unchanged (18 ms WebKit,
9–10 ms Chromium). The time from an update to its painted frame doubles with
interleaving, from 15 to 32 ms in WebKit and from 8–9 to 15 ms in Chromium,
and terrain or buildings add nothing on top. That is **one frame of latency, not
work**: interleaved, deck.gl draws during MapLibre's next render pass instead of
on its own canvas straight away.

**Heap after GC, Chromium (MB):**

| | dots 10k | dots 1M | lines 10k | lines 1M |
|---|---:|---:|---:|---:|
| 3d-il | 27 | 88 | 31 | 140 |
| terrain | 49 | 106 | 53 | 156 |
| city | 27 | 90 | 33 | 142 |
| buildings | 46 | 99 | 43 | 150 |

Terrain at receiver range costs about 16–22 MB, the DEM tiles in view. Over the
city it is cheaper, because only a few overzoomed DEM tiles are in view.
Buildings add 8–19 MB.

**What it means:**
- **Interleaving, terrain and 3D buildings cost almost nothing on this
  machine.** Load grows by at most 7 ms at 1M points, frame rate does not move,
  and memory grows by about 10–20 MB. The one visible cost is a single frame of
  latency on live updates.
- **Compatibility:** with terrain on, deck.gl 9.4.1 (latest stable) crashes on
  MapLibre 6. It reads `map.transform`, which MapLibre 6 moved to
  `map._camera.transform`. The bench re-exposes it (`src/bench/maplibre-compat.ts`,
  five lines). A port would need the same shim, or MapLibre 5, until deck.gl
  catches up.
- **Limits of this run:**
  - Apple M4 Max: a weaker GPU will feel terrain and buildings sooner.
  - Tiles come from local disk; network latency during a gesture is not
    measured.
  - At the zoom-15 city view the camera is below cruising aircraft, so few are
    on screen. deck.gl still processes every point each frame, so the cost
    counts, but the scene is not a realistic approach.
  - Occlusion itself, a hill or building hiding an aircraft, was not checked
    visually. (Checked since, in *Phase 1 results*.)

### Cache policy

The existing cache (`src/lib/tile-cache/`, IndexedDB) exists for offline use
(decided 2026-11-08). It downloads ahead around the receiver, reports coverage
per zoom and stretches lower-zoom tiles when a closer one is missing. How often
a layer changes, and how harmful an outdated copy is, decide its policy:

| Layer | Changes | Offline cache? | Form |
|---|---|---|---|
| Vector basemap | months | ✅ | PMTiles extract around the receiver (`pmtiles extract --bbox --maxzoom`) |
| Terrain / relief | never | ✅✅ | PMTiles (raster), download once, keep forever |
| Sea depth | years | ✅ | cache viewed tiles, or build a PMTiles file |
| 3D buildings | months | ✅, large | PMTiles at zoom 14–15, **around airports only** |
| OpenSeaMap seamarks | weeks | ✅ | existing tile cache, unchanged |
| Airspaces (OpenAIP) | every 28-day AIRAC cycle | ✅, **labelled by cycle** | one GeoJSON per cycle, cycle date shown, warning once expired: stale airspace data is a safety issue |
| OACI 1:500,000 chart | yearly edition | only if the licence allows | — |
| Radar / satellite | 5–15 min | ❌ offline | memory only, keyed by time step, to pre-load animation frames |
| METAR / TAF | 30–60 min | ❌ | last reading in memory, age always shown |

**PMTiles rather than more of the same cache.** At hundreds of MB, one file on
disk is simpler than an IndexedDB store filled tile by tile. It is complete from
the first launch and easy to see and delete. Coverage becomes "region and zoom
of the installed file". A PMTiles extract is also cut from a file published for
that purpose, so it avoids the usage policies that forbid downloading ahead.

**Reuse after an engine change.** Only `CachedTileLayer.ts` depends on Leaflet.
In MapLibre the cache plugs in through `addProtocol` (e.g. `cached://…`)
returning tile bytes, while `store.ts`, `loadTile.ts` and `prefetch.ts` stay.
MapLibre stretches lower-zoom tiles itself, so `overzoom.ts` is not needed there.
Serving PMTiles from Rust through a Tauri custom protocol would be the "local
tile server" the 2026-11-08 decision was waiting for, and it needs no new CSP
host. Every remote host above, in contrast, must be added to **both** CSP files.

### Suggested path

1. **In Leaflet, no engine change:** OpenAIP airspaces (deck.gl polygons),
   METAR stations, a radar WMS, OpenSeaMap and EMODnet overlays, and a
   pre-made relief raster. This tests which layers are actually used.
2. **If 3D proves worth it, port to MapLibre + deck.gl:** 3D terrain from
   Terrarium tiles, airspace volumes, buildings near airports, and offline
   basemap and relief as PMTiles.
3. **Before porting:** done in phase 1 (*Phase 1 results*): network tiles
   during gestures, GPU proxies, occlusion checked visually and by pixels, and
   the `map.transform` incompatibility mapped and pinned by a canary test. Only
   a real integrated GPU remains unmeasured.
4. **Cesium** only if a true globe becomes a requirement.

## Engine as a runtime choice

Technically straightforward:

1. A setting `adsb-map-engine` (`useLocalStorage`, as with `adsb-map-theme` and
   `adsb-trajectory-style`) with a control in Settings.
2. `src/components/Map.tsx` is already the only seam. It is one `Props` interface
   and one `dynamic(() => import("./MapInner"), { ssr: false })`. It would pick
   the engine's module there, so an engine's code is downloaded only when
   chosen.
3. Each engine declares **capability flags** (density, weather, picker, labels,
   and so on). `LeftPanel` and the chat tools hide or refuse what the active
   engine lacks, instead of failing silently.
4. Shared, engine-free code stays in `src/lib/`. The data path (aircraft →
   typed arrays → deck.gl layers) is shared by any engine with a deck.gl bridge,
   which means Leaflet, OpenLayers and MapLibre, but not Cesium.

The cost is not the switch, it is **parity**. Every map feature added afterwards
must be written once per engine, or flagged as missing. `MapInner.tsx` is 1217
lines today. Two engines means two of those, each with its own untestable
surface.

## Conclusions

1. **Keep Leaflet + deck.gl as the default.** It is already at the fastest
   result on everything measured, and nothing in the app needs what the others
   add.
2. **OpenLayers was misjudged.** Its slowness was entirely one `Feature` per point.
   With deck.gl it matches Leaflet exactly. If OGC weather sources or proper
   area editing become wanted, OL is a viable *replacement* for Leaflet (not
   a second engine), and the deck.gl bridge is proven.
3. **Cesium is the only candidate that adds something visible**, a true 3D view,
   and it carries the highest cost: bundle, build workarounds, Ion assumptions
   and a full layer rewrite. If 3D is wanted, it is best as an optional **3D
   view with a limited scope**:
   - live aircraft and trails at altitude, history, selection and fly-to;
   - capability flags for everything else;
   - a custom vertex-buffer `Primitive` once the ~200k history view matters.
4. **If 3D is wanted, MapLibre + deck.gl is the better first step than Cesium.**
   Measured level with the shipping stack, flat and pitched with altitude, at
   about an eighth of Cesium's download and with the deck.gl data layers
   reused. Cesium remains the answer only if a true globe with terrain matters.
   As with OL, MapLibre is better as a *replacement* for Leaflet than as a
   second engine, because of the parity cost above. A pitched view is a camera
   setting there, not a second engine.
5. **The wanted layers point the same way.** Terrain, ICAO charts, weather,
   sea and 3D buildings are covered by MapLibre + deck.gl with open, keyless
   data that can work offline (see *Target layers*). Only 3D terrain, buildings
   and airspace volumes need the engine change. The overlays can start in
   Leaflet now. Interleaved deck.gl with 3D terrain and OSM buildings was
   measured at no meaningful cost on this machine, with one frame of extra
   latency on live updates.
