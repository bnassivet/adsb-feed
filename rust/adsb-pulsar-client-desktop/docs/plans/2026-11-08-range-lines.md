# Range lines: receiver → selected aircraft

## Context
The Aircraft Details panel now shows distance, azimuth and elevation from the receiver
(commit ab1cec8). The goal is to see that geometry on the map as well: a line from the receiver to
each selected aircraft, labelled with the same numbers, following the aircraft live.

UI decisions (confirmed with the user):
- **Entry points:** a toggle button in the map control stack directly under "Center on antenna", plus
  the same toggle beside the Distance row in the details panel. Both drive one persisted **mode**
  (`adsb-show-range-lines`, default off). It is a mode rather than a one-off action because the target moves and
  selection is already how the user says "these aircraft". It is disabled when no receiver is configured.
- **Targets:** **every** selected aircraft (multi-select), in any section that is on the map:
  live, history, DB history, imported, analysis. Each line ends at the aircraft's latest position.
- **Label:** one chip at the line's midpoint, `111 km / 60.0 NM · 180.0° · el 5.0°`. The elevation part is
  dropped when altitude is unknown. It uses the same formatters as the details panel, so the two never disagree.

Out of scope: a right-click menu on aircraft. Today a right-click on an aircraft falls through to the map's
"Create Event Here" menu, and a per-aircraft menu can come later.

## Design

### Visual
```
 ┌──┐ zoom (+/−)                        ✈ AFR123
 ├──┤                                  ╱
 │📡│ Center on antenna     ┌─────────────────────────────────┐
 ├──┤                       │111 km / 60.0 NM · 180.0° · el 5.0°│
 │⟋ │ ← NEW range-line btn  └─────────────────────────────────┘
 ├──┤   (lit = on)          ╱
 │◐ │ theme (moved down)  📡 receiver
 └──┘
```
- **Line:** a dashed line (`dashArray "6 4"`, weight 1.5, opacity 0.9) in the receiver's magenta `#e91e90`, so it
  reads as "belongs to the receiver" and not as a trail. It is non-interactive, so it never blocks a click on an aircraft.
  It is drawn as a **great circle** (about 32 interpolated points), so its direction at the receiver matches the azimuth shown.
  A Leaflet straight line is a rhumb line in Mercator and would disagree slightly over long distances.
- **Chip:** a non-interactive divIcon at the midpoint. Monospace 10px, styled like the track labels
  (dark or light by theme), with a magenta left border.
- **Map button:** the same 32px white square as the antenna button. Its icon is a dashed diagonal line with an
  end dot. When on: magenta icon, pink-50 background and pink-400 border. `aria-pressed` is set. Titles:
  "No receiver location set" (disabled), "Show range lines to selected aircraft", "Hide range lines".
- **Details panel:** a small 16px toggle with the same icon at the right end of the **Distance** row, sharing the
  `aria-pressed` state and titles. It only exists when a receiver is configured, like the rows themselves.
- **Mode on, nothing selected:** nothing is drawn and the button stays lit. The button title says
  "Range lines on: select an aircraft".

### Control stack shift
Moving the stack down by one slot (2.25rem) makes room under the antenna button:
- `MapTileToggle`: `top-20` → `top-[7.25rem]`
- `AltitudeLegend`: `top-32` → `top-[10.25rem]`
- `WindSpeedLegend`: `top-[17rem]` → `top-[19.25rem]`
- new `RangeLineButton`: `top-20`

## Changes (TDD: failing test first for each)

1. **`src/lib/range-line.ts`** (pure) + `src/lib/__tests__/range-line.test.ts`
   - `greatCirclePoints(from, to, segments = 32): [lat, lng][]`. The endpoints are exact, every point
     sits on the great circle (cross-track ≈ 0), it returns `[from, to]` when the two coincide, and it does not
     blow up near 180° separation.
   - `rangeLineLabel(track, receiver)` builds on `receiverDistanceNm`, `formatDistance`,
     `receiverAzimuthDeg`, `formatAngle` and `receiverElevationDeg` from `lib/aircraft-details.ts`.
     It returns null without a position. Tests cover the full chip and the variant without elevation when altitude is null.
   - `rangeLineTargets(selected: Set<string>, tracksByKey: Map<string, AircraftTrack>)`: the selected
     tracks that have a position, in selection order. Tests cover unknown keys, no position and hidden tracks (absent from the map).
   - `midpoint(points)`: the middle point of the interpolated line, used to anchor the chip.

