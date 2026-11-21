# Saved regex filters, with military defaults

**Card:** Add support for defining, saving and selecting custom regex filters. A regex can come
with an optional description. Include a military-aircraft filter by default.

## Decisions

- **Storage:** localStorage (`adsb-saved-filters`), like the other UI prefs. Per machine and per stack.
- **Defaults:** two separate built-ins, *Military — hex ranges (NATO/EU)* and
  *Military — callsigns (NATO/EU)*.
- **Built-ins are defined in code**, never stored, so they can't be deleted and a fix to one
  reaches every install. Their names are reserved.
- **The selection is derived**: the entry whose pattern equals the query in regex mode. It can't go stale.
- **Agent:** `setFilters` and `searchLiveFlights` take `savedFilter: <name>`. The context lists names and descriptions.
  `fast_path_descriptions.json` is not changed, for the reason given in the callsign-regex plan.

## The supplied military hex regex was fixed

As supplied, two branches are 3 characters long, with nothing after them before `$`:

- `3(A[A-F]|B.)`
- `A(D[F8-F]|E.|F[0-3])`

They could only match 3-character strings, so French and US hex never matched. For example,
`3AB123` and `AE1234` returned false, while the 3-character string `3AA` returned true.

The fix appends `...` after both groups. Nothing else changed, including the 4[4567]F and 501 blocks:

```
^(3(A[A-F]|B.)...|43C...|4[4567]F...|480...|4B7...|3F....|501...|A(D[F8-F]|E.|F[0-3])...|C2....)$
```

Known limits, also written in the filter's description:

- The US branch starts at AD8000, below the documented ADF7C8, so a few civil N-numbers can match.
- Spain and Italy are not covered.

## Changes

| File | Change |
|------|--------|
| `src/lib/saved-filters.ts` | New: model, built-ins, validate / upsert / remove / find / selected / sanitize |
| `src/components/SavedFilters.tsx` | New: picker, Save… / Update form, two-click Delete |
| `src/components/Filters.tsx`, `LeftPanel.tsx` | Optional `savedFilters` prop |
| `src/app/page.tsx` | localStorage state, passed to the panel and both copilot hooks |
| `src/hooks/useCopilotTools.ts` | `savedFilter` param on `setFilters` and `searchLiveFlights` |
| `src/hooks/useCopilotContext.ts` | New "Saved callsign/hex regex filters" context entry |

## Tests

- `src/lib/__tests__/saved-filters.test.ts` checks:
  - military regexes against military and civil examples;
  - validation, upsert, remove, find, derived selection and sanitize.
- `src/components/__tests__/SavedFilters.test.tsx` covers select, description, Save enablement,
  Save and Update, validation errors and two-click Delete.
- `Filters.test.tsx`, `useCopilotTools.test.ts` and `useCopilotContext.test.ts` cover the wiring.

## Follow-up: combined filters (OR, AND, XOR, NOT)

**Card:** Add the ability to combine regexes into combined regexes with a logical condition
(OR, XOR, AND, NOT).

Decisions:
- **References, not copies:** a fix to a source (built-ins included) reaches every combination.
- **XOR = exactly one term.** With two terms this is ordinary XOR. With more, it is not parity.
- **NOT applies per term.**
- A built-in *Military — hex or callsign (NATO/EU)* combines the two military defaults with OR.

Why not merge everything into one regex: each regex is tested separately against the callsign
and the hex. AND / XOR / NOT spanning both fields cannot be written as one pattern, so a
combination is evaluated per aircraft (`combinedMatcher`). It is selected by id
(`Filters.savedFilterId`), and `page.tsx` resolves it into a runtime-only
`Filters.combinedMatcher` before matching.

| File | Change |
|------|--------|
| `src/lib/saved-filters.ts` | Adds `combine` to the model, `combinedMatcher` (recursive, cycle and missing-source checks), `resolveFilters`, `applySavedFilter`, `describeFilter` and `referencedBy`. Validation and sanitize now handle combinations. |
| `src/lib/callsign-match.ts` | `compileRegex` exported (uncached), one per source |
| `src/lib/types.ts` | `Filters.savedFilterId`, `Filters.combinedMatcher` (runtime) |
| `src/hooks/useAircraftTracks.ts` | `matchesFilters` uses the combined matcher when one is selected |
| `src/components/SavedFilters.tsx` | Combine… / Edit… form: operator, sources with NOT, add/remove rows. Shows the expression. Delete refuses a filter that is still used. |
| `src/components/Filters.tsx` | Placeholder while a combination is active; typing or `.*` replaces it |
| `src/hooks/useCopilotTools.ts`, `useCopilotContext.ts` | Combined names in `savedFilter`; the expression is in the context |
