# Imported Tracks: Selection & Aircraft Details Panel — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix four independent gaps so that imported GeoJSON tracks can be selected and displayed in the Aircraft Details panel, with consistent visual feedback across the map, table, and panel.

**Architecture:** `selectedHexIdent` is managed in `page.tsx` and passed down to all consumers. Fix the `selectedTrack` lookup to include `visibleImported`, propagate real `selectedHexIdent` to the imported `DotsLayer`, add click + emphasis to imported `Polyline` elements, and add `isSelected` highlight to imported table rows. Add `isImported?: boolean` to `AircraftDetailsPanel` for an IMPORTED badge.

**Tech Stack:** React 19, Next.js 15, TypeScript, Leaflet/react-leaflet, Vitest, @testing-library/react

---

## Reference

- Design doc: `docs/plans/2026-02-22-imported-tracks-selection-design.md`
- Main DESIGN.md: `docs/DESIGN.md` (Bidirectional Track Selection section, Decision 7)
- Test runner: `npm test` (all), `npx vitest run src/components/__tests__/AircraftDetailsPanel.test.tsx` (single file)
- All tests must stay green after each task: `npm test`

---

### Task 1: AircraftDetailsPanel — add `isImported` prop and IMPORTED badge

**Files:**
- Modify: `src/components/AircraftDetailsPanel.tsx`
- Modify: `src/components/__tests__/AircraftDetailsPanel.test.tsx`

**Context:** The panel renders three sub-components: `AircraftDetailsPanel` (gate), `ExpandedPanel` (full content), `CollapsedStrip` (32px). The `isImported` flag only needs to reach `ExpandedPanel`'s header row.

**Step 1: Write the failing tests**

Open `src/components/__tests__/AircraftDetailsPanel.test.tsx`. Add two tests at the end of the describe block (after the existing sparkline/axes tests):

```tsx
it("shows IMPORTED badge when isImported is true", () => {
  render(
    <AircraftDetailsPanel
      track={makeTrack({ positions: [] })}
      isOpen={true}
      width={280}
      onToggle={vi.fn()}
      onWidthChange={vi.fn()}
      isImported={true}
    />,
  );
  expect(screen.getByText("IMPORTED")).toBeInTheDocument();
});

it("does not show IMPORTED badge when isImported is false", () => {
  render(
    <AircraftDetailsPanel
      track={makeTrack({ positions: [] })}
      isOpen={true}
      width={280}
      onToggle={vi.fn()}
      onWidthChange={vi.fn()}
      isImported={false}
    />,
  );
  expect(screen.queryByText("IMPORTED")).not.toBeInTheDocument();
});
```

> **Note:** Check the existing test file for the `makeTrack` helper signature — it builds a minimal `AircraftTrack`. Use the same shape.

