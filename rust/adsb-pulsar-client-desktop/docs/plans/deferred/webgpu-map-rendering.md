# Fix 6: GPU-Accelerated Map Rendering via deck.gl + WebGPU

*Created: 2026-03-30 — Analysis complete, implementation deferred*

## Context

Fixes 1-5 are complete (split version counters, virtualized table, memoized LatLng + split DotsLayer, binary IPC, progressive loading). The remaining bottleneck is map rendering at extreme scale (>1M positions). The current DotsLayer creates individual `L.circleMarker()` per position — at 100 tracks x 10K positions, that's 1M Leaflet CircleMarker instances managed by the canvas renderer.

**Goal:** Replace Leaflet's native canvas rendering for heavy track types with GPU-accelerated rendering via deck.gl, using WebGPU where available (macOS Tahoe 26+ / M4 Macs) with automatic WebGL2 fallback.

## Reflection: WebGPU vs WebGL2

User prefers WebGPU to leverage Apple Silicon M4 GPU. Research findings:

| Factor | WebGPU | WebGL2 |
|--------|--------|--------|
| **deck.gl support** | Experimental (v9, via luma.gl adapter) | Production-ready, mature |
| **Tauri WKWebView** | macOS Tahoe 26+ only | Universal |
| **Performance at 1M pts** | Marginal gain over WebGL2 | Already 60fps on M4 |
| **Where WebGPU wins** | >10M points, compute shaders, multi-draw-call | — |
| **Risk** | Experimental API surface, may have rendering bugs | None |

**Decision:** Use deck.gl v9 with **WebGPU as the preferred backend** and **automatic WebGL2 fallback**. deck.gl abstracts the GPU backend behind luma.gl — switching is a `deviceProps.type` config. This gives the user WebGPU on their M4 Mac while maintaining compatibility. The code structure is identical regardless of backend, so when deck.gl v9.1+ stabilizes WebGPU, we get the improvements for free.

## Architecture

### What changes

| Layer | Before | After |
|-------|--------|-------|
| History dots | `DotsLayer` (L.circleMarker x N) | `DeckGLOverlay` ScatterplotLayer |
| DB History dots | `DotsLayer` (L.circleMarker x N) | `DeckGLOverlay` ScatterplotLayer |
| Imported dots | `DotsLayer` (L.circleMarker x N) | `DeckGLOverlay` ScatterplotLayer |
| History polylines | react-leaflet `<Polyline>` x N | `DeckGLOverlay` PathLayer |
| DB History polylines | react-leaflet `<Polyline>` x N | `DeckGLOverlay` PathLayer |
| Imported polylines | react-leaflet `<Polyline>` x N | `DeckGLOverlay` PathLayer |
| **Live track dots** | `DotsLayer` (L.circleMarker) | **Keep as-is** (small, <50 tracks) |
| **Live track polylines** | react-leaflet `<Polyline>` | **Keep as-is** |
| **Density, markers, events** | react-leaflet / imperative | **Keep as-is** |

**Rationale:** Live tracks are small (<50 tracks, <1000 positions) and update every 500ms — Leaflet's native renderer handles them fine. The heavy data is static tracks (dbHistory, imported, history) which are immutable after loading and can have 1M+ positions.

### Integration approach: `deck.gl-leaflet`

Use the `deck.gl-leaflet` package (v1.3.1) which wraps a deck.gl `Deck` instance as a proper Leaflet layer. This handles camera synchronization, projection, and canvas lifecycle automatically.

**Why not standalone canvas overlay:** Manual camera sync is fragile and requires handling zoom animations, fractional zoom, CSS transforms, and `invalidateSize()` edge cases. `deck.gl-leaflet` already solves these.

**Why not replace Leaflet with MapLibre:** Major architectural change that would affect tile layers, density GeoJSON, event markers, aircraft markers, tooltips — far beyond the scope of this optimization.

## Implementation Steps

### Step 1: Install dependencies

```bash
npm install deck.gl @deck.gl/core @deck.gl/layers @luma.gl/webgpu deck.gl-leaflet
```

