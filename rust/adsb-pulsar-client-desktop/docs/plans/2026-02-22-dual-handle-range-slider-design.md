# Dual-Handle Range Slider for Altitude & Speed Filters

**Date:** 2026-02-22
**Status:** Approved
**Branch:** feature/enhancements

## Overview

Replace the two independent `<input type="range">` sliders (one for min, one for max) in the altitude and speed filter rows with a single dual-handle slider. Both handles live on one track; min cannot exceed max (and vice versa).

## Approach

Two stacked native `<input type="range">` elements with CSS overlay for the filled range. No new dependencies — keyboard accessibility and pointer handling are provided by the browser.

## Component: `RangeSlider` (`src/components/RangeSlider.tsx`)

```typescript
interface RangeSliderProps {
  min: number;                          // absolute minimum of the range
  max: number;                          // absolute maximum of the range
  step: number;
  valueMin: number;                     // current low-handle value
  valueMax: number;                     // current high-handle value
  onChange: (min: number, max: number) => void;
  formatLabel: (v: number) => string;   // e.g. v => `${v.toLocaleString()} ft`
}
```

### Visual structure

```
Label: 1,000 - 40,000 ft
[━━━●━━━━━━━━━━━━━━━━━●━━━]
```

- One `<div>` as the grey track background
- One `<div>` as the blue fill, positioned with:
  - `left: ${(valueMin / max) * 100}%`
  - `width: ${((valueMax - valueMin) / max) * 100}%`
- Two `<input type="range">` absolutely positioned on top, thumb visible, track transparent

### Clamping

- Min handler output: `Math.min(newValue, valueMax - step)`
- Max handler output: `Math.max(newValue, valueMin + step)`

Handles can never cross — min is always at least one step below max.

## Integration in `Filters.tsx`

Replace both altitude and speed two-slider rows with `<RangeSlider>`:

```tsx
<RangeSlider
  min={0} max={50000} step={1000}
  valueMin={filters.altitudeMin} valueMax={filters.altitudeMax}
  onChange={(lo, hi) => onChange({ ...filters, altitudeMin: lo, altitudeMax: hi })}
  formatLabel={(v) => `${v.toLocaleString()} ft`}
/>

<RangeSlider
  min={0} max={600} step={10}
  valueMin={filters.speedMin} valueMax={filters.speedMax}
  onChange={(lo, hi) => onChange({ ...filters, speedMin: lo, speedMax: hi })}
  formatLabel={(v) => `${v} kts`}
/>
```

The label `"Altitude: X - Y ft"` is rendered inside the component from `formatLabel(valueMin)` and `formatLabel(valueMax)`.

## Testing

### New: `src/components/__tests__/RangeSlider.test.tsx`

| Test | Expected |
|------|----------|
| Renders label with formatted min and max | label shows both values |
| Moving min input calls onChange with new min, unchanged max | correct pair |
| Moving max input calls onChange with unchanged min, new max | correct pair |
| Min clamped to `valueMax - step` when user drags past max | clamped value in onChange |
| Max clamped to `valueMin + step` when user drags past min | clamped value in onChange |
| formatLabel applied to label display | label uses formatted string |

### Updated: `src/components/__tests__/Filters.test.tsx`

- Remove tests that query altitude/speed inputs by individual min/max slider roles (those sliders no longer exist as separate elements)
- Add smoke test that altitude and speed sections render with expected label text

## Files to Touch

| File | Change |
|------|--------|
| `src/components/RangeSlider.tsx` | Create new component |
| `src/components/__tests__/RangeSlider.test.tsx` | Create tests |
| `src/components/Filters.tsx` | Replace altitude/speed two-slider rows with RangeSlider |
| `src/components/__tests__/Filters.test.tsx` | Update or remove stale slider tests |