**Step 2: Run tests to verify they fail**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/components/__tests__/AircraftDetailsPanel.test.tsx
```

Expected: 2 failures — `isImported` not accepted / badge not rendered.

**Step 3: Add `isImported` prop to the component**

In `src/components/AircraftDetailsPanel.tsx`:

1. Add to `Props` interface (line ~25):
```tsx
interface Props {
  track: AircraftTrack | null;
  isOpen: boolean;
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
  isImported?: boolean;  // ← add
}
```

2. Destructure in `AircraftDetailsPanel` and thread to `ExpandedPanel` (line ~33–52):
```tsx
export function AircraftDetailsPanel({
  track,
  isOpen,
  width,
  onToggle,
  onWidthChange,
  isImported = false,  // ← add
}: Props) {
  if (track === null) return null;

  return isOpen ? (
    <ExpandedPanel
      track={track}
      width={width}
      onToggle={onToggle}
      onWidthChange={onWidthChange}
      isImported={isImported}  // ← add
    />
  ) : (
    <CollapsedStrip onToggle={onToggle} />
  );
}
```

3. Add `isImported` to `ExpandedPanel`'s props signature (line ~71–80):
```tsx
function ExpandedPanel({
  track,
  width,
  onToggle,
  onWidthChange,
  isImported = false,  // ← add
}: {
  track: AircraftTrack;
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
  isImported?: boolean;  // ← add
}) {
```

4. In the header row (find the `<span>Aircraft Details</span>` line, ~line 138), add the badge inline after it:
```tsx
<div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 flex-shrink-0">
  <div className="flex items-center gap-2">
    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
      Aircraft Details
    </span>
    {isImported && (
      <span className="px-1 py-0.5 text-[9px] font-bold rounded bg-indigo-800/60 text-indigo-300 leading-none uppercase tracking-wide">
        IMPORTED
      </span>
    )}
  </div>
  <button
    onClick={onToggle}
    title="Fold panel"
    className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition text-xs font-mono"
  >
    {"<<"}
  </button>
</div>
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/__tests__/AircraftDetailsPanel.test.tsx
```

Expected: all pass (previously passing tests + 2 new ones).

**Step 5: Run full test suite to verify nothing broken**

```bash
npm test
```

Expected: all pass.

---

### Task 2: AircraftTable — add selected highlight to imported rows

**Files:**
- Modify: `src/components/AircraftTable.tsx`
- Modify: `src/components/__tests__/AircraftTable.test.tsx`

**Context:** Live rows use `bg-blue-900/40` when selected, removing `opacity-40`. History rows do the same. Imported rows currently have a fixed `opacity-60` class — no `isSelected` branch at all. We'll use indigo accent to maintain the imported visual identity.

**Step 1: Write the failing test**

Open `src/components/__tests__/AircraftTable.test.tsx`. Find the imported tracks describe block (or add one). Add:

```tsx
it("highlights selected imported row with indigo background", () => {
  const importedTrack = makeTrack({ hex_ident: "IMP001", callsign: "TEST01" });
  render(
    <AircraftTable
      tracks={[]}
      importedTracks={[importedTrack]}
      selectedHexIdent="IMP001"
      onSelectTrack={vi.fn()}
    />,
  );
  const row = screen.getByTestId("row-imported-IMP001");
  expect(row.className).toContain("bg-indigo-900/40");
  expect(row.className).not.toContain("opacity-60");
});

it("keeps opacity-60 on unselected imported row", () => {
  const importedTrack = makeTrack({ hex_ident: "IMP002", callsign: "TEST02" });
  render(
    <AircraftTable
      tracks={[]}
      importedTracks={[importedTrack]}
      selectedHexIdent={null}
      onSelectTrack={vi.fn()}
    />,
  );
  const row = screen.getByTestId("row-imported-IMP002");
  expect(row.className).toContain("opacity-60");
  expect(row.className).not.toContain("bg-indigo-900/40");
});
```

> **Note:** Check existing test file for the `makeTrack` helper and existing import patterns. The `data-testid` for imported rows is `row-imported-${hex_ident}` (already in the component at line ~240).

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/__tests__/AircraftTable.test.tsx
```

Expected: 2 failures — imported row always has `opacity-60`.

**Step 3: Fix the imported rows in AircraftTable**

In `src/components/AircraftTable.tsx`, find the imported rows map (line ~238). Add `isSelected` logic:

```tsx
{!importedCollapsed && sortedImported.map((t) => {
  const isSelected = t.hex_ident === selectedHexIdent;  // ← add
  return (
    <tr
      key={`imported-${t.hex_ident}`}
      data-testid={`row-imported-${t.hex_ident}`}
      data-hex={t.hex_ident}
      onClick={() => onSelectTrack?.(t.hex_ident)}
      className={`border-b border-slate-800 ${
        isSelected
          ? "bg-indigo-900/40 hover:bg-indigo-900/50"
          : "hover:bg-slate-800/50 opacity-60"
      }${onSelectTrack ? " cursor-pointer" : ""}`}
    >
```

> The rest of the row cells stay unchanged.

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/__tests__/AircraftTable.test.tsx
```

Expected: all pass.

**Step 5: Run full test suite**

```bash
npm test
```

Expected: all pass.

---

### Task 3: MapInner — fix DotsLayer `selectedHexIdent` for imported tracks

**Files:**
- Modify: `src/components/MapInner.tsx`

**Context:** Per DESIGN.md Decision 7, dots are not clickable. This fix is purely **visual** — passing the real `selectedHexIdent` so selected imported dots get the enlarged radius and higher fill opacity (already implemented in `DotsLayer`'s render loop via `isSelected` branch). No click handlers added.

**No new test** — `MapInner.tsx` is excluded from testing per DESIGN.md (Leaflet DOM mocking not worth it).

**Step 1: Find and fix the hardcoded null**

In `src/components/MapInner.tsx`, find the DotsLayer for imported tracks (line ~304):

```tsx
{trajectoryStyle === "dots" && importedTracks.length > 0 && (
  <DotsLayer tracks={importedTracks} colorMode="plot" type="imported" selectedHexIdent={null} />
)}
```

Change to:

```tsx
{trajectoryStyle === "dots" && importedTracks.length > 0 && (
  <DotsLayer tracks={importedTracks} colorMode="plot" type="imported" selectedHexIdent={selectedHexIdent} />
)}
```

**Step 2: Run full test suite to verify nothing broken**

```bash
npm test
```

Expected: all pass.

---

### Task 4: MapInner — add click + selection emphasis to imported Polylines

**Files:**
- Modify: `src/components/MapInner.tsx`

**Context:** Imported tracks have no marker icons (unlike live tracks), making their Polylines the only interactive surface on the map in "line" mode. Adding `onClick` is consistent with the existing live/history Polyline pattern. Selection emphasis: `weight: 3` (vs 2), `opacity: 0.8` (vs 0.5), no `dashArray` when selected.

**No new test** — `MapInner.tsx` excluded from testing per DESIGN.md.

**Step 1: Update the imported Polyline section**

In `src/components/MapInner.tsx`, find the imported Polyline map (line ~307):

```tsx
{trajectoryStyle === "line" && importedTracks.map((t) => {
  if (t.positions.length < 2) return null;
  return (
    <Polyline
      key={`imported-${t.hex_ident}`}
      positions={toLatLngs(t.positions)}
      pathOptions={{
        color: "#818cf8",
        weight: 2,
        opacity: 0.5,
        dashArray: "6 4",
      }}
    >
```

Replace with:

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
```

> The `<Tooltip>` children stay unchanged.

**Step 2: Run full test suite to verify nothing broken**

```bash
npm test
```

Expected: all pass.

---

### Task 5: page.tsx — fix selectedTrack lookup, auto-deselect, and isImportedSelection

**Files:**
- Modify: `src/app/page.tsx`

**Context:** This is the orchestrating fix that makes the panel actually mount when an imported track is selected. Three sub-changes in the same file — do them all in one edit.

**No new test** — this is integration wiring; covered by the component tests above (panel renders when `track` is non-null, which now resolves for imported tracks).

**Step 1: Fix `selectedTrack` useMemo**

Find the `selectedTrack` memo (line ~54):

```ts
const selectedTrack = useMemo(
  () =>
    allTracks.find(t => t.hex_ident === selectedHexIdent) ??
    visibleHistory.find(t => t.hex_ident === selectedHexIdent) ??
    null,
  [selectedHexIdent, allTracks, visibleHistory],
);
```

Replace with:

```ts
const selectedTrack = useMemo(
  () =>
    allTracks.find(t => t.hex_ident === selectedHexIdent) ??
    visibleHistory.find(t => t.hex_ident === selectedHexIdent) ??
    visibleImported.find(t => t.hex_ident === selectedHexIdent) ??
    null,
  [selectedHexIdent, allTracks, visibleHistory, visibleImported],
);
```

**Step 2: Fix auto-deselect effect**

Find the auto-deselect `useEffect` (line ~68):

```ts
useEffect(() => {
  if (!selectedHexIdent) return;
  const exists = allTracks.some(t => t.hex_ident === selectedHexIdent)
    || visibleHistory.some(t => t.hex_ident === selectedHexIdent);
  if (!exists) setSelectedHexIdent(null);
}, [selectedHexIdent, allTracks, visibleHistory]);
```

Replace with:

```ts
useEffect(() => {
  if (!selectedHexIdent) return;
  const exists =
    allTracks.some(t => t.hex_ident === selectedHexIdent) ||
    visibleHistory.some(t => t.hex_ident === selectedHexIdent) ||
    visibleImported.some(t => t.hex_ident === selectedHexIdent);
  if (!exists) setSelectedHexIdent(null);
}, [selectedHexIdent, allTracks, visibleHistory, visibleImported]);
```

**Step 3: Derive `isImportedSelection` and pass to `AircraftDetailsPanel`**

Add the derived boolean after the auto-deselect effect:

```ts
const isImportedSelection = visibleImported.some(t => t.hex_ident === selectedHexIdent);
```

Then find the `AircraftDetailsPanel` render (line ~275) and add the prop:

```tsx
{selectedTrack && (
  <AircraftDetailsPanel
    track={selectedTrack}
    isOpen={detailsPanelOpen}
    width={detailsPanelWidth}
    onToggle={() => setDetailsPanelOpen((p: boolean) => !p)}
    onWidthChange={setDetailsPanelWidth}
    isImported={isImportedSelection}
  />
)}
```

**Step 4: Run full test suite**

```bash
npm test
```

Expected: all pass.

---

### Task 6: Final verification

**Step 1: Run full CI gate**

```bash
cd adsb-pulsar-client-desktop
npm test && npx next lint
```

Expected: all tests pass, no lint errors.

**Step 2: TypeScript type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

**Step 3: Manual smoke test (optional, if Tauri dev available)**

```bash
npm run tauri dev
```

Verify:
1. Import a GeoJSON file with tracks
2. Click an imported row in the table → panel opens with IMPORTED badge
3. Click an imported polyline on the map (line mode) → panel opens
4. Dots mode: select an imported track via table → dots get visual emphasis on map
5. Click same row again → deselects
6. Click empty map space → deselects

---

## Summary

| Task | File(s) | Tests |
|------|---------|-------|
| 1 | `AircraftDetailsPanel.tsx` | 2 new: badge renders/hides |
| 2 | `AircraftTable.tsx` | 2 new: imported row selected/unselected |
| 3 | `MapInner.tsx` | None (Leaflet excluded) |
| 4 | `MapInner.tsx` | None (Leaflet excluded) |
| 5 | `page.tsx` | None (wiring, covered by above) |
| 6 | CI gate | Full suite |

**Total new tests:** 4
**Files changed:** 5
