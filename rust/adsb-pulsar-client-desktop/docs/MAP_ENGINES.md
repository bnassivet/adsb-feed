# Map engines: Leaflet, OpenLayers, Cesium

Question: should the desktop map move to a "more advanced" engine, OpenLayers
or Cesium.js, and could the engine be a choice next to Leaflet?
This is an analysis. No product code changed.

It follows [MAP_BENCH.md](MAP_BENCH.md) (2026-11-08). That benchmark measured
OpenLayers in its naive form, one `Feature` per point. It found OpenLayers 2×
slower to load than Leaflet and 1.6× heavier. This second test checks
whether that verdict was OpenLayers' fault or the variant's. It also measures
Cesium for the first time.

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

### MapLibre + deck.gl (for comparison, not asked)

MapLibre has pitch, rotation and a globe, and deck.gl integrates with it
officially (`MapboxOverlay`, interleaved). A pitched 2.5D view with trails at
altitude would therefore reuse the existing deck.gl layers almost unchanged.
MAP_BENCH.md measured MapLibre's own GeoJSON path as slow (4 s at 1M), but with
deck.gl drawing the data that path is never used. It is the cheapest way to "see
altitude", short of Cesium's real 3D globe.

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
4. A cheaper middle ground is a **MapLibre + deck.gl** pitched view. Like
   Cesium, it would need a benchmark of its own before any decision.