- `deck.gl` — Meta-package for deck.gl v9
- `@deck.gl/core` — Core Deck class, viewport, picking
- `@deck.gl/layers` — ScatterplotLayer, PathLayer
- `@luma.gl/webgpu` — WebGPU adapter for luma.gl (deck.gl's GPU abstraction)
- `deck.gl-leaflet` — Leaflet integration layer

### Step 2: Create `DeckGLOverlay` component

**New file:** `src/components/DeckGLOverlay.tsx`

A React component that uses `useMap()` to get the Leaflet map instance, creates a `LeafletLayer` from `deck.gl-leaflet`, and manages deck.gl layers.

```
Props:
  tracks: AircraftTrack[]           — combined static tracks to render
  trajectoryStyle: "line" | "dots"  — determines ScatterplotLayer vs PathLayer
  colorMode: AltitudeColorMode      — "plot" (per-position) or "track" (per-track)
  selectedHexIdents: Set<string>    — for highlight styling
  theme: MapTheme                   — light/dark (affects altitude colormap)
  trackTypeMap: Map<string, "history" | "dbHistory" | "imported">  — per-track type for styling
  onSelectTrack: (hex: string | null) => void  — click handler
```

**Key design decisions:**

1. **Single DeckGLOverlay instance** for ALL static track types (history + dbHistory + imported), distinguished by `trackTypeMap`. This means one deck.gl canvas, one `LeafletLayer`, one set of GPU buffers — instead of 3 separate overlays competing for GPU memory.

2. **Data preparation:** Flatten all tracks' positions into typed arrays for deck.gl:
   - **Dots mode:** One flat array of `{ position: [lng, lat], altitude, trackKey, trackType, isSelected }` for ScatterplotLayer
   - **Line mode:** Array of paths (one per track) with `{ path: [[lng, lat], ...], color, width, trackKey }` for PathLayer

3. **Selection highlighting:** Use deck.gl's `updateTriggers` mechanism — when `selectedHexIdents` changes, only the color/radius accessors are re-evaluated (GPU-side), not the geometry.

4. **Tooltips:** Use deck.gl's `pickable: true` + `onHover` callback to show a custom HTML tooltip div (positioned absolutely). Reuse existing tooltip HTML patterns from current DotsLayer/Polyline tooltips.

5. **WebGPU configuration:**
   ```typescript
   import { webgpuAdapter } from '@luma.gl/webgpu';

   const deckProps = {
     deviceProps: {
       adapters: [webgpuAdapter],  // Prefer WebGPU, auto-fallback to WebGL2
     },
   };
   ```

### Step 3: Data transformation utilities

**New file:** `src/lib/deck-data.ts`

Pure functions to transform `AircraftTrack[]` into deck.gl-optimized data:

- `tracksToScatterData(tracks, trackTypeMap, theme)` → flat array for ScatterplotLayer
- `tracksToPathData(tracks, trackTypeMap, theme)` → per-track path array for PathLayer
- `getTrackColor(track, trackType, theme)` → `[r, g, b, a]` RGBA tuple
- `getPositionColor(altitude, theme)` → `[r, g, b, a]` for "plot" color mode

These are memoizable since static tracks don't change after loading.

### Step 4: Modify MapInner.tsx

1. **Add DeckGLOverlay** in place of the 3 `DotsLayer` instances + 3 Polyline blocks for static tracks
2. **Combine static tracks** into a single array with type metadata:
   ```typescript
   const staticTracks = useMemo(() => {
     const all: AircraftTrack[] = [];
     const typeMap = new Map<string, "history" | "dbHistory" | "imported">();
     for (const t of historyTracks) { all.push(t); typeMap.set(trackKey(t), "history"); }
     for (const t of dbHistoryTracks) { all.push(t); typeMap.set(trackKey(t), "dbHistory"); }
     for (const t of importedTracks) { all.push(t); typeMap.set(trackKey(t), "imported"); }
     return { tracks: all, typeMap };
   }, [historyTracks, dbHistoryTracks, importedTracks]);
   ```
3. **Keep DotsLayer** only for live tracks (type="live")
4. **Keep Polyline** only for live tracks
5. **Remove** the 3 DotsLayer instances for history/dbHistory/imported
6. **Remove** the 3 Polyline map blocks for history/dbHistory/imported

### Step 5: TDD — Tests

**New file:** `src/lib/__tests__/deck-data.test.ts`
- Test `tracksToScatterData` produces correct position/color/radius arrays
- Test `tracksToPathData` produces correct path/color/width arrays
- Test color output matches existing `cachedAltitudeToColor` for consistency
- Test selected vs unselected styling (radius, opacity)
- Test track type styling (history = dim, dbHistory = cyan, imported = indigo)

**New file:** `src/components/__tests__/DeckGLOverlay.test.tsx`
- Test that LeafletLayer is created and added to map
- Test that layers update when tracks change
- Test that selection change triggers `updateTriggers` (not full data rebuild)
- Test tooltip HTML on hover
- Mock `deck.gl-leaflet` and `@deck.gl/layers`

### Step 6: Fallback / Feature Detection

Add a `useWebGPUAvailable()` hook that checks `navigator.gpu` availability. Display GPU backend status in the app's metrics bar (informational only — deck.gl handles the fallback automatically, but the user may want to know which backend is active).

## Critical Files

| File | Action |
|------|--------|
| `src/components/MapInner.tsx` | Replace static track DotsLayer + Polylines with DeckGLOverlay |
| `src/components/DeckGLOverlay.tsx` | **New** — deck.gl Leaflet overlay component |
| `src/lib/deck-data.ts` | **New** — Track-to-deck.gl data transforms |
| `src/lib/__tests__/deck-data.test.ts` | **New** — Unit tests for data transforms |
| `src/components/__tests__/DeckGLOverlay.test.tsx` | **New** — Component tests |
| `src/lib/colors.ts` | May need `altitudeToRgba()` returning `[r,g,b,a]` tuple |
| `package.json` | Add deck.gl dependencies |

## Verification

1. `npm test` — All existing 694 tests pass + new tests pass
2. `npx next lint` — No lint errors
3. `npx next build` — Static export succeeds (deck.gl must be dynamically imported, no SSR)
4. `npm run tauri dev` — Visual verification:
   - Load >100 flights from DB History → Analysis
   - Toggle dots/line mode — both render correctly
   - Click track in table — selection highlights on map
   - Hover over dots/lines — tooltip appears
   - Pan/zoom — smooth at 60fps
   - Check console for `luma.gl: Using WebGPU` or `luma.gl: Using WebGL2` message
5. `cargo clippy -p adsb-pulsar-client-desktop -- -D warnings` — No Rust warnings (no Rust changes)

## Risk Mitigation

- **deck.gl-leaflet unmaintained:** The package is simple (~200 lines). If it breaks, we can vendor it and fix. The core logic is just camera sync + canvas overlay.
- **WebGPU crashes on older macOS:** deck.gl auto-falls back to WebGL2. No user action needed.
- **SSR incompatibility:** deck.gl + Leaflet both require `window`. Use `dynamic()` with `ssr: false` (already the pattern for MapInner).
- **Bundle size:** deck.gl adds ~200KB gzipped. Acceptable for a desktop app (no CDN concerns).

## Research Sources

- [deck.gl-leaflet GitHub](https://github.com/zakjan/deck.gl-leaflet) — Community Leaflet integration (v1.3.1)
- [deck.gl WebGPU Guide](https://deck.gl/docs/developer-guide/webgpu) — Experimental, v9.1 target
- [Tauri v2 Webview Versions](https://v2.tauri.app/reference/webview-versions/) — WKWebView on macOS
- [WebGPU in Safari/WKWebView](https://caniuse.com/webgpu) — macOS Tahoe 26+ enabled by default
- [deck.gl ScatterplotLayer](https://deck.gl/docs/api-reference/layers/scatterplot-layer) — Point rendering
- [deck.gl PathLayer](https://deck.gl/docs/api-reference/layers/path-layer) — Polyline rendering
- [luma.gl WebGPU Adapter](https://luma.gl/docs/api-guide/gpu/gpu-adapter) — GPU backend abstraction
