# Radar Range: fixed ring scale and per-arc density

## Context

In DB History → Statistics, the Detection Range radar draws 3 to 5 rings at fractions of the max range
(`buildDistanceRings`, `src/lib/detection-radar.ts:145`), so the labels are irregular (`67 NM`, `134 NM`).
The user wants:
1. **Round ring steps**: 25 NM by default, chosen with a selector (Auto / 10 / 25 / 50 / 100 NM) and
   capped at **5 rings**. If a step would need more than 5 rings, it moves up to the next step. Auto
   starts from the smallest step.
2. **Density per arc**: position count for each annular cell (10° sector × ring band). A **Density
   option** turns it on as a layer under **both** the Polar and the Polygon mode; it is not a third
   mode. Each cell is colored on the activity-heatmap color ramp, and the tooltip lists the count for
   each band. Performance cost is negligible: at most 36 × 5 = 180 SVG paths, memoized on data and step.

Today the backend returns only sector aggregates (`get_detection_range_sync`, `adsb-data-engine/src/storage.rs:1503`).
Distance bands are not available.

## Approach

### Backend: a fine distance histogram per sector, opt-in

- `DetectionRangeQuery` (`adsb-data-engine/src/types.rs:217`): add
  `#[serde(default)] band_width_nm: Option<f64>`.
- `DetectionRangeSector`: add
  `#[serde(default, skip_serializing_if = "Vec::is_empty")] band_counts: Vec<u64>`. Entry `i` counts the
  positions in `[i·w, (i+1)·w)`, and trailing zeros are trimmed.
  - Opt-in, so the agent's `getDetectionRange` tool and `adsb-data-server` return the same payload as before.
  - The new field is optional on both sides, so existing callers and the Python schema need no changes.
- SQL: keep the whole plausibility-filtered subquery unchanged. Replace the final
  `GROUP BY sector` with `GROUP BY GROUPING SETS ((sector), (sector, band))`, where
  `band = CAST(FLOOR(distance_nm / ?) AS INTEGER)`, and use `GROUPING(band)` to tell the two kinds of
  rows apart.
  - One pass over the data. The window functions are not run twice.
  - `COUNT(DISTINCT flight_id)` stays correct on the sector rows.
  - When `band_width_nm` is `None`, the current single grouping stays and the bands are skipped.
  - Divide with `FLOOR(... / ?)`: DuckDB's `/` is float division (the past bug in MEMORY: detection range radar).
- Validate `band_width_nm > 0` (else `StorageError::Query`). Merge band rows into `sectors[i].band_counts` (resize, accumulate).
- Bin width chosen by the desktop: **5 NM**. Every selectable step (10/25/50/100) is a multiple of 5,
  so changing the step only re-buckets on the client. It needs no new query.

### Frontend

- `src/lib/types.ts`: mirror `band_width_nm?` and `band_counts?: number[]`.
- `DBHistoryContent.tsx:118`: pass `band_width_nm: RADAR_BAND_WIDTH_NM` (exported const = 5 from `detection-radar.ts`).
- `src/lib/detection-radar.ts` (pure, tested):
  - `RING_STEPS_NM = [10, 25, 50, 100, 200]`, `MAX_RINGS = 5`, `type RingStep = "auto" | number`.
  - `resolveRingStep(maxRange, choice)`: start from the chosen step (Auto starts at 10) and step up until
    `ceil(maxRange/step) ≤ 5`. Beyond the list, use multiples of the last step.
  - `buildDistanceRings(maxRange, step, config)` now returns rings at `step, 2·step, …` and a scale
    radius `outerNm = ringCount·step`. **Every radius is normalized to `outerNm`, not `maxRange`**, so
    the wedges, the polygon and the rings share one scale.
  - Change `buildRadarPoints` / `buildSectorWedges` to take an explicit `scaleNm`, defaulting to
    `computeMaxRange` so existing tests keep their meaning.
  - `rebinBandCounts(bandCounts, binNm, stepNm, ringCount)` folds the counts into ring bands. Positions
    beyond the outer ring go into the last band; the outer ring is ≥ max range by construction, so in
    practice none are lost.
  - `buildDensityCells(sectors, step, ringCount, config)` returns, for each cell, an annular-sector path
    (outer arc, line, inner arc reversed, close) with `{bearingDeg, ringIndex, count, t}`.
    - `t = count / maxCellCount`, linear.
    - Zero-count cells are skipped.
