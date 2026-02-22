# Filter Enhancement: Multi-ID List + Include Imported

**Date:** 2026-02-22
**Status:** Approved
**Branch:** feature/enhancements

## Overview

Enhance the Callsign / Hex filter to accept a comma-separated list of identifiers, and add an "Include Imported in filter" toggle so the same filter can be applied to imported tracks.

## Requirements

1. **Multi-ID input**: The Callsign / Hex text field accepts one or more tokens separated by commas (e.g., `AAL123, BAW`). A track passes the filter if **any** token is a case-insensitive substring of its callsign or hex_ident.
2. **Include Imported in filter**: A new checkbox visible when imported tracks exist. When checked, the Callsign / Hex filter is also applied to imported tracks (within the already-visible imported layer). When unchecked, imported tracks are shown unfiltered (existing behaviour).

## Design

### Types (`src/lib/types.ts`)

Add one field to `Filters`:

```typescript
export interface Filters {
  callsign: string;                  // raw input string, may contain commas
  altitudeMin: number;
  altitudeMax: number;
  speedMin: number;
  speedMax: number;
  includeImportedInFilter: boolean;  // NEW: apply callsign filter to imported tracks
}

export const DEFAULT_FILTERS: Filters = {
  callsign: "",
  altitudeMin: 0,
  altitudeMax: 50000,
  speedMin: 0,
  speedMax: 600,
  includeImportedInFilter: false,
};
```

### Filter Logic (`src/hooks/useAircraftTracks.ts`)

`matchesFilters` splits on comma, trims tokens, and ORs substring checks:

```typescript
export function matchesFilters(t: AircraftTrack, filters: Filters): boolean {
  if (filters.callsign) {
    const tokens = filters.callsign
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length > 0) {
      const id = t.hex_ident.toLowerCase();
      const cs = (t.callsign ?? "").toLowerCase();
      const matches = tokens.some((tok) => cs.includes(tok) || id.includes(tok));
      if (!matches) return false;
    }
  }
  if (t.altitude !== null) {
    if (t.altitude < filters.altitudeMin || t.altitude > filters.altitudeMax) return false;
  }
  if (t.ground_speed !== null) {
    if (t.ground_speed < filters.speedMin || t.ground_speed > filters.speedMax) return false;
  }
  return true;
}
```

`imported` memo in `useAircraftTracks` becomes conditional:

```typescript
const imported = useMemo(
  () => {
    const all = Array.from(importedMap.values());
    return filters.includeImportedInFilter
      ? all.filter((t) => matchesFilters(t, filters))
      : all;
  },
  [version, filters],
);
```

### UI (`src/components/Filters.tsx`)

- Placeholder text updated: `"Search... (comma-separated)"`
- New checkbox below the Callsign / Hex input, visible only when `importedCount > 0`:

```
[input: "Search... (comma-separated)"]
☐ Include Imported in filter          ← only when importedCount > 0
```

No new props on `FiltersPanel` — `includeImportedInFilter` is part of the `Filters` object already passed via `filters` + `onChange`.

## Testing

### `matchesFilters` unit tests (new cases)

| Scenario | Expected |
|----------|----------|
| Single token, exact match | passes |
| Single token, partial match (`"BAW"` → `"BAW456"`) | passes |
| Two tokens, first matches | passes |
| Two tokens, second matches | passes |
| Two tokens, neither matches | fails |
| Whitespace-only tokens (`"  ,  "`) | no filter applied, passes |
| `includeImportedInFilter: false` | imported not filtered |
| `includeImportedInFilter: true`, token matches | imported track passes |
| `includeImportedInFilter: true`, token no match | imported track excluded |

### `FiltersPanel` component tests (new cases)

| Scenario | Expected |
|----------|----------|
| `importedCount === 0` | "Include Imported in filter" not rendered |
| `importedCount > 0` | checkbox rendered |
| Click checkbox | `onChange` called with `includeImportedInFilter: true` |

## Files to Touch

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `includeImportedInFilter` to `Filters` and `DEFAULT_FILTERS` |
| `src/hooks/useAircraftTracks.ts` | Update `matchesFilters`, update imported memo |
| `src/components/Filters.tsx` | Update placeholder, add conditional checkbox |
| `src/hooks/__tests__/useAircraftTracks.test.ts` | New multi-token + imported filter tests |
| `src/components/__tests__/Filters.test.tsx` | New checkbox visibility/interaction tests |
