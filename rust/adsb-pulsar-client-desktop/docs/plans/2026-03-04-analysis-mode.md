# Analysis Mode — Implementation Plan

## Context

The app currently has a single "Live" view where real-time tracks, in-memory history, DB History trajectories, imported tracks, and simulated tracks all render together on the map and table. When a user loads a trajectory from DB History, it appears as a cyan overlay on the live map — but there's no dedicated workspace for historical analysis.

The goal is to add an **Analysis mode** — a separate view context that displays DB History tracks exclusively, while live processing continues uninterrupted in the background. Users switch between Live and Analysis via a tab bar above the track table. The map and table update to show whichever mode is active.

## Design Decisions

### 1. Mode state: simple string in `page.tsx`

```typescript
const [activeMode, setActiveMode] = useLocalStorage<"live" | "analysis">("adsb-active-mode", "live");
```

No new context needed — the mode is a view concern, not a data concern. `page.tsx` already orchestrates which arrays go to Map and Table.

### 2. Analysis tracks: new ref `analysisRef` in `AircraftTrackingContext`

Currently `dbHistoryRef` is cleared+replaced on each trajectory load (`loadDbHistoryTracks` calls `map.clear()`). For Analysis mode, we need **additive** loading — load multiple trajectories that accumulate.

Add a new `analysisRef` map in the context with these functions:
- `addAnalysisTracks(tracks: AircraftTrack[])` — **additive** (no clear before insert)
- `removeAnalysisTrack(hexIdent: string)` — remove a single track
- `clearAnalysis()` — clear all

The existing `dbHistoryRef` stays unchanged (it continues to serve the cyan overlay in Live mode).

### 3. Map rendering by mode

In `page.tsx`, derive the Map props based on `activeMode`:

- **Live mode** (current behavior, unchanged):
  - `tracks` = allTracks (live + simulated)
  - `historyTracks` = visibleHistory
  - `importedTracks` = visibleImported
  - `dbHistoryTracks` = visibleDbHistory
  - Density overlay uses live+history tracks

- **Analysis mode**:
  - `tracks` = [] (no live markers)
  - `historyTracks` = [] (no in-memory history)
  - `importedTracks` = [] (no imports)
  - `dbHistoryTracks` = analysisFiltered (the analysis tracks, rendered with same cyan styling)
  - Density overlay uses analysis tracks

The Map component itself needs **zero changes** — it already renders whatever arrays it receives.

### 4. Table tabs

Add a tab bar between the resize handle and the table:
```
[ Live (42) ] [ Analysis (5) ]
```

- Clicking a tab sets `activeMode`
- Live tab shows count of live+simulated tracks
- Analysis tab shows count of analysis tracks
- Active tab gets a highlight (blue underline for Live, cyan for Analysis)

The AircraftTable itself needs **minimal changes** — `page.tsx` controls what arrays are passed:
- **Live mode**: same as today (live, history, dbHistory, imported sections)
- **Analysis mode**: only the analysis tracks passed as the primary `tracks` prop (rendered in the "Live" section styling but with analysis context)

### 5. Independent filters per mode

Each mode has its own filter state so analysis workflows don't interfere with live monitoring:

```typescript
const [liveFilters, setLiveFilters] = useState<Filters>(DEFAULT_FILTERS);
const [analysisFilters, setAnalysisFilters] = useState<Filters>(DEFAULT_FILTERS);
const activeFilters = activeMode === "live" ? liveFilters : analysisFilters;
const setActiveFilters = activeMode === "live" ? setLiveFilters : setAnalysisFilters;
```

The `LeftPanel` receives whichever filter set is active. Switching modes swaps the filter state seamlessly. The `useAircraftTracks` hook is called with `activeFilters` (or we call it with both and pick the right results based on mode — but simpler to just pass the active one since we only display one mode at a time).

**Note**: Analysis mode filters only apply to the analysis tracks array. Since `useAircraftTracks` already has `matchesFilters()` logic, we apply it to the analysis tracks the same way.

### 6. DB History panel: multi-selection + dual load targets

The DB History aircraft list gets **multi-selection** capability:

- **Checkboxes** on each aircraft row for selection
- **"Select All" / "Deselect All"** toggle at the top of the list
- **Two action buttons** below the list:
  - **"Load to Live"** — fetches all selected trajectories, calls `loadDbHistoryTracks` (replaces, as today)
  - **"Load to Analysis"** — fetches all selected trajectories, calls `addAnalysisTracks` (additive)
- The existing single-click row behavior stays (loads single trajectory to Live overlay for quick preview)
- Multi-select mode is implicit — checkboxes are always visible

Loading flow for multi-selection:
1. User browses a time range → aircraft summary list appears
2. User checks multiple aircraft (or "Select All")
3. Clicks "Load to Analysis" → fetches all trajectories in parallel (with a loading spinner), then calls `addAnalysisTracks` with the batch
4. Switches to Analysis tab to see them on the map

### 7. Analysis track management in the table

In Analysis mode, the table shows analysis tracks with management controls:
- Each row gets a small **remove button** (×) to remove that single track from the analysis set
- A **"Clear all"** button in the Analysis tab bar or above the table

### 8. Selected track across mode switches

When switching modes, `selectedHexIdent` is preserved if the track exists in the new mode's visible tracks, otherwise auto-cleared. This is already handled by the existing auto-deselect effect (page.tsx lines 99-107).

## Files Modified