- Move `heatmapColor` out of `DBHistoryAnalytics.tsx:910` into `src/lib/heatmap-color.ts`, export it,
  and reuse it for the density cells. The activity heatmap's behavior does not change. *(Refactor approved.)*
- `RadarMode` is **unchanged** (`"polygon" | "polar"`).
- `DetectionRadar.tsx`:
  - New props `ringStep: RingStep` and `showDensity: boolean`.
  - When `showDensity` is on, in either mode, draw the cells with `fill={heatmapColor(t)}` first, under
    the rings and under the wedges/polygon. Lower the wedge/polygon fill opacity (0.35 → ~0.15, outline
    kept) so the heat stays readable. The existing hit zones and wedge hover keep handling the tooltip.
  - When `showDensity` is on, the tooltip adds one line per band: `0–25 NM: 1,234`.
  - Footer: `Max range: 67 NM · 25 NM/ring`.
- `DBHistoryAnalytics.tsx` `DetectionRangeSection`:
  - Add a **Density** toggle button next to Polar/Polygon. Like the mode, it is plain `useState`
    (default off): persisting the mode was declined.
  - Add a compact `<select>` for the step (Auto/10/25/50/100). This is new state, stored with
    `useLocalStorage<RingStep>("adsb-radar-ring-step", 25)`.

### Refactors (approved 2026-11-20)
- Extract `heatmapColor` → `src/lib/heatmap-color.ts`.
- Explicit `scaleNm` on `buildRadarPoints` / `buildSectorWedges` (optional, default unchanged).
- `buildDistanceRings(maxRange, step, config)` new signature; update its tests.
- **Declined**: persisting radar mode. Do not touch the existing `useState`.
- Any other refactor that comes up during implementation → stop and ask first.

## TDD order (one red→green cycle per commit)

1. Rust `storage.rs` tests (next to the existing detection-range tests):
   - With `band_width_nm: Some(5.0)`, the band counts sum to `position_count` for each sector, and
     positions at known distances land in the expected bands.
   - `None` gives an empty `band_counts`, and the JSON does not contain the key.
   - A width ≤ 0 is rejected.
2. `detection-radar.test.ts`:
   - `resolveRingStep`: 67 NM with step 25 gives 25 NM per ring and 3 rings. 180 NM with step 25 moves
     up to 50. 400 NM on Auto gives 100. With 900 NM, the step goes beyond the list.
   - Ring labels are round numbers.
   - The wedges are scaled to `outerNm`.
   - `rebinBandCounts` keeps the total.
   - `buildDensityCells` skips empty cells and sets t = 1 on the busiest cell.
3. `DetectionRadar.test.tsx`:
   - `showDensity` renders `density-cell` in **both** polar and polygon modes, and none when it is off.
   - The tooltip shows the per-band lines.
   - There are at most 5 `ring-label` elements, and their text is `25 NM`, `50 NM`, ….
4. `DBHistoryAnalytics` / `commands.test.ts`:
   - The step selector changes the labels.
   - `getDetectionRange` is called with `band_width_nm: 5`.

## Files

- `adsb-data-engine/src/types.rs`, `adsb-data-engine/src/storage.rs` (`get_detection_range_sync`)
- `adsb-pulsar-client-desktop/src/lib/{types.ts, detection-radar.ts, heatmap-color.ts}`
- `adsb-pulsar-client-desktop/src/components/{DetectionRadar.tsx, DBHistoryAnalytics.tsx, DBHistoryContent.tsx}`
- Tests: `src/lib/__tests__/detection-radar.test.ts`, `src/components/__tests__/DetectionRadar.test.tsx`
- Docs: plan saved to `adsb-pulsar-client-desktop/docs/plans/2026-11-20-radar-range-rings-density.md`
  before starting. Update the Detection Range section of `docs/DESIGN.md` before proposing the commit.
- Branch `feature/radar-range-rings-density`. Commit only, no push, no Co-Authored-By.

## Verification

- `cargo test -p adsb-data-engine detection_range && cargo clippy --workspace -- -D warnings && cargo fmt --all --check` (from `rust/`)
- `npm test && npm run lint && npx tsc --noEmit` (compare the tsc error count with the ~55 known errors in test files)
- Manual: run `make up-desktop` and open DB History → Statistics.
  - Check that the rings read 25/50/75 NM.
  - Switch the step: a step that gives more than 5 rings is raised.
  - With Density on (Polar, then Polygon), the arcs near the receiver should be the hottest, and the tooltip totals should
    match Positions.
- `graphify update .` after the changes.
