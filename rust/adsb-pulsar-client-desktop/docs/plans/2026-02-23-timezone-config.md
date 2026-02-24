# Timezone Config + Display Format Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a configurable source timezone for dump1090 SBS-1 timestamp parsing (stored in `Config`) and a display timezone preference (stored in `localStorage`), while keeping DuckDB UTC-only.

**Architecture:** `parse_timestamp_to_ms(ts, tz)` gains a timezone parameter; the bridge reads `Config.dump1090_tz` and passes it on every flush. A new `useDisplayTz()` hook reads a localStorage preference and exposes a `formatTime(ms)` closure. StorageConfig and the Storage struct are untouched — storage remains TZ-agnostic.

**Tech Stack:** Rust (`chrono-tz 0.10`, `chrono 0.4`), TypeScript (`Intl.DateTimeFormat`), React (`useLocalStorage`), Vitest, cargo test.

---

## Task 1: Add chrono-tz to workspace + adsb-data-engine

**Files:**
- Modify: `rust/Cargo.toml`
- Modify: `rust/adsb-data-engine/Cargo.toml`

**Step 1: Add to workspace dependencies**

In `rust/Cargo.toml`, add one line inside `[workspace.dependencies]`:

```toml
chrono-tz = "0.10"
```

**Step 2: Add to adsb-data-engine**

In `rust/adsb-data-engine/Cargo.toml`, add inside `[dependencies]`:

```toml
chrono-tz = { workspace = true }
```

**Step 3: Verify it compiles**

```bash
cd adsb-feed/rust
cargo check -p adsb-data-engine
```
Expected: `Finished` with no errors (chrono-tz downloads and links).

**Step 4: Commit**

```bash
git add rust/Cargo.toml rust/adsb-data-engine/Cargo.toml
git commit -m "build: add chrono-tz workspace dependency for TZ-aware timestamp parsing"
```

---

## Task 2: Update parse_timestamp_to_ms — add tz parameter

**Files:**
- Modify: `rust/adsb-data-engine/src/storage.rs`

**Step 1: Write new failing tests for the tz parameter**

In `storage.rs`, inside `mod tests`, add after `test_parse_timestamp_to_ms_invalid_uses_current`:

```rust
#[test]
fn test_parse_timestamp_to_ms_utc() {
    let ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "UTC");
    let expected = chrono::NaiveDateTime::parse_from_str(
        "2024/01/15 10:30:00.000",
        "%Y/%m/%d %H:%M:%S%.3f",
    )
    .unwrap()
    .and_utc()
    .timestamp_millis();
    assert_eq!(ms, expected);
}

#[test]
fn test_parse_timestamp_to_ms_iana_paris() {
    // Europe/Paris = UTC+1 in January (no DST)
    // Local 10:30 Paris = 09:30 UTC → 1 hour before the UTC reading
    let utc_ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "UTC");
    let paris_ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "Europe/Paris");
    assert_eq!(paris_ms, utc_ms - 3600 * 1000);
}

#[test]
fn test_parse_timestamp_to_ms_unknown_tz_does_not_panic() {
    // Unknown TZ must fall back gracefully — no panic
    let ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "Not/A/TZ");
    assert!(ms > 0);
}
```

**Step 2: Run tests — they must fail (function signature mismatch)**

```bash
cd adsb-feed/rust
cargo test -p adsb-data-engine test_parse_timestamp_to_ms_utc 2>&1 | tail -5
```
Expected: compile error — `parse_timestamp_to_ms` takes 1 argument, 2 given.

**Step 3: Replace parse_timestamp_to_ms implementation**

Find and replace the entire `parse_timestamp_to_ms` function (currently at the bottom of `storage.rs`, before `#[cfg(test)]`):

