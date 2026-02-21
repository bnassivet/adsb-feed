# Design: Resizable Left Panel with Toggle

**Date**: 2026-02-20
**Status**: Approved

## Problem

The left sidebar (filters panel) currently has only two states: fully visible or completely removed from the DOM. It has no collapsed strip, no drag-to-resize, and its toggle button lives only in the header. This is inconsistent with the `AircraftDetailsPanel` (right panel), which already implements the three-state collapsible + resizable pattern.

## Goal

Give the left sidebar the same UX pattern as the right panel:
- A narrow 32px collapsed strip with `>>` button
- A full expanded view with `<<` button and draggable right edge for resizing
- Both the header icon and the panel strip toggle the sidebar

## Design

### State

| Key | Type | Default | Storage |
|-----|------|---------|---------|
| `adsb-sidebar-open` | `boolean` | `true` | `useLocalStorage` (existing) |
| `adsb-sidebar-width` | `number` | `224` | `useLocalStorage` (new) |

Width range: **180–400px**

### New Component: `src/components/LeftPanel.tsx`

Wraps `FiltersPanel` with the three-state layout:

```
LeftPanel
├── CollapsedStrip (isOpen=false)
│   └── ">>" button — centered vertically, calls onToggle
└── ExpandedPanel (isOpen=true)
    ├── Content area (FiltersPanel + all filter props forwarded)
    │   └── Header: "Filters" label + "<<" button → calls onToggle
    └── ResizeEdge — 1px right-edge strip, col-resize cursor
```

**Props interface**:
```ts
interface LeftPanelProps {
  isOpen: boolean;
  width: number;
  onToggle: () => void;
  onWidthChange: (w: number) => void;
  // All FiltersPanel props forwarded
}
```

**Resize mechanics**: Same as `AircraftDetailsPanel` but mirrored — dragging right edge uses `delta = e.clientX - lastX` (positive = expand), clamped to [180, 400].

### Changes to `page.tsx`

1. Add `sidebarWidth` state: `useLocalStorage<number>("adsb-sidebar-width", 224)`
2. Replace the `{sidebarOpen && <aside>}` block with:
   ```tsx
   <LeftPanel
     isOpen={sidebarOpen}
     width={sidebarWidth}
     onToggle={() => setSidebarOpen(prev => !prev)}
     onWidthChange={setSidebarWidth}
     {/* all FiltersPanel props */}
   />
   ```
3. The existing header icon button remains unchanged (already calls `setSidebarOpen` toggle)

### Testing

New file: `src/components/__tests__/LeftPanel.test.tsx`

| Test | What |
|------|------|
| Renders collapsed strip | `isOpen=false` → 32px div, `>>` button visible |
| Renders expanded panel | `isOpen=true` → content + `<<` button |
| `>>` calls `onToggle` | Click `>>` → `onToggle` called once |
| `<<` calls `onToggle` | Click `<<` → `onToggle` called once |
| Width applied when expanded | `width=300` → inline style `width: 300px` |
| Drag clamps to min width | `onWidthChange` never receives value < 180 |
| Drag clamps to max width | `onWidthChange` never receives value > 400 |

## Alternatives Considered

- **Inline in `page.tsx`**: Simpler but bloats the page component; harder to test.
- **CSS animation only, no resize**: Quickest but doesn't meet the resize requirement.
