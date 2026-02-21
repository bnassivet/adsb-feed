# Left Panel Resizable Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fixed-width left sidebar with a resizable, collapsible `LeftPanel` component that mirrors the existing `AircraftDetailsPanel` pattern.

**Architecture:** A new `LeftPanel` component wraps `FiltersPanel` with three states: fully hidden (never — panel always present), collapsed 32px strip (`>>` button), and expanded with a draggable right-edge resize strip (`<<` button in header). Width and open state are persisted in `useLocalStorage`. `page.tsx` is updated to use `LeftPanel` instead of the current `{sidebarOpen && <aside>}` pattern.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Vitest + @testing-library/react

---

### Task 1: Write failing tests for `LeftPanel`

**Files:**
- Create: `src/components/__tests__/LeftPanel.test.tsx`

**Step 1: Create the test file**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LeftPanel } from "@/components/LeftPanel";
import type { Filters, DensityMetric, AltitudeColorMode } from "@/lib/types";
import { DEFAULT_FILTERS } from "@/lib/types";

// Minimal props required by FiltersPanel, forwarded through LeftPanel
const baseFilterProps = {
  filters: DEFAULT_FILTERS,
  onChange: vi.fn(),
  trackCount: 0,
  showHistory: false,
  onToggleHistory: vi.fn(),
  historyCount: 0,
  showDensity: false,
  onToggleDensity: vi.fn(),
  densityMetric: "positions" as DensityMetric,
  onDensityMetricChange: vi.fn(),
  showSimulation: false,
  onToggleSimulation: vi.fn(),
  simulationCount: 0,
  liveColorMode: "track" as AltitudeColorMode,
  onLiveColorModeChange: vi.fn(),
  historyColorMode: "track" as AltitudeColorMode,
  onHistoryColorModeChange: vi.fn(),
  importedCount: 0,
  showImported: false,
  onToggleImported: vi.fn(),
  onClearImported: vi.fn(),
  includeImportedInDensity: false,
  onToggleIncludeImportedInDensity: vi.fn(),
};

