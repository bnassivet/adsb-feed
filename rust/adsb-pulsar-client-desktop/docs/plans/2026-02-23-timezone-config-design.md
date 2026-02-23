# Design: Configurable Source Timezone + Display Time Format

**Date**: 2026-02-23
**Status**: Approved

## Problem

The DuckDB history browser showed timestamps shifted by the local UTC offset because
`parse_timestamp_to_ms` treated SBS-1 naive datetime strings (emitted in the Pi's local
clock) as UTC. The hotfix (`chrono::Local`) works when the Pi and the Mac share a
timezone, but breaks down if they differ.

Two independent improvements are needed:

1. **Source timezone** — let the user declare which IANA timezone dump1090 uses when
   stamping messages, so the stored epoch ms are always true UTC.
2. **Display timezone** — let the user choose how stored UTC ms render in the UI
   (machine local / UTC / same as source).

## Architecture

| Concern | Layer | Storage |
|---|---|---|
| Source TZ (ingestion) | Rust `Config` struct | Tauri persisted config (`save_config`) |
| Display TZ (rendering) | TypeScript `useDisplayTz` hook | `localStorage` key `adsb-display-tz` |

**Key invariant**: DuckDB always stores true UTC epoch milliseconds. Timezone is a
_parsing_ concern (bridge → storage) and a _display_ concern (storage → UI). The
storage layer itself is TZ-agnostic.

## Section 1 — Rust: `adsb-data-engine`

### Dependency

Add to `adsb-data-engine/Cargo.toml` (and workspace root):

```toml
chrono-tz = "0.10"
```

### `parse_timestamp_to_ms` (storage.rs)

Signature changes from `(ts: &str) -> i64` to `(ts: &str, tz: &str) -> i64`.

Resolution rules (in order):

| `tz` value | Behaviour |
|---|---|
| `"Local"` | `chrono::Local` (machine timezone) — default, backward-compatible |
| `"UTC"` | `chrono::Utc` |
| Any other string | `chrono_tz::Tz::from_str(tz)` — IANA name |
| Unrecognised IANA | Log warning, fall back to `chrono::Local` |
| DST-ambiguous instant | `.single()` returns `None` → fall back to UTC + log |

The function always returns a **UTC epoch ms** `i64`.

### `insert_batch_sync`

```rust
pub fn insert_batch_sync(&self, positions: &[AircraftPosition], tz: &str) -> Result<(), StorageError>
```

TZ string is passed at call site; `StorageConfig` and the `Storage` struct are
**unchanged** — no TZ baked in.

Async wrapper:

```rust
pub async fn insert_batch(&self, positions: Vec<AircraftPosition>, tz: String) -> Result<(), StorageError>
```

## Section 2 — Rust: `adsb-pulsar-client` Config

Add to `config.rs`:

```rust
/// IANA timezone name for interpreting dump1090 SBS-1 timestamps.
/// "Local" uses the machine's local timezone; "UTC" forces UTC.
/// Examples: "Europe/Paris", "America/New_York"
#[serde(default = "default_dump1090_tz")]
pub dump1090_tz: String,
```

Default: `"Local"`.

`validate()` accepts:
- `"Local"` (always valid)
- `"UTC"` (always valid)
- Any string parseable by `chrono_tz::Tz::from_str` (IANA names)
- Rejects anything else with: `"Unknown timezone '{name}'. Use 'Local', 'UTC', or an IANA name like 'Europe/Paris'"`

`chrono-tz` is added as a workspace dependency. The CLI `--dump1090-tz` flag is hidden
(advanced use only).

## Section 3 — Tauri Bridge

In `bridge.rs`, the 500 ms flush loop:

1. Reads `AppState.config.dump1090_tz` under the config lock (clone the string)
2. Passes it to `storage.insert_batch(batch, tz).await`

TZ changes (via `save_config`) take effect on the **next flush** — no restart required.

`lib.rs` / `init_storage()`: no changes (storage handle creation does not need TZ).

## Section 4 — TypeScript: Types & Utilities

### `src/lib/types.ts`

