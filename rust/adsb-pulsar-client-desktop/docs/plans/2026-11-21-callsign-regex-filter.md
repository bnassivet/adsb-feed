# Callsign / hex search: regex mode

**Card:** Search/filter by Callsign to support regex in addition to the current implementation.

## Behaviour

- A `.*` toggle inside the *Callsign / Hex* input (Filters panel) switches between:
  - **substring** (unchanged default): comma-separated tokens, case-insensitive,
    matched against callsign or hex ident;
  - **regex**: the whole input is one case-insensitive JavaScript `RegExp`,
    tested against the trimmed callsign and the hex ident.
- An invalid regex shows a red input and an inline `role="alert"` message, and does
  **not** filter (the map keeps every aircraft while the user is typing).
- The chat tools `searchLiveFlights` and `setFilters` take an optional
  `callsignRegex: boolean`. An invalid pattern returns an `error` result, and
  `setFilters` does not apply it.

## Why a toggle, not `/pattern/` syntax

The comma is the token separator in substring mode, and regexes need commas
(`\d{3,4}`). An explicit mode removes that ambiguity. It is also discoverable
(the same `.*` convention as VS Code) and lets the agent state its intent with a
boolean instead of a delimiter it might forget.

## Changes

| File | Change |
|------|--------|
| `src/lib/callsign-match.ts` | New: `compileCallsignQuery(query, regex)` → `{ matcher, error }`, one-entry cache |
| `src/lib/types.ts` | `Filters.callsignRegex` (default `false`) |
| `src/hooks/useAircraftTracks.ts` | `matchesFilters` uses the shared matcher |
| `src/components/Filters.tsx` | Toggle button (`aria-pressed`), placeholder, invalid-pattern alert |
| `src/hooks/useCopilotTools.ts` | `callsignRegex` on both tools; shared matcher; error on an invalid pattern |

Not changed: `adsb-agent/src/adsb_agent/fast_path_descriptions.json` (the fast-path
gate threshold is fitted on those descriptions) and the stale `setFilters` mirror in
`tools.py` (frontend-less runs only; the live schema travels over AG-UI).

## Tests

- `src/lib/__tests__/callsign-match.test.ts`: both modes, commas in a pattern, invalid
  pattern, no `lastIndex` drift, cache identity
- `src/hooks/__tests__/useAircraftTracks.test.ts`: regex mode, and an invalid regex not filtering
- `src/components/__tests__/Filters.test.tsx`: toggle, placeholder, `aria-invalid` + alert
- `src/hooks/__tests__/useCopilotTools.test.ts`: regex search, error results, schema params