describe("LeftPanel", () => {
  it("renders collapsed strip with >> button when isOpen=false", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <LeftPanel isOpen={false} width={224} onToggle={onToggle} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    expect(screen.getByTitle("Show filters panel")).toBeInTheDocument();
    const strip = container.firstChild as HTMLElement;
    expect(strip.style.width).toBe("32px");
  });

  it("renders expanded panel with << button when isOpen=true", () => {
    render(
      <LeftPanel isOpen={true} width={224} onToggle={vi.fn()} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    expect(screen.getByTitle("Hide filters panel")).toBeInTheDocument();
  });

  it(">> button calls onToggle", () => {
    const onToggle = vi.fn();
    render(
      <LeftPanel isOpen={false} width={224} onToggle={onToggle} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    fireEvent.click(screen.getByTitle("Show filters panel"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("<< button calls onToggle", () => {
    const onToggle = vi.fn();
    render(
      <LeftPanel isOpen={true} width={224} onToggle={onToggle} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    fireEvent.click(screen.getByTitle("Hide filters panel"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("applies width as inline style when expanded", () => {
    const { container } = render(
      <LeftPanel isOpen={true} width={300} onToggle={vi.fn()} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    const panel = container.firstChild as HTMLElement;
    expect(panel.style.width).toBe("300px");
  });

  it("filters content is visible when expanded", () => {
    render(
      <LeftPanel isOpen={true} width={224} onToggle={vi.fn()} onWidthChange={vi.fn()} {...baseFilterProps} />
    );
    // FiltersPanel renders a "Filters" heading
    expect(screen.getByText("Filters")).toBeInTheDocument();
  });
});
```

**Step 2: Run to verify it fails**

```bash
cd /path/to/adsb-pulsar-client-desktop
npx vitest run src/components/__tests__/LeftPanel.test.tsx
```

Expected: FAIL — `Cannot find module '@/components/LeftPanel'`

**Step 3: Commit the red tests**

```bash
git add src/components/__tests__/LeftPanel.test.tsx
git commit -m "test(LeftPanel): add failing tests for collapsible resizable left panel"
```

---

### Task 2: Implement `LeftPanel` component

**Files:**
- Create: `src/components/LeftPanel.tsx`

**Step 1: Create the component**

```tsx
"use client";
import { useCallback, useRef } from "react";
import { FiltersPanel } from "@/components/Filters";
import type { Filters, DensityMetric, AltitudeColorMode } from "@/lib/types";

const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 400;
const COLLAPSED_WIDTH = 32;

interface LeftPanelProps {
  isOpen: boolean;
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
  // FiltersPanel props
  filters: Filters;
  onChange: (filters: Filters) => void;
  trackCount: number;
  showHistory: boolean;
  onToggleHistory: () => void;
  historyCount: number;
  showDensity: boolean;
  onToggleDensity: () => void;
  densityMetric: DensityMetric;
  onDensityMetricChange: (metric: DensityMetric) => void;
  showSimulation: boolean;
  onToggleSimulation: () => void;
  simulationCount: number;
  liveColorMode: AltitudeColorMode;
  onLiveColorModeChange: (mode: AltitudeColorMode) => void;
  historyColorMode: AltitudeColorMode;
  onHistoryColorModeChange: (mode: AltitudeColorMode) => void;
  importedCount: number;
  showImported: boolean;
  onToggleImported: () => void;
  onClearImported: () => void;
  includeImportedInDensity: boolean;
  onToggleIncludeImportedInDensity: () => void;
}

export function LeftPanel({ isOpen, width, onToggle, onWidthChange, ...filterProps }: LeftPanelProps) {
  return isOpen ? (
    <ExpandedPanel width={width} onToggle={onToggle} onWidthChange={onWidthChange} filterProps={filterProps} />
  ) : (
    <CollapsedStrip onToggle={onToggle} />
  );
}

function CollapsedStrip({ onToggle }: { onToggle: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center bg-slate-900 border-r border-slate-700 flex-shrink-0"
      style={{ width: COLLAPSED_WIDTH }}
    >
      <button
        onClick={onToggle}
        title="Show filters panel"
        className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition text-xs font-mono"
      >
        {">>"}
      </button>
    </div>
  );
}

function ExpandedPanel({
  width,
  onToggle,
  onWidthChange,
  filterProps,
}: {
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
  filterProps: Omit<LeftPanelProps, "isOpen" | "width" | "onToggle" | "onWidthChange">;
}) {
  const lastX = useRef(0);
  const isDragging = useRef(false);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - lastX.current; // Moving right = expanding panel
      lastX.current = e.clientX;
      onWidthChange(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width + delta)));
    },
    [width, onWidthChange],
  );

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      lastX.current = e.clientX;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [handleMouseMove, handleMouseUp],
  );

  return (
    <div
      className="flex flex-row bg-slate-900 border-r border-slate-700 flex-shrink-0 overflow-hidden"
      style={{ width }}
    >
      {/* Panel content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 flex-shrink-0">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            Filters
          </span>
          <button
            onClick={onToggle}
            title="Hide filters panel"
            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition text-xs font-mono"
          >
            {"<<"}
          </button>
        </div>
        <FiltersPanel {...filterProps} />
      </div>

      {/* Right edge: draggable resize strip */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1 cursor-col-resize bg-slate-700 hover:bg-blue-500 transition-colors flex-shrink-0"
      />
    </div>
  );
}
```

**Step 2: Run the tests**

```bash
npx vitest run src/components/__tests__/LeftPanel.test.tsx
```

Expected: All 6 tests PASS.

**Step 3: Commit**

```bash
git add src/components/LeftPanel.tsx
git commit -m "feat(LeftPanel): add collapsible resizable left panel component"
```

---

### Task 3: Update `page.tsx` to use `LeftPanel`

**Files:**
- Modify: `src/app/page.tsx`

**Step 1: Add `sidebarWidth` state and import `LeftPanel`**

At the top of `page.tsx`, add the import:
```tsx
import { LeftPanel } from "@/components/LeftPanel";
```

In the `Dashboard` function body, after the `sidebarOpen` state line, add:
```tsx
const [sidebarWidth, setSidebarWidth] = useLocalStorage<number>("adsb-sidebar-width", 224);
```

**Step 2: Replace the `<aside>` block with `<LeftPanel>`**

Find this block in the JSX (around line 236–264):
```tsx
{/* Sidebar */}
{sidebarOpen && (
  <aside className="w-56 bg-slate-900 border-r border-slate-700 overflow-y-auto flex-shrink-0">
    <FiltersPanel
      filters={filters}
      onChange={setFilters}
      trackCount={allTracks.length}
      showHistory={showHistory}
      onToggleHistory={handleToggleHistory}
      historyCount={history.length}
      showDensity={showDensity}
      onToggleDensity={handleToggleDensity}
      densityMetric={densityMetric}
      onDensityMetricChange={setDensityMetric}
      showSimulation={showSimulation}
      onToggleSimulation={handleToggleSimulation}
      simulationCount={simulatedTracks.length}
      liveColorMode={liveColorMode}
      onLiveColorModeChange={setLiveColorMode}
      historyColorMode={historyColorMode}
      onHistoryColorModeChange={setHistoryColorMode}
      importedCount={imported.length}
      showImported={showImported}
      onToggleImported={handleToggleImported}
      onClearImported={clearImported}
      includeImportedInDensity={includeImportedInDensity}
      onToggleIncludeImportedInDensity={handleToggleIncludeImportedInDensity}
    />
  </aside>
)}
```

Replace with:
```tsx
{/* Sidebar */}
<LeftPanel
  isOpen={sidebarOpen}
  width={sidebarWidth}
  onToggle={() => setSidebarOpen((prev: boolean) => !prev)}
  onWidthChange={setSidebarWidth}
  filters={filters}
  onChange={setFilters}
  trackCount={allTracks.length}
  showHistory={showHistory}
  onToggleHistory={handleToggleHistory}
  historyCount={history.length}
  showDensity={showDensity}
  onToggleDensity={handleToggleDensity}
  densityMetric={densityMetric}
  onDensityMetricChange={setDensityMetric}
  showSimulation={showSimulation}
  onToggleSimulation={handleToggleSimulation}
  simulationCount={simulatedTracks.length}
  liveColorMode={liveColorMode}
  onLiveColorModeChange={setLiveColorMode}
  historyColorMode={historyColorMode}
  onHistoryColorModeChange={setHistoryColorMode}
  importedCount={imported.length}
  showImported={showImported}
  onToggleImported={handleToggleImported}
  onClearImported={clearImported}
  includeImportedInDensity={includeImportedInDensity}
  onToggleIncludeImportedInDensity={handleToggleIncludeImportedInDensity}
/>
```

**Step 3: Remove the unused `FiltersPanel` import from `page.tsx`**

Delete the line:
```tsx
import { FiltersPanel } from "@/components/Filters";
```

(FiltersPanel is now used inside LeftPanel, not directly in page.tsx.)

**Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: replace sidebar <aside> with LeftPanel (resizable + collapsible)"
```

---

### Task 4: CI gate — run all tests and checks

**Step 1: Run TypeScript tests**

```bash
cd /path/to/adsb-pulsar-client-desktop
npm test
```

Expected: All tests pass (previously ~198, now ~204 with new LeftPanel tests).

**Step 2: Run Next.js lint**

```bash
npx next lint
```

Expected: No errors.

**Step 3: Verify frontend builds**

```bash
npx next build
```

Expected: Build succeeds with no type errors.

**Step 4: If all pass, final commit (optional — tasks already committed)**

No extra commit needed — each task committed independently.