```rust
/// Parse an SBS-1 timestamp string ("YYYY/MM/DD HH:MM:SS.mmm") to UTC epoch milliseconds.
///
/// `tz` controls how the naive datetime is interpreted:
/// - `"Local"` — machine's local timezone (default; preserves previous behaviour)
/// - `"UTC"`   — explicit UTC
/// - any other string — IANA timezone name (e.g. `"Europe/Paris"`);
///   falls back to local with a warning if unrecognised
///
/// The returned `i64` is always a true UTC epoch millisecond value.
fn parse_timestamp_to_ms(timestamp: &str, tz: &str) -> i64 {
    use std::str::FromStr;

    let naive = chrono::NaiveDateTime::parse_from_str(timestamp, "%Y/%m/%d %H:%M:%S%.3f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(timestamp, "%Y/%m/%d %H:%M:%S"));

    let naive = match naive {
        Ok(dt) => dt,
        Err(_) => return chrono::Utc::now().timestamp_millis(),
    };

    match tz {
        "UTC" => naive.and_utc().timestamp_millis(),
        "Local" => naive
            .and_local_timezone(chrono::Local)
            .single()
            .map(|dt| dt.timestamp_millis())
            .unwrap_or_else(|| naive.and_utc().timestamp_millis()),
        iana => match chrono_tz::Tz::from_str(iana) {
            Ok(resolved) => naive
                .and_local_timezone(resolved)
                .single()
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_else(|| naive.and_utc().timestamp_millis()),
            Err(_) => {
                tracing::warn!("Unknown timezone '{}', falling back to Local", iana);
                naive
                    .and_local_timezone(chrono::Local)
                    .single()
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or_else(|| naive.and_utc().timestamp_millis())
            }
        },
    }
}
```

**Step 4: Fix the existing call site in insert_batch_sync**

`insert_batch_sync` calls `parse_timestamp_to_ms(&pos.timestamp)`. It will fail to compile now. Add `"UTC"` temporarily so we can fix it properly in Task 3:

```rust
let timestamp_ms = parse_timestamp_to_ms(&pos.timestamp, "UTC");
```

**Step 5: Fix existing tests — add "UTC" or "Local" to all test calls**

Every call to `parse_timestamp_to_ms` inside `mod tests` that passes 1 argument needs a second argument. Update:

