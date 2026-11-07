# Track labels with auto-layout (live mode)

## Context
Live aircraft show their identity only on hover. Add a **"Show track labels"** checkbox to
Display Layers that draws a permanent label `HEXIDENT/CALLSIGN` (`-` when no callsign, e.g.
`4CA2B1/RYR12AB`, `A1B2C3/-`) beside every live aircraft. Labels must follow their aircraft and
never overlap each other — an automatic placement pass picks a slot for each one.

Live only comes for free: `page.tsx` already passes `EMPTY_TRACKS` as `tracks` outside live mode
(`mapTracks`, ~l.702). Hidden-section filtering also applies already. History, DB history and
imported layers get no labels.

The wiring follows the template of the last commit (3d575ae, "Show track positions"), step for
step: Filters → LeftPanel → page.tsx (useLocalStorage) → Map → MapInner, plus the chat
`setLayerVisibility` switch on both sides.

## Design of the auto-layout (pure, in `src/lib/label-layout.ts`)
Kept apart from Leaflet so it can be fully unit-tested (MapInner is untested by convention).

- `trackLabelHtml(placement, text, color, selected, theme)`: the chip plus an optional leader line, HTML-escaped (in the lib too, so it is testable).
- `formatTrackLabel(t)` → `` `${hex_ident}/${callsign?.trim() || "-"}` ``.
- `layoutLabels(items, opts, previous?)` → `Map<key, Placement | null>`
  - `items`: `{ key, x, y, heading, text, priority }`, where `x`/`y` are the aircraft's screen
    pixels (from `map.latLngToContainerPoint`).
  - Label box size: a **monospace** font at 10px, so `width = chars × CHAR_W + padding` is exact
    (no DOM measuring).
  - **Candidates:** 8 slots around the icon (N, NE, E, SE, S, SW, W, NW), at a gap of icon half-size
    (the icon is 24px, 36px when selected, `aircraft-icon.ts`; a *square* ring, so diagonal slots clear the icon's corners) plus 4px. Then the same 8 slots at a larger radius, with a
    thin leader line. That makes 16 in all.
  - **Following the track:** candidates are scored by how far they sit from the trail. The trail
    leaves the aircraft at `heading + 180°`, so the slot nearest that direction is penalised the
    most. Perpendicular slots (to the right of the heading first) score best. As the aircraft
    turns, its label keeps beside it and off its own trail.
  - **Stability (no flicker at 2 Hz):** the slot from `previous` gets a bonus, so a label only
    moves when its slot collides or becomes clearly worse.
  - **No overlap:** greedy, in priority order (selected tracks first, then the most recently
    seen). Each label takes the best-scoring candidate whose box overlaps no placed label, no
    aircraft icon box and stays inside the viewport. If none fits it gets `null` and is hidden.
    Hiding is the only way to guarantee "no superposition" in dense traffic. A selected
    track's label is always placed, even if that forces an overlap.
  - Complexity: O(n × 16 × placed). That is fine for a few hundred aircraft. If needed, a
    uniform grid bucket for collision checks drops it to near-linear (only if a test shows the need).

## Changes (TDD: failing test first for each)

1. **`src/lib/label-layout.ts`** + `src/lib/__tests__/label-layout.test.ts`:
   - label text: callsign / null / blank → `-`;
   - a lone aircraft gets a slot perpendicular to its heading, never the trail-side slot;
   - two aircraft a few px apart → both placed, boxes do not intersect;
   - no label overlaps another aircraft's icon;
   - a dense cluster → every placed pair is disjoint, the surplus is `null`, the selected one is placed;
   - stability: same input + `previous` → same slots; a small move keeps the slot;
   - an off-viewport box is never chosen.

2. **`src/components/Filters.tsx`**: props `showLabels`, `onToggleLabels`. A checkbox
   "Show track labels" sits right after "Show track positions", with the same markup.
   *Test* in `Filters.test.tsx`: checked/unchecked/click. Add the props to `defaultProps` in
   `Filters.weather.test.tsx` and `LeftPanel.test.tsx`.

3. **`src/components/LeftPanel.tsx`**: pass both props through.

4. **`src/app/page.tsx`**:
   `useLocalStorage<boolean>("adsb-show-labels", false)` (off by default, so current behaviour is
   unchanged). Add `handleToggleLabels`, pass to LeftPanel and `<AircraftMap showLabels>`, and add
   `showLabels`/`setShowLabels` to the copilot tools and context config objects.

5. **`src/components/Map.tsx` / `MapInner.tsx`**: optional prop `showLabels = false`. A new
   imperative `TrackLabelsLayer` (same style as `DotsLayer`, using `useMap`):
   - creates a pane `track-labels` (zIndex 640, above the marker pane at 600) with `pointer-events: none`,
     so labels never steal clicks from aircraft;
   - keeps a `Map<key, L.Marker>` of `divIcon` label markers (`interactive: false`) plus an
     leader line drawn inside the same divIcon (SVG), so there is no extra layer;
   - on `tracks` change and on `zoomend`/`moveend`/`resize`, it projects positions and calls
     `layoutLabels(…, previousRef.current)`. It then calls `setLatLng` on every marker and `setIcon`
     **only when the slot or text changed**. Unplaced labels are removed. Markers for departed
     tracks are destroyed, and everything is cleaned up on unmount;
   - the label is styled theme-aware (dark or light chip, monospace 10px). The text is colored by
     altitude via `cachedAltitudeToColor`, and a selected label is bold.
   Render it as `{showLabels && orderedTracks.length > 0 && <TrackLabelsLayer … />}`. During a
   zoom animation, Leaflet repositions marker-pane children for us. The layout re-runs on `zoomend`.

6. **Chat**: `useCopilotTools.ts` `setLayerVisibility` gains
   `labels: z.boolean().optional().describe("Show hex ident / callsign labels next to live aircraft")`,
   with a handler branch and `labels` added to the layer list in the description. `useCopilotContext.ts`
   adds `labels` to the visible-layers readable. The Python mirror `adsb-agent/src/adsb_agent/tools.py` gets the same
   property. *Tests*: in `useCopilotTools.test.ts` (`{labels:true}` → `setShowLabels`), the
   `useCopilotContext.test.ts` readable, and `useCopilotScenarioTools.test.ts` mock config, plus
   `adsb-agent/tests/test_layer_positions_tool.py` (extended with a `labels` assertion).

7. **Docs**: save this plan as
   `adsb-pulsar-client-desktop/docs/plans/2026-11-07-track-labels.md` before implementing. In
   `docs/DESIGN.md`, add a `showLabels` state line, the `adsb-show-labels` localStorage row and a
   short "Track label layout" paragraph (candidates, scoring, hysteresis, hide-on-collision).

## Verification
- `cd adsb-pulsar-client-desktop && npm test && npm run lint && npx tsc --noEmit`. The tsc error
  count must not rise above the pre-existing ~55.
- `cd ../adsb-agent && uv run pytest tests/`.
- Runtime: run `make up-desktop` (or `npm run tauri dev`) with demo flights on and tick "Show track labels".
  Check that labels read `HEX/CALL` or `HEX/-`, track their aircraft, and stay clear of trails and of each other.
  Zoom out until crowded: labels drop out, and none overlap. Select an aircraft: its label is
  always shown. Switch to Analysis: no labels. Restart: the setting persists. Ask the chat to
  "show the aircraft labels": the checkbox ticks.
- Run `graphify update .`, then commit on `feature/tracks_display_enhancements` without pushing and
  without a Co-Authored-By trailer.
