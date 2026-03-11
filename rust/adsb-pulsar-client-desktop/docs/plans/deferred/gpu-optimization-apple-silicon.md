# GPU Optimization Analysis & Plan for Apple Silicon M4 Max

*Archived: 2026-03-08 — Analysis complete, implementation deferred*

## Current State Assessment

The Tauri desktop app (Next.js 15 + React 19 + Leaflet) is **already well-optimized** for real-time aircraft tracking. Key existing optimizations:

| Area | Implementation | Status |
|------|---------------|--------|
| Map rendering | `preferCanvas: true` on Leaflet MapContainer | Excellent |
| Dot trajectories | Imperative `DotsLayer` via `useMap()`/`useEffect()` — bypasses React reconciliation | Excellent |
| Bridge throttle | 50k msg/s throttled to ~2 updates/sec (500ms HashMap buffer flush) | Excellent |
| Color caching | `cachedAltitudeToColor()` — 512-entry LRU cache | Excellent |
| Memoization | `useMemo` on orderedTracks, densityGeoJson, altitudeRange, selectedTrack, densityTracks | Strong |
| Event handlers | `useCallback` on handleSelectTrack, handleDeselect, resize handlers | Strong |
| Tauri WebKit | Uses Metal for GPU compositing natively on Apple Silicon | Automatic |

## Identified Bottlenecks

1. **AircraftTable renders all rows to DOM** — no virtualization; 500+ aircraft = 5000+ DOM nodes (11 cells × ~500 rows)
2. **No CSS compositing hints** — browser decides which elements to promote to GPU layers
3. **Full Dashboard re-render every 500ms** — every state update cascades through the entire component tree; components like MetricsBar, AltitudeLegend re-render needlessly
4. **GeoJSON DensityLayer remounts on key change** — react-leaflet's `<GeoJSON>` component ignores `data` prop changes after initial mount, so `MapInner.tsx:173-176` uses a composite `key` string (metric + resolution + feature count + theme + altitude range + tooltip mode) to force React to unmount/remount the entire component on every change. Each remount destroys all hexagon polygons from the Leaflet layer and recreates them from scratch. With hundreds of H3 cells, this means hundreds of `L.Path` objects torn down and rebuilt. **Mitigating factors:** zoom changes are debounced at 300ms (`useMapZoom(300)`) and track updates arrive every 500ms, so remounts happen at most ~2/sec — acceptable in practice. **Fix path (if needed):** replace react-leaflet `<GeoJSON>` with an imperative approach (like `DotsLayer`): create `L.geoJSON` layer once via `useEffect`, then call `.clearLayers()` + `.addData()` on updates instead of remounting.

## Proposed Optimizations

### 1. CSS GPU Layer Promotion

**File:** `src/app/globals.css`

Add `will-change` and `contain` properties to key layout regions:

```css
/* Map container — own compositing layer */
.leaflet-container {
  will-change: transform;
  contain: layout style paint;
}

/* Aircraft table scroll container — independent paint layer */
.aircraft-table-scroll {
  will-change: transform;
  contain: layout style paint;
}

/* Side panels — isolated repaint */
.details-panel, .left-panel, .dbhistory-panel {
  will-change: transform;
  contain: layout style;
}

/* Leaflet tile pane — reinforce GPU compositing */
.leaflet-tile-pane {
  contain: strict;
}
```

**Rationale:** On Apple Silicon, WebKit uses Metal for GPU compositing. `will-change: transform` promotes an element to its own compositing layer (separate GPU texture). `contain: layout style paint` promises the browser that changes inside the element don't affect anything outside, enabling isolated repaint. Reduces CPU-to-GPU synchronization overhead.

**Requires:** Adding CSS class names (`aircraft-table-scroll`, `details-panel`, `left-panel`, `dbhistory-panel`) to component root elements in: `AircraftTable.tsx`, `LeftPanel.tsx`, `AircraftDetailsPanel.tsx`, `DBHistoryPanel.tsx`.

### 2. Table Virtualization

**Files:** `src/components/AircraftTable.tsx`, `package.json`

Replace `sorted.map(...)` with `@tanstack/react-virtual` (~3KB gzipped):

- Single flat virtual list containing all 4 sections (Live, History, DB History, Imported) with section headers as special rows
- Fixed row height: ~32px (current `py-1.5` + border)
- Overscan: 10 rows above/below viewport
- Result: ~50 visible rows (~550 DOM nodes) instead of ~500 rows (~6000 DOM nodes)

### 3. React.memo on Stable Components

Wrap components with `React.memo` to skip re-renders when props haven't changed:

| Component | Why it helps |
|-----------|-------------|
| `MetricsBar` | Only changes when metrics update (separate Tauri event from tracks) |
| `AltitudeLegend` | Only changes on theme toggle |
| `MapTileToggle` | Only changes on theme toggle |
| `AircraftTable` | Shallow comparison; skips re-render when tracks/selection unchanged |

### Files to Modify

| File | Change |
|------|--------|
| `src/app/globals.css` | Add GPU compositing CSS rules |
| `src/components/AircraftTable.tsx` | Virtualization + `React.memo` + class name |
| `src/components/MetricsBar.tsx` | `React.memo` wrapper |
| `src/components/AltitudeLegend.tsx` | `React.memo` wrapper |
| `src/components/MapTileToggle.tsx` | `React.memo` wrapper |
| `src/components/LeftPanel.tsx` | Add class name |
| `src/components/AircraftDetailsPanel.tsx` | Add class name |
| `src/components/DBHistoryPanel.tsx` | Add class name |
| `package.json` | Add `@tanstack/react-virtual` |

## Explicitly Rejected Approaches

- **WebGL map renderer (Mapbox GL)**: Complete map library swap, breaks all existing Leaflet features
- **Worker-based H3 density**: 500ms throttle already limits computation frequency; Worker IPC serialization overhead negates gains
- **React context splitting**: Major Dashboard refactoring for marginal gain at 2 updates/sec

## Verification Plan

1. `npx next build` succeeds
2. `npm test` — all ~198 Vitest tests pass
3. `cargo test --workspace` — unchanged
4. `npx next lint` passes
5. `npm run tauri dev` — visual verification of smooth scrolling and panel resizing
6. WebKit Inspector > Timelines > Rendering — verify GPU compositing layers