- `test_parse_timestamp_to_ms_valid` — change to `parse_timestamp_to_ms("...", "Local")` (tests local behaviour); update the expected value from `.and_local_timezone(chrono::Local)` accordingly (it's already correct).
- `test_parse_timestamp_to_ms_no_millis` — same, add `"Local"`.
- `test_parse_timestamp_to_ms_invalid_uses_current` — add `"UTC"` (fallback uses Utc::now regardless).
- `test_query_bbox_with_time_window` — the two `parse_timestamp_to_ms` calls for `ts_start`/`ts_end`, add `"UTC"`.

**Step 6: Run the new and existing tests**

```bash
cd adsb-feed/rust
cargo test -p adsb-data-engine storage::tests::test_parse_timestamp 2>&1 | tail -15
```
Expected: all `test_parse_timestamp_to_ms_*` tests pass.

**Step 7: Commit**

```bash
git add rust/adsb-data-engine/src/storage.rs
git commit -m "feat(data-engine): parse_timestamp_to_ms accepts tz parameter, stores UTC"
```

---

## Task 3: Update insert_batch_sync / insert_batch — add tz parameter

**Files:**
- Modify: `rust/adsb-data-engine/src/storage.rs`

**Step 1: Write a failing test that passes TZ explicitly**

In `mod tests`, add:

```rust
#[test]
fn test_insert_batch_uses_tz_for_parsing() {
    // Europe/Paris Jan = UTC+1. If we insert "10:30:00" as Paris time,
    // the stored ms should equal UTC 09:30:00.
    let handle = StorageHandle::open(test_config()).unwrap();
    let pos = sample_position("A1B2C3", Some(45.5), Some(-73.5), "2024/01/15 10:30:00.000");
    handle.insert_batch_sync(&[pos], "Europe/Paris").unwrap();

    let utc_ms = parse_timestamp_to_ms("2024/01/15 10:30:00.000", "UTC");
    let expected_ms = utc_ms - 3600 * 1000; // 09:30 UTC

    let storage = handle.inner.lock().unwrap();
    let stored_ms: i64 = storage
        .conn
        .query_row("SELECT timestamp_ms FROM positions LIMIT 1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored_ms, expected_ms);
}
```

**Step 2: Run it — must fail (wrong arity)**

```bash
cd adsb-feed/rust
cargo test -p adsb-data-engine test_insert_batch_uses_tz 2>&1 | tail -5
```
Expected: compile error.

**Step 3: Update insert_batch_sync signature**

Change:
```rust
pub fn insert_batch_sync(&self, positions: &[AircraftPosition]) -> Result<(), StorageError> {
```
To:
```rust
pub fn insert_batch_sync(&self, positions: &[AircraftPosition], tz: &str) -> Result<(), StorageError> {
```

Inside the function body, change:
```rust
let timestamp_ms = parse_timestamp_to_ms(&pos.timestamp, "UTC");
```
To:
```rust
let timestamp_ms = parse_timestamp_to_ms(&pos.timestamp, tz);
```

**Step 4: Update insert_batch async wrapper**

Change:
```rust
pub async fn insert_batch(&self, positions: Vec<AircraftPosition>) -> Result<(), StorageError> {
    let handle = self.clone();
    tokio::task::spawn_blocking(move || handle.insert_batch_sync(&positions))
```
To:
```rust
pub async fn insert_batch(&self, positions: Vec<AircraftPosition>, tz: String) -> Result<(), StorageError> {
    let handle = self.clone();
    tokio::task::spawn_blocking(move || handle.insert_batch_sync(&positions, &tz))
```

**Step 5: Fix all broken test call sites**

Every call to `insert_batch_sync` and `insert_batch` in `mod tests` needs a TZ argument. Add `"UTC"` to all of them:

- `test_insert_batch_and_count`: `handle.insert_batch_sync(&positions, "UTC")`
- `test_insert_empty_batch`: `handle.insert_batch_sync(&[], "UTC")`
- `test_query_bbox_returns_matching`: all three `insert_batch_sync` calls → add `"UTC"`
- `test_query_bbox_with_time_window`: all three `insert_batch_sync` calls → add `"UTC"`
- `test_query_bbox_excludes_null_coords`: add `"UTC"`
- `test_get_trajectory_single_aircraft`: add `"UTC"`
- `test_get_aircraft_summary`: add `"UTC"`
- `test_get_stats_time_range`: add `"UTC"`
- `test_prune_removes_old_data`: add `"UTC"`
- `test_source_id_stored`: add `"UTC"`
- `test_clone_shares_connection`: add `"UTC"`
- `test_async_insert_and_query`: `handle.insert_batch(positions, "UTC".to_string()).await`
- `test_async_trajectory`: `handle.insert_batch(positions, "UTC".to_string()).await`
- `test_async_prune`: `handle.insert_batch(positions, "UTC".to_string()).await`

**Step 6: Run all data-engine tests**

```bash
cd adsb-feed/rust
cargo test -p adsb-data-engine 2>&1 | tail -20
```
Expected: all 35+ tests pass (including the new TZ test).

**Step 7: Commit**

```bash
git add rust/adsb-data-engine/src/storage.rs
git commit -m "feat(data-engine): insert_batch accepts tz parameter, always stores UTC ms"
```

---

## Task 4: Add dump1090_tz to Config (adsb-pulsar-client)

**Files:**
- Modify: `rust/adsb-pulsar-client/src/config.rs`

**Step 1: Write failing tests for the new field**

In `config.rs` `mod tests`, add:

```rust
#[test]
fn test_dump1090_tz_defaults_to_local() {
    let config = Config::default();
    assert_eq!(config.dump1090_tz, "Local");
}

#[test]
fn test_dump1090_tz_serializes() {
    let config = Config {
        dump1090_tz: "Europe/Paris".to_string(),
        ..Config::default()
    };
    let json = serde_json::to_value(&config).unwrap();
    assert_eq!(json["dump1090_tz"], "Europe/Paris");
}

#[test]
fn test_dump1090_tz_deserializes_default_when_missing() {
    // Old configs without the field should deserialize to "Local"
    let json = serde_json::json!({ "source_id": "test" });
    let config: Config = serde_json::from_value(json).unwrap();
    assert_eq!(config.dump1090_tz, "Local");
}
```

**Step 2: Run tests — must fail**

```bash
cd adsb-feed/rust
cargo test -p adsb-pulsar-client test_dump1090_tz 2>&1 | tail -5
```
Expected: compile error — field `dump1090_tz` not found.

**Step 3: Add the field to the Config struct**

In `config.rs`, add after the `connection_mode` field (around line 294), before `forwarders`:

```rust
/// IANA timezone name for interpreting dump1090 SBS-1 timestamps.
///
/// `"Local"` (default) uses the machine's local timezone.
/// `"UTC"` forces UTC. Any IANA name (e.g. `"Europe/Paris"`) is accepted.
/// An unrecognised name logs a warning at runtime and falls back to Local.
#[cfg_attr(
    feature = "cli",
    arg(
        long = "dump1090-tz",
        default_value = "Local",
        hide = true,
        help = "Timezone for dump1090 timestamps (Local, UTC, or IANA name e.g. Europe/Paris)"
    )
)]
#[serde(default = "default_dump1090_tz")]
pub dump1090_tz: String,
```

**Step 4: Add the default function**

After `fn default_connection_mode()`, add:

```rust
fn default_dump1090_tz() -> String {
    "Local".to_string()
}
```

**Step 5: Add to Default impl**

In the `Default` impl block (inside `fn default()`), add:

```rust
dump1090_tz: default_dump1090_tz(),
```

**Step 6: Run the new tests**

```bash
cd adsb-feed/rust
cargo test -p adsb-pulsar-client test_dump1090_tz 2>&1 | tail -10
```
Expected: all three tests pass.

**Step 7: Run full workspace test + lint**

```bash
cd adsb-feed/rust
cargo test --workspace && cargo clippy --workspace -- -D warnings
```
Expected: all tests pass, no clippy warnings.

**Step 8: Commit**

```bash
git add rust/adsb-pulsar-client/src/config.rs
git commit -m "feat(config): add dump1090_tz field, default 'Local'"
```

---

## Task 5: Bridge — pass dump1090_tz to persist_batch

**Files:**
- Modify: `rust/adsb-pulsar-client-desktop/src-tauri/src/bridge.rs`

**Step 1: Extract dump1090_tz in start_feed**

In `start_feed`, add after `let socket_read_timeout_secs = config.socket_read_timeout_secs;`:

```rust
let dump1090_tz = config.dump1090_tz.clone();
```

**Step 2: Pass dump1090_tz to the message relay task**

Change the task spawn for Task 2 from:
```rust
let message_task = tokio::spawn(async move {
    relay_messages(app_for_messages, message_rx, last_message_time, storage).await;
});
```
To:
```rust
let message_task = tokio::spawn(async move {
    relay_messages(app_for_messages, message_rx, last_message_time, storage, dump1090_tz).await;
});
```

**Step 3: Update relay_messages signature**

Change:
```rust
async fn relay_messages(
    app: AppHandle,
    mut rx: broadcast::Receiver<Vec<u8>>,
    last_message_time: Arc<RwLock<Instant>>,
    storage: Option<StorageHandle>,
) {
```
To:
```rust
async fn relay_messages(
    app: AppHandle,
    mut rx: broadcast::Receiver<Vec<u8>>,
    last_message_time: Arc<RwLock<Instant>>,
    storage: Option<StorageHandle>,
    dump1090_tz: String,
) {
```

**Step 4: Pass tz to persist_batch at both call sites**

Inside `relay_messages`, change both occurrences of:
```rust
persist_batch(&storage, &batch).await;
```
To:
```rust
persist_batch(&storage, &batch, &dump1090_tz).await;
```

**Step 5: Update persist_batch signature and body**

Change:
```rust
async fn persist_batch(storage: &Option<StorageHandle>, batch: &[AircraftPosition]) {
    if let Some(ref storage) = storage {
        if let Err(e) = storage.insert_batch(batch.to_vec()).await {
```
To:
```rust
async fn persist_batch(storage: &Option<StorageHandle>, batch: &[AircraftPosition], tz: &str) {
    if let Some(ref storage) = storage {
        if let Err(e) = storage.insert_batch(batch.to_vec(), tz.to_string()).await {
```

**Step 6: Compile-check the Tauri crate**

```bash
cd adsb-feed/rust
cargo check -p adsb-pulsar-client-desktop-lib 2>&1 | tail -5
```
Expected: `Finished` with no errors.

**Step 7: Run full workspace tests**

```bash
cd adsb-feed/rust
cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --workspace --check
```
Expected: all tests pass, no warnings or format issues.

**Step 8: Commit**

```bash
git add rust/adsb-pulsar-client-desktop/src-tauri/src/bridge.rs
git commit -m "feat(bridge): pass dump1090_tz to persist_batch for TZ-aware UTC storage"
```

---

## Task 6: TypeScript — types, formatWithTz, formatTrackTime

**Files:**
- Modify: `adsb-pulsar-client-desktop/src/lib/types.ts`
- Modify: `adsb-pulsar-client-desktop/src/lib/format.ts`
- Modify: `adsb-pulsar-client-desktop/src/lib/aircraft-details.ts`
- Modify: `adsb-pulsar-client-desktop/src/lib/__tests__/format.test.ts`
- Modify: `adsb-pulsar-client-desktop/src/lib/__tests__/aircraft-details.test.ts`

**Step 1: Write failing tests for formatWithTz**

In `src/lib/__tests__/format.test.ts`, add:

```typescript
import { timeAgo, formatBytes, formatWithTz } from "../format";

// A fixed UTC instant: 2026-02-23 15:30:45 UTC
const FIXED_MS = new Date("2026-02-23T15:30:45Z").getTime();

describe("formatWithTz", () => {
  it("utc mode contains 15:30:45 for a 15:30:45 UTC instant", () => {
    const result = formatWithTz(FIXED_MS, "utc");
    expect(result).toContain("15:30:45");
  });

  it("source mode with 'UTC' shows UTC time", () => {
    const result = formatWithTz(FIXED_MS, "source", "UTC");
    expect(result).toContain("15:30:45");
  });

  it("source mode with 'Local' returns a non-empty string without throwing", () => {
    const result = formatWithTz(FIXED_MS, "source", "Local");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("local mode returns a non-empty string", () => {
    const result = formatWithTz(FIXED_MS, "local");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Write failing test for formatTrackTime with tzName**

In `src/lib/__tests__/aircraft-details.test.ts`, add inside the existing `describe("formatTrackTime", ...)`:

```typescript
it("with tzName='UTC' returns HH:MM:SS in UTC", () => {
  // 2026-02-23T15:30:45Z — UTC hour is 15
  const ms = new Date("2026-02-23T15:30:45Z").getTime();
  const result = formatTrackTime(ms, "UTC");
  expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  expect(result).toBe("15:30:45");
});
```

**Step 3: Run tests — must fail**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/lib/__tests__/format.test.ts src/lib/__tests__/aircraft-details.test.ts 2>&1 | tail -15
```
Expected: `formatWithTz is not a function` / type errors.

**Step 4: Add dump1090_tz to Config type**

In `src/lib/types.ts`, inside the `Config` interface, add after `connection_mode`:

```typescript
dump1090_tz: string;
```

**Step 5: Add formatWithTz to format.ts**

In `src/lib/format.ts`, append:

```typescript
/**
 * Format epoch ms as a human-readable datetime string in the requested timezone.
 *
 * tzMode:
 *   "local"  — machine's local timezone (same as toLocaleString())
 *   "utc"    — UTC
 *   "source" — IANA name from sourceTzName; if absent or "Local", falls back to local
 */
export function formatWithTz(
  ms: number,
  tzMode: "local" | "utc" | "source",
  sourceTzName?: string,
): string {
  let timeZone: string | undefined;
  if (tzMode === "utc") {
    timeZone = "UTC";
  } else if (tzMode === "source" && sourceTzName && sourceTzName !== "Local") {
    timeZone = sourceTzName;
  }
  return new Date(ms).toLocaleString(undefined, timeZone ? { timeZone } : undefined);
}
```

**Step 6: Update formatTrackTime to accept optional tzName**

In `src/lib/aircraft-details.ts`, replace the existing `formatTrackTime` function:

```typescript
/**
 * Format a ms-since-epoch timestamp as HH:MM:SS.
 * Optional tzName: IANA timezone name; omit (or pass "Local") for machine local time.
 */
export function formatTrackTime(ms: number, tzName?: string): string {
  if (!tzName || tzName === "Local") {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }
  // Use Intl for explicit non-local TZ
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tzName,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}
```

**Step 7: Run the new tests**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/lib/__tests__/format.test.ts src/lib/__tests__/aircraft-details.test.ts 2>&1 | tail -20
```
Expected: all tests pass including the new `formatWithTz` and `formatTrackTime` with UTC tests.

**Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/format.ts src/lib/aircraft-details.ts \
        src/lib/__tests__/format.test.ts src/lib/__tests__/aircraft-details.test.ts
git commit -m "feat(ts): add formatWithTz utility and optional tzName to formatTrackTime"
```

---

## Task 7: useDisplayTz hook

**Files:**
- Create: `adsb-pulsar-client-desktop/src/hooks/useDisplayTz.ts`
- Create: `adsb-pulsar-client-desktop/src/hooks/__tests__/useDisplayTz.test.ts`

**Step 1: Write the tests first**

Create `src/hooks/__tests__/useDisplayTz.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDisplayTz } from "@/hooks/useDisplayTz";

vi.mock("@/lib/commands", () => ({
  getConfig: vi.fn().mockResolvedValue({ dump1090_tz: "Europe/Paris" }),
}));

// Clear localStorage between tests
beforeEach(() => {
  localStorage.clear();
});

describe("useDisplayTz", () => {
  it("defaults to local mode", () => {
    const { result } = renderHook(() => useDisplayTz());
    expect(result.current.tzMode).toBe("local");
  });

  it("setTzMode persists to localStorage", () => {
    const { result } = renderHook(() => useDisplayTz());
    act(() => result.current.setTzMode("utc"));
    expect(result.current.tzMode).toBe("utc");
    expect(localStorage.getItem("adsb-display-tz")).toContain("utc");
  });

  it("formatTime returns a non-empty string for local mode", () => {
    const { result } = renderHook(() => useDisplayTz());
    const str = result.current.formatTime(Date.now());
    expect(typeof str).toBe("string");
    expect(str.length).toBeGreaterThan(0);
  });

  it("resolvedTzName is undefined in local mode", () => {
    const { result } = renderHook(() => useDisplayTz());
    expect(result.current.resolvedTzName).toBeUndefined();
  });

  it("resolvedTzName is 'UTC' in utc mode", () => {
    const { result } = renderHook(() => useDisplayTz());
    act(() => result.current.setTzMode("utc"));
    expect(result.current.resolvedTzName).toBe("UTC");
  });

  it("source mode with Local sourceTzName returns undefined resolvedTzName", async () => {
    vi.mocked((await import("@/lib/commands")).getConfig).mockResolvedValue(
      { dump1090_tz: "Local" } as never
    );
    const { result } = renderHook(() => useDisplayTz());
    act(() => result.current.setTzMode("source"));
    // "Local" is not a valid Intl TZ → resolvedTzName must be undefined
    expect(result.current.resolvedTzName).toBeUndefined();
  });
});
```

**Step 2: Run tests — must fail**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/hooks/__tests__/useDisplayTz.test.ts 2>&1 | tail -10
```
Expected: module not found error for `useDisplayTz`.

**Step 3: Create the hook**

Create `src/hooks/useDisplayTz.ts`:

```typescript
"use client";
import { useState, useEffect, useCallback } from "react";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { getConfig } from "@/lib/commands";
import { formatWithTz } from "@/lib/format";

export type DisplayTzMode = "local" | "utc" | "source";

/**
 * Reads/writes the user's display timezone preference from localStorage.
 *
 * Returns:
 *   tzMode        — "local" | "utc" | "source"
 *   setTzMode     — setter (persisted)
 *   formatTime    — formats epoch ms using the current preference
 *   resolvedTzName — the IANA string for Intl (undefined = machine local)
 */
export function useDisplayTz() {
  const [tzMode, setTzMode] = useLocalStorage<DisplayTzMode>(
    "adsb-display-tz",
    "local",
  );
  const [sourceTzName, setSourceTzName] = useState<string>("Local");

  useEffect(() => {
    getConfig()
      .then((cfg) => setSourceTzName(cfg.dump1090_tz))
      .catch(() => {}); // silent fallback — sourceTzName stays "Local"
  }, []);

  const resolvedTzName: string | undefined =
    tzMode === "utc"
      ? "UTC"
      : tzMode === "source" && sourceTzName !== "Local"
        ? sourceTzName
        : undefined;

  const formatTime = useCallback(
    (ms: number) => formatWithTz(ms, tzMode, sourceTzName),
    [tzMode, sourceTzName],
  );

  return { tzMode, setTzMode, formatTime, resolvedTzName };
}
```

**Step 4: Run the hook tests**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/hooks/__tests__/useDisplayTz.test.ts 2>&1 | tail -15
```
Expected: all 6 tests pass.

**Step 5: Commit**

```bash
git add src/hooks/useDisplayTz.ts src/hooks/__tests__/useDisplayTz.test.ts
git commit -m "feat(hooks): add useDisplayTz — localStorage-backed display timezone preference"
```

---

## Task 8: Settings page — add source TZ field + display TZ toggle

**Files:**
- Modify: `adsb-pulsar-client-desktop/src/app/settings/page.tsx`

**Step 1: Add dump1090_tz text field to the Connection section**

In `settings/page.tsx`, inside the Connection section `<div className="grid grid-cols-2 gap-4">`, add after the `Connection Mode` Field:

```tsx
<div className="col-span-2">
  <Field
    label="Source Timezone"
    value={config.dump1090_tz}
    onChange={(v) => update({ dump1090_tz: v })}
  />
  <p className="text-xs text-slate-500 mt-1">
    Timezone of dump1090 timestamps. Use{" "}
    <code className="text-slate-400">Local</code>,{" "}
    <code className="text-slate-400">UTC</code>, or an IANA name like{" "}
    <code className="text-slate-400">Europe/Paris</code>.
  </p>
</div>
```

**Step 2: Add display TZ toggle to the Display section**

At the top of `SettingsPage`, import `useDisplayTz`:

```tsx
import { useDisplayTz } from "@/hooks/useDisplayTz";
```

Inside `SettingsPage()`, add alongside `trajectoryStyle`:

```tsx
const { tzMode, setTzMode } = useDisplayTz();
```

In the Display section JSX, after the trajectory style block, add:

```tsx
<div className="mt-4">
  <label className="block text-xs text-slate-400 mb-1">Time Display</label>
  <div className="flex gap-2">
    {(["local", "utc", "source"] as const).map((mode) => (
      <button
        key={mode}
        onClick={() => setTzMode(mode)}
        className={`px-3 py-1.5 text-sm rounded capitalize transition ${
          tzMode === mode
            ? "bg-blue-600 text-white"
            : "bg-slate-800 text-slate-300 hover:bg-slate-700"
        }`}
      >
        {mode === "source" ? "Source" : mode === "utc" ? "UTC" : "Local"}
      </button>
    ))}
  </div>
  <p className="text-xs text-slate-500 mt-2">
    Timezone for displaying stored timestamps. &ldquo;Source&rdquo; uses the
    Source Timezone above. Saved automatically.
  </p>
</div>
```

**Step 3: Run full TS test suite**

```bash
cd adsb-pulsar-client-desktop
npm test 2>&1 | tail -15
```
Expected: all tests pass. The settings page has no dedicated unit test for these new controls; the existing tests are snapshot-free so no updates needed.

**Step 4: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "feat(settings): add source TZ text field and display TZ toggle"
```

---

## Task 9: HistoryBrowser — use useDisplayTz for stat labels

**Files:**
- Modify: `adsb-pulsar-client-desktop/src/components/HistoryBrowser.tsx`
- Modify: `adsb-pulsar-client-desktop/src/components/__tests__/HistoryBrowser.test.tsx`

**Step 1: Add mock for getConfig in HistoryBrowser tests**

At the top of `HistoryBrowser.test.tsx`, inside the existing `vi.mock("@/lib/commands", ...)` factory, add `getConfig` to the mock:

```typescript
vi.mock("@/lib/commands", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/commands")>();
  return {
    ...real,
    getStorageStats: vi.fn(),
    getAircraftSummary: vi.fn(),
    getTrajectory: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ dump1090_tz: "Local" }),  // ← add this
  };
});
```

And add `getConfig` to the import below it:

```typescript
import {
  getStorageStats,
  getAircraftSummary,
  getTrajectory,
  getConfig,              // ← add
} from "@/lib/commands";
```

**Step 2: Run existing HistoryBrowser tests — must still pass**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/components/__tests__/HistoryBrowser.test.tsx 2>&1 | tail -10
```
Expected: all existing tests pass (mock now handles `getConfig`).