```ts
export interface Config {
  // ... existing fields ...
  dump1090_tz: string;
}
```

### `src/lib/format.ts`

New pure functions (fully testable without React):

```ts
/**
 * Format epoch ms as a human-readable datetime string in the requested timezone.
 * tzMode: "local" | "utc" | "source"
 * sourceTzName: IANA name used when tzMode === "source" (ignored otherwise)
 */
export function formatWithTz(
  ms: number,
  tzMode: "local" | "utc" | "source",
  sourceTzName?: string,
): string

/**
 * Format epoch ms as HH:MM:SS.
 * Optional tzName: IANA timezone name; omit for machine local time.
 */
export function formatTrackTime(ms: number, tzName?: string): string
```

`formatWithTz` uses `Intl.DateTimeFormat` with the `timeZone` option for UTC and
source modes. When `tzMode === "source"` and `sourceTzName === "Local"` (or absent),
falls back to machine local (same as `"local"` mode).

### `src/hooks/useDisplayTz.ts`

```ts
export function useDisplayTz(): {
  tzMode: "local" | "utc" | "source";
  setTzMode: (mode: "local" | "utc" | "source") => void;
  formatTime: (ms: number) => string;
}
```

Internals:
- `useLocalStorage("adsb-display-tz", "local")` for persistence
- On mount (when mode is `"source"`), calls `getConfig()` once to read `dump1090_tz`
- `formatTime` delegates to `formatWithTz(ms, tzMode, sourceTzName)`
- If `getConfig()` fails, silently falls back to `"local"` rendering

## Section 5 — Settings Page

### Connection section

New field added after Source ID:

```
Source Timezone
[ Local                    ]   ← text input
  Local · UTC · IANA name (e.g. Europe/Paris)
```

Persisted via `save_config` (same as all other Config fields). Editable only when
feed is stopped (existing guard in `save_config` command).

### Display section

New three-button toggle (same visual style as Lines/Dots):

```
Time display
[ Local ]  [ UTC ]  [ Source ]
Timestamps shown in: machine local time / UTC / source timezone.
```

Stored in `localStorage` automatically.

## Section 6 — Component Updates

### `HistoryBrowser.tsx`

- `formatMs(ms)` (Oldest/Newest stat labels) switches to `useDisplayTz().formatTime(ms)`
- `toDatetimeLocal(ms)` (datetime-local input defaults) **unchanged** — always machine
  local time (HTML `<input type="datetime-local">` has no timezone concept)

### `AircraftDetailsPanel.tsx`

- Calls `useDisplayTz()` to obtain the resolved TZ name
- Passes it to `formatTrackTime(ms, tzName)` for sparkline axis labels

## Section 7 — Testing

### Rust

| Test location | What |
|---|---|
| `storage.rs` | `parse_timestamp_to_ms` parameterised over `"UTC"`, `"Local"`, `"Europe/Paris"` — assert UTC offset is correct |
| `storage.rs` | Existing `insert_batch_sync` tests pass `"UTC"` as TZ, preserving current ms assertions |
| `config.rs` | Valid IANA names accepted; gibberish rejected; `"Local"` and `"UTC"` always pass |

### TypeScript

| Test location | What |
|---|---|
| `src/lib/__tests__/format.test.ts` | `formatWithTz` — all three modes with a fixed epoch ms |
| `src/lib/__tests__/format.test.ts` | `formatTrackTime` — with and without tzName |
| `src/hooks/__tests__/useDisplayTz.test.ts` | localStorage persistence, mode switching, "source" fallback for "Local" TZ name |
| `src/app/settings/` | `dump1090_tz` field renders and propagates to config; display TZ toggle updates localStorage |

## Constraints & Non-Goals

- `datetime-local` range inputs always use machine local time — no change
- Changing source TZ while feed is running is not blocked (takes effect next flush)
- No migration of existing DuckDB rows: rows stored under the old bug (naive-as-UTC)
  are not retroactively corrected; the user should clear the DB if historical data
  matters
- No per-source TZ (all sources share one `dump1090_tz`)