2. **`src/components/RangeLineButton.tsx`** + test, mirroring `CenterOnAntennaButton` and its
   test: it renders, is disabled without a receiver, shows `aria-pressed` and the titles, and calls `onToggle` on click.

3. **`src/components/AircraftDetailsPanel.tsx`**: optional props `rangeLineOn`, `onToggleRangeLine`
   (the toggle is rendered only when `onToggleRangeLine` and a receiver are both present). Tests in
   `AircraftDetailsPanel.test.tsx` cover pressed state, click and absence without a receiver.

4. **`src/components/Map.tsx` / `MapInner.tsx`**: props `rangeLineOrigin?: ReceiverPoint`
   (**not** gated by "Show receiver"), `rangeLineTargets?: AircraftTrack[]`, `showRangeLines?: boolean`,
   and `onToggleRangeLines?`. A declarative `RangeLinesLayer` draws one `Polyline` and one chip `Marker` per target,
   keyed by `trackKey`. Render the button next to `CenterOnAntennaButton`, and apply the control stack shift.
   MapInner stays untested by convention; it is verified by tsc and at runtime.

5. **`src/app/page.tsx`**: add `useLocalStorage<boolean>("adsb-show-range-lines", false)` and
   `handleToggleRangeLines`. Add `rangeLineTargets = useMemo(() => rangeLineTargets(selectedHexIdents, allMapTracksMap))`.
   Pass `rangeLineOrigin={receiverLocation}` (always) and the mode/targets/toggle to `<AircraftMap>`, and the mode and toggle
   to `<AircraftDetailsPanel>`.

6. **Chat** (consistent with positions and labels): `setLayerVisibility` gains
   `rangeLines: z.boolean().optional().describe("Show distance/bearing lines from the receiver to the selected aircraft")`,
   with a handler branch and an entry in the layer list. `useCopilotContext` gets `rangeLines` in the visible-layers readable.
   The Python mirror in `adsb-agent/src/adsb_agent/tools.py` gets the same. Tests: `useCopilotTools.test.ts`,
   `useCopilotContext.test.ts`, mock configs in `useCopilotScenarioTools.test.ts`, and
   `adsb-agent/tests/test_layer_positions_tool.py`.

7. **Docs**: save this plan as `adsb-pulsar-client-desktop/docs/plans/2026-11-08-range-lines.md`
   before implementing. In `docs/DESIGN.md`, add a `showRangeLines` state line, a localStorage row, and a short
   "Range lines" paragraph: mode vs action, great circle vs rhumb line, origin not gated by Show receiver,
   shared formatters.

## Verification
- `cd adsb-pulsar-client-desktop && npm test && npm run lint && npx tsc --noEmit`, with tsc staying at the 57 baseline.
- `cd ../adsb-agent && uv run pytest tests/`.
- Runtime: run `make up-desktop` (or `npm run tauri dev`) and turn on demo flights.
  - Select one aircraft and click the new button. A dashed magenta line runs from the receiver to it, its chip
    matches the details panel's Distance, Azimuth and Elevation exactly, and it follows the aircraft every update.
  - Ctrl-select two more aircraft: three lines.
  - The details-panel toggle switches the same mode both ways.
  - Untick "Show receiver": the lines remain.
  - Clear the receiver location in Settings: the button is disabled and the lines disappear.
  - Check the control stack: no overlap between the buttons and the altitude or wind legends.
  - Restart: the mode persists.
  - Ask the chat to "show the range lines".
- Run `graphify update .`, then commit on `feature/tracks_display_enhancements` without pushing.