**Step 3: Update HistoryBrowser.tsx**

At the top of the file, add the import:

```typescript
import { useDisplayTz } from "@/hooks/useDisplayTz";
```

Inside the `HistoryBrowser` component function, add:

```typescript
const { formatTime } = useDisplayTz();
```

Replace the local `formatMs` function (remove it entirely):
```typescript
// DELETE this:
function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}
```

Replace the two JSX usages of `{formatMs(stats.oldest_timestamp_ms)}` and `{formatMs(stats.newest_timestamp_ms)}` with:

```tsx
{stats.oldest_timestamp_ms !== null ? formatTime(stats.oldest_timestamp_ms) : "—"}
{stats.newest_timestamp_ms !== null ? formatTime(stats.newest_timestamp_ms) : "—"}
```

**Step 4: Run HistoryBrowser tests**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/components/__tests__/HistoryBrowser.test.tsx 2>&1 | tail -10
```
Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/components/HistoryBrowser.tsx \
        src/components/__tests__/HistoryBrowser.test.tsx
git commit -m "feat(HistoryBrowser): use useDisplayTz for Oldest/Newest stat labels"
```

---

## Task 10: AircraftDetailsPanel — use useDisplayTz for sparkline time axis

**Files:**
- Modify: `adsb-pulsar-client-desktop/src/components/AircraftDetailsPanel.tsx`

