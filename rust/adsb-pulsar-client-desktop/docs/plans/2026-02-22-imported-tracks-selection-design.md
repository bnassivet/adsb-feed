# Imported Tracks: Selection & Aircraft Details Panel

**Date**: 2026-02-22
**Status**: Approved

## Problem

Imported tracks (loaded via GeoJSON import) cannot be selected to display in the Aircraft Details panel. Four independent gaps block the full selection flow:

1. **`page.tsx`** — `selectedTrack` lookup searches `allTracks` and `visibleHistory` but not `visibleImported`. An imported track can never be resolved → panel never mounts.
2. **`MapInner.tsx` (DotsLayer)** — Imported `DotsLayer` receives `selectedHexIdent={null}` hardcoded → imported dots never get the selection visual emphasis (larger radius, higher opacity).
3. **`MapInner.tsx` (Polyline)** — Imported `Polyline` elements have no `onClick` handler → clicking an imported track line on the map does nothing. No selection emphasis on weight/opacity either.
4. **`AircraftTable.tsx`** — Imported rows call `onSelectTrack` correctly but lack the `isSelected` conditional class → no blue highlight on the selected row.

## Design

### Approach

**Approach A — Minimal fix, no type changes.** Fix the four gaps. Add `isImported?: boolean` prop to `AircraftDetailsPanel` for the "IMPORTED" badge. No changes to `AircraftTrack` type or Rust backend.

### Changes

#### 1. `page.tsx` — Fix `selectedTrack` lookup and auto-deselect

Add `visibleImported` as the third search source in the `selectedTrack` memo:

```ts
const selectedTrack = useMemo(
  () =>
    allTracks.find(t => t.hex_ident === selectedHexIdent) ??
    visibleHistory.find(t => t.hex_ident === selectedHexIdent) ??
    visibleImported.find(t => t.hex_ident === selectedHexIdent) ??  // new
    null,
  [selectedHexIdent, allTracks, visibleHistory, visibleImported],
);
```

Auto-deselect effect — also check `visibleImported`:
```ts
const exists =
  allTracks.some(t => t.hex_ident === selectedHexIdent) ||
  visibleHistory.some(t => t.hex_ident === selectedHexIdent) ||
  visibleImported.some(t => t.hex_ident === selectedHexIdent);  // new
```

Derive `isImportedSelection` and pass to panel:
```ts
const isImportedSelection = visibleImported.some(t => t.hex_ident === selectedHexIdent);
// ...
<AircraftDetailsPanel ... isImported={isImportedSelection} />
```

#### 2. `AircraftDetailsPanel.tsx` — Add `isImported?: boolean` prop + badge

Add prop to `Props` and `ExpandedPanel`. In the header row, show a small indigo `IMPORTED` badge when `isImported === true`:

```tsx
<span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
  Aircraft Details
</span>
{isImported && (
  <span className="ml-2 px-1 py-0.5 text-[9px] font-bold rounded bg-indigo-800/60 text-indigo-300 leading-none uppercase tracking-wide">
    IMPORTED
  </span>
)}
```

#### 3. `MapInner.tsx` — Fix imported `DotsLayer` `selectedHexIdent`

Per DESIGN.md Decision 7, dots are not clickable for selection. Fix is visual only:

```tsx
// Before:
<DotsLayer tracks={importedTracks} colorMode="plot" type="imported" selectedHexIdent={null} />
// After:
<DotsLayer tracks={importedTracks} colorMode="plot" type="imported" selectedHexIdent={selectedHexIdent} />
```

#### 4. `MapInner.tsx` — Add `onClick` + selection emphasis to imported `Polyline`

Imported tracks have no marker icons (unlike live tracks), making their Polylines the only interactive map surface. Add click handler and selection emphasis:

```tsx
{trajectoryStyle === "line" && importedTracks.map((t) => {
  if (t.positions.length < 2) return null;
  const isSelected = t.hex_ident === selectedHexIdent;
  return (
    <Polyline
      key={`imported-${t.hex_ident}`}
      positions={toLatLngs(t.positions)}
      pathOptions={{
        color: "#818cf8",
        weight: isSelected ? 3 : 2,
        opacity: isSelected ? 0.8 : 0.5,
        dashArray: isSelected ? undefined : "6 4",
      }}
      eventHandlers={{ click: () => onSelectTrack(t.hex_ident) }}
    >
      ...
    </Polyline>
  );
})}
```

#### 5. `AircraftTable.tsx` — Add selected highlight to imported rows

Add `isSelected` check (mirrors live/history row patterns), using indigo accent to maintain imported visual identity:

```tsx
const isSelected = t.hex_ident === selectedHexIdent;
className={`border-b border-slate-800 ${
  isSelected
    ? "bg-indigo-900/40 hover:bg-indigo-900/50"
    : "hover:bg-slate-800/50 opacity-60"
}${onSelectTrack ? " cursor-pointer" : ""}`}
```

### Alignment with DESIGN.md

| Design Principle | Alignment |
|-----------------|-----------|
| Decision 7: No click handlers on dots | ✅ DotsLayer fix is visual only (no `onClick`) |
| Polyline clicks for imported | ✅ Justified — imported tracks have no marker icons |
| `selectedTrack` lookup | ✅ Extends existing pattern to include `visibleImported` |
| `isImported` prop | ✅ Optional prop, minimal surface, page-level concern |
| State in `page.tsx` | ✅ Consistent with existing `selectedHexIdent` pattern |

### Testing

- **`AircraftDetailsPanel.test.tsx`**: Add test — `isImported={true}` renders IMPORTED badge; `isImported={false}` does not.
- **`AircraftTable.test.tsx`**: Add test — imported selected row has `bg-indigo-900/40` class; unselected retains `opacity-60`.
- **`MapInner.tsx`**: Not tested (per DESIGN.md — Leaflet DOM mocking excluded).
- **`page.tsx`**: Integration — covered implicitly by the above component tests.

### Files Changed

| File | Change |
|------|--------|
| `src/app/page.tsx` | `selectedTrack` lookup + auto-deselect + `isImportedSelection` |
| `src/components/AircraftDetailsPanel.tsx` | `isImported` prop + badge |
| `src/components/MapInner.tsx` | DotsLayer `selectedHexIdent`, Polyline click + emphasis |
| `src/components/AircraftTable.tsx` | Imported row selected highlight |
| `src/components/__tests__/AircraftDetailsPanel.test.tsx` | Badge test |
| `src/components/__tests__/AircraftTable.test.tsx` | Imported row highlight test |
