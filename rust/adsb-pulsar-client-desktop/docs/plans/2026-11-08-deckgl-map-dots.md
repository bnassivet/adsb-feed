# deck.gl dots on the desktop map

Branch `feature/deckgl-map-dots` (from `feature/map-render-bench`).
Evidence: `docs/MAP_BENCH.md`. The real 24 h view is 150k to 240k points, and
`DotsLayer` freezes for 0.3 s at 200k (1.8 s at 1M) on every pan or zoom.

## Goal

Replace `DotsLayer` (one `L.CircleMarker` per point, rebuilt on each
`moveend`) with one deck.gl overlay for **all four dot sets**: live, history,
DB History and imported. The 24 h startup preload goes through the
history set, so DB History alone would miss the main case. Line style is
unchanged, because Leaflet draws lines quickly.

## Parity to keep

| Behaviour | Today | New |
|---|---|---|
| Radius / opacity per type | history 2/0.2, imported 2.5/0.35, dbHistory 2.5/0.4, live 3/0.6 | same |
| Colour | `colorMode === "plot"`: per-point altitude, else track altitude; theme-aware | same, from `cachedAltitudeToColor` parsed to bytes |
| Selected track | radius +2, opacity 0.9, full detail | a small "selected" layer drawn on top of each set |
| Tracks with < 2 positions | skipped | skipped |
| Hover tooltip | per type (label, hex, alt, last seen / DB History / Imported) | same HTML, via `pickObject` on the map's `mousemove` |
| Z-order | dots above density/range lines, below aircraft icons | custom pane `deckDots`, z-index 450 |

## Design

- `src/lib/deck-dots.ts`, pure and tested:
  - `cssToRgb` parses colours;
  - `buildDotBuffers(tracks, {colorMode, theme, alpha, only?})` returns Float32 lng/lat, RGBA bytes, `starts` per track and the included tracks;
  - `locateDot(buffers, index)` returns the track, point, altitude and whether it is the last point (a binary search over `starts`, so there is no per-point track index).
- `src/lib/dot-tooltip.ts`, pure and tested: the per-type tooltip HTML from `MapInner`, with HTML escaping added, plus `formatAlt` and `timeAgo` moved here.
- `src/components/DeckDotsOverlay.tsx`: one `DeckLayer` (vendored, gaining a `pane` option) for all sets.
  - Each set's buffers are cached by identity of `(tracks, colorMode, theme)`. A live update therefore leaves the 200k-point history buffers untouched, and deck.gl sees the same `data` object, so nothing is uploaded again.
  - Picking is a throttled `pickObject` on `mousemove`. The deck canvas has `pointer-events: none`, so Leaflet keeps dragging and clicks.
- `MapInner`: the four `<DotsLayer>` become one `<DeckDotsOverlay groups=…>`, and `DotsLayer` is deleted.
- `@deck.gl/core` and `@deck.gl/layers` move to `dependencies`.

## Out of scope

- Click-to-select on dots. Dots don't have it today; lines do.
- Line style through deck.gl.
- Removing `subsamplePositions`, if it is still used elsewhere.

## Verification

- `npm test`, `npm run lint`, and `tsc` with no new errors.
- `npm run bench -- --variants leaflet,deckgl --sizes 200000,1000000 --scenarios load,panzoom`: the `leaflet` variant mounts the real `MapInner`, so its numbers should now track `deckgl`.
- Screenshots of the bench page in WebKit: dots coloured and placed as before.
- `npm run tauri dev`: the history preload shows, a hover tooltip appears, and selecting a track in the table enlarges its dots.
