# Show/hide live track positions (Display Layers)

## Context
The desktop map always draws the trail of past positions behind each **live** aircraft
(dots via `DotsLayer type="live"` or a `Polyline`, depending on `trajectoryStyle`).
With dense traffic this clutters the map. Add a "Show track positions" checkbox to the
**Display Layers** section that hides those trails while keeping the aircraft icons.
Scope (confirmed): live tracks only — history / DB history / imported keep their own toggles.
The chat's `setLayerVisibility` tool gains a matching `positions` switch.

## Changes (TDD: failing test first for each)

1. **`src/components/Filters.tsx`** — new props `showPositions: boolean`, `onTogglePositions: () => void`.
   Checkbox placed first in "Display Layers", same markup as "Show receiver" (accent-cyan),
   label `Show track positions`. Always visible (no conditional).
   *Test* `src/components/__tests__/Filters.test.tsx`: add to `defaultProps`; renders checked
   state; clicking calls `onTogglePositions`.

2. **`src/components/LeftPanel.tsx`** — pass the two props through to `FiltersPanel`
   (same as `showReceiver`/`onToggleReceiver`). Update its test's default props if it has one.

3. **`src/app/page.tsx`** —
   `const [showPositions, setShowPositions] = useLocalStorage<boolean>("adsb-show-positions", true);`
   (default `true` = current behaviour), `handleTogglePositions` like `handleToggleReceiver`,
   pass to `LeftPanel`, pass `showPositions` to `<AircraftMap>`, and add `setShowPositions`
   to the copilot config object (next to `setShowReceiver`, ~line 922).

4. **`src/components/Map.tsx` + `MapInner.tsx`** — new optional prop `showPositions = true`.
   In `MapInner` gate both live trail renderings:
   - `trajectoryStyle === "dots" && showPositions && tracks.length > 0 && <DotsLayer … type="live" />` (~l.995)
   - `t.positions.length > 1 && trajectoryStyle === "line" && showPositions && <Polyline …>` (~l.1100)
   Aircraft `Marker`s untouched. (MapInner is untested by convention; verified via tsc + runtime.)

5. **Chat tool** `src/hooks/useCopilotTools.ts` (`setLayerVisibility`, ~l.969):
   - `setShowPositions` in the config interface (~l.167);
   - zod param `positions: z.boolean().optional().describe("Show the trail of past positions behind live aircraft (aircraft icons stay visible)")`;
   - handler branch mirroring `receiver`; add `positions` to the description's layer list.
   - Disambiguate from `history` ("Show history trails"): reword history to
     "Show tracks of aircraft no longer live" so "hide trails" doesn't route to the wrong param.
   *Test* `src/hooks/__tests__/useCopilotTools.test.ts`: `{positions:false}` calls
   `setShowPositions` and returns `updated.positions === false`; update mock config.

6. **Python mirror** `adsb-agent/src/adsb_agent/tools.py` (~l.422): add the same `positions`
   property and the reworded `history` description. *Test*: a small assertion in an existing
   tools test (e.g. `tests/test_simulation_tool_disambiguation.py` style) that
   `setLayerVisibility` exposes `positions`.

7. **Docs** — `docs/DESIGN.md` display-layers section: one line on the new toggle and its
   localStorage key `adsb-show-positions`. Save this plan to
   `adsb-pulsar-client-desktop/docs/plans/2026-11-07-show-track-positions.md` before implementing.

## Verification
- `cd adsb-pulsar-client-desktop && npm test && npm run lint && npx tsc --noEmit` (tsc error count must not rise above the pre-existing ~55 in test files — `page.tsx` has no tests).
- `cd adsb-agent && uv run pytest tests/`.
- Runtime: `npm run tauri dev` (or `make up-desktop`), toggle the checkbox in both "dots" and
  "line" trajectory styles — trails disappear, aircraft icons and history/imported layers stay;
  setting survives restart. Ask chat "hide the track positions" → checkbox unticks.
- Commit on the current `feature/tracks_display_enhancements` branch; do not push.