**Step 1: Import useDisplayTz**

At the top of `AircraftDetailsPanel.tsx`, add:

```typescript
import { useDisplayTz } from "@/hooks/useDisplayTz";
```

**Step 2: Call the hook inside ExpandedPanel**

`ExpandedPanel` is the inner function component (defined in the same file) that renders the sparkline. Add the hook call at the top of `ExpandedPanel`:

```typescript
const { resolvedTzName } = useDisplayTz();
```

**Step 3: Pass resolvedTzName to both formatTrackTime calls**

In `ExpandedPanel`, change:
```tsx
{formatTrackTime(track.first_seen)}
```
To:
```tsx
{formatTrackTime(track.first_seen, resolvedTzName)}
```

And:
```tsx
{formatTrackTime(track.last_seen)}
```
To:
```tsx
{formatTrackTime(track.last_seen, resolvedTzName)}
```

**Step 4: Run AircraftDetailsPanel tests**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/components/__tests__/AircraftDetailsPanel.test.tsx 2>&1 | tail -10
```
Expected: all tests pass. The existing sparkline tests only check element presence, not exact time strings, and `useDisplayTz` falls back to local time when `getConfig` is not mocked.

**Step 5: Run the full TS test suite**

```bash
cd adsb-pulsar-client-desktop
npm test 2>&1 | tail -10
```
Expected: all tests pass.

**Step 6: Commit**

```bash
git add src/components/AircraftDetailsPanel.tsx
git commit -m "feat(AircraftDetailsPanel): sparkline axis uses useDisplayTz timezone"
```

---

## Task 11: Final CI gate

**Step 1: Full Rust checks**

```bash
cd adsb-feed/rust
cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --workspace --check
```
Expected: clean pass.

**Step 2: Full TypeScript checks**

```bash
cd adsb-feed/rust/adsb-pulsar-client-desktop
npm test && npx next lint
```
Expected: clean pass.

**Step 3: Commit if any fmt fixes were needed**

If `cargo fmt --check` reported diff, run `cargo fmt --workspace` first, then commit.

**Step 4: Final commit**

```bash
git commit -m "chore: ci gate — timezone config + display format feature complete"
```