### `src/lib/types.ts`
- Added `ActiveMode` type: `"live" | "analysis"`

### `src/contexts/AircraftTrackingContext.tsx`
- Added `analysisRef = useRef<Map<string, AircraftTrack>>(new Map())`
- Added `addAnalysisTracks(tracks)` — iterates and sets without clearing
- Added `removeAnalysisTrack(hexIdent)` — deletes single entry
- Added `clearAnalysis()` — clears the map
- Exposed `analysis` map + new functions in context value interface

### `src/hooks/useAircraftTracks.ts`
- Added `analysis` to the returned arrays (derived from context's analysis map, filtered by active filters when in analysis mode)
- Re-exported `addAnalysisTracks`, `removeAnalysisTrack`, `clearAnalysis`

### `src/components/ModeTabs.tsx` (new file)
- Tab bar component: Live / Analysis tabs with counts
- Props: `activeMode`, `onModeChange`, `liveCount`, `analysisCount`, `onClearAnalysis`
- Analysis tab includes a "Clear all" action
- Styled to match app theme (slate background, blue/cyan accents)

### `src/app/page.tsx`
- Added `activeMode` state via `useLocalStorage`
- Split filters: `liveFilters` + `analysisFilters`, derive `activeFilters`
- Destructured `analysis`, `addAnalysisTracks`, `removeAnalysisTrack`, `clearAnalysis` from `useAircraftTracks`
- Mode-conditional Map/Table props (described in section 3)
- Rendered `<ModeTabs>` between ResizeHandle and AircraftTable
- Passed `addAnalysisTracks` to `DBHistoryContent`
- Passed `onRemoveTrack` to `AircraftTable` in analysis mode

### `src/components/DBHistoryContent.tsx`
- Added `onAddToAnalysis?: (tracks: AircraftTrack[]) => void` prop
- Added `onSwitchToAnalysis?: () => void` prop
- Added checkbox per aircraft row + "Select All" toggle
- Tracked selected hex_idents in local state: `selectedAircraft: Set<string>`
- Added "→ Live" and "→ Analysis" batch action buttons
- Batch loading: `Promise.all` to fetch multiple trajectories in parallel, with loading state
- Kept existing single-click behavior for quick preview to Live

### `src/components/AircraftTable.tsx`
- Added optional `onRemoveTrack?: (hexIdent: string) => void` prop
- When `onRemoveTrack` is provided, rendered a small × button at the end of each row
- No other changes — sections, sorting, selection all work as-is

### `src/components/LeftPanel.tsx` / `Filters.tsx`
- No structural changes — they receive whichever filter state is active via props (already works this way)
- The track count display adapts automatically since `page.tsx` passes the mode-appropriate count

## Files NOT Modified

- `MapInner.tsx` — renders whatever arrays it receives
- `AircraftDetailsPanel.tsx` — works with any selected track
- `DBHistoryPanel.tsx` — container layout, no data logic
- `DBHistoryAnalytics.tsx` — analytics charts, unaffected
- Rust backend — no changes needed, same DuckDB queries

## Implementation Order

1. **Types** (`types.ts`): Add `ActiveMode` type
2. **Context** (`AircraftTrackingContext.tsx`): Add `analysisRef` + 3 functions + context interface
3. **Hook** (`useAircraftTracks.ts`): Expose analysis tracks and functions
4. **ModeTabs** (new `ModeTabs.tsx`): Create tab bar component + tests
5. **AircraftTable**: Add optional `onRemoveTrack` prop + × button
6. **page.tsx**: Wire up mode state, independent filters, conditional props, render ModeTabs
7. **DBHistoryContent**: Multi-selection UI, Select All, dual "Load to" buttons, batch loading

## TDD Test Plan

### Context tests (`src/contexts/__tests__/analysis.test.tsx`)
- `addAnalysisTracks` is additive: add 2 tracks, add 1 more → 3 total
- `addAnalysisTracks` overwrites same hex_ident (update, not duplicate)
- `removeAnalysisTrack` removes single track, others remain
- `clearAnalysis` empties the map
- `analysis` and `dbHistory` are independent

### ModeTabs tests (`src/components/__tests__/ModeTabs.test.tsx`)
- Renders both tabs with correct counts
- Active Live tab has blue styling
- Active Analysis tab has cyan styling
- Click calls `onModeChange` with correct mode
- "Clear all" button visible on Analysis tab when count > 0
- "Clear all" button hidden in Live mode
- "Clear all" button hidden when analysis count is 0
- "Clear all" button calls `onClearAnalysis`

### AircraftTable tests (extended `AircraftTable.test.tsx`)
- When `onRemoveTrack` provided, × button renders per row
- When `onRemoveTrack` not provided, no × button
- Clicking × calls `onRemoveTrack` with hex_ident
- Clicking × does not trigger row selection (stopPropagation)

### DBHistoryContent tests (extended `DBHistoryContent.test.tsx`)
- Checkboxes render per aircraft row
- "Select All" toggles all checkboxes
- "→ Live" button disabled when none selected
- "→ Analysis" button visible when onAddToAnalysis provided
- "→ Analysis" button hidden when onAddToAnalysis not provided
- "→ Analysis" calls onAddToAnalysis with fetched tracks

## Verification

1. `npm test` — all existing + new TS tests pass (434 total)
2. `npx next build` — builds successfully
3. `cargo test --workspace` — Rust tests still pass (no backend changes)
4. Manual: `npm run tauri dev` → full mode switching, multi-select loading, filter independence
