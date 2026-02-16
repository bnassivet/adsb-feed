# RxTS & Msg# Columns Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add "RxTS" (last receive time, relative) and "Msg#" (total pre-throttle message count) columns to the aircraft tracking table.

**Architecture:** Message count is tracked in the Rust bridge before throttling discards duplicates, then propagated through the Tauri event to the React frontend. RxTS reuses the existing `last_seen` field (client-side `Date.now()`) and the existing `timeAgo()` formatter — no new data field needed. Both columns are sortable.

**Tech Stack:** Rust (serde, HashMap), TypeScript/React (Vitest, testing-library), Tauri v2 events

---

### Task 1: Add `message_count` to Rust `AircraftPosition`

**Files:**
- Modify: `src-tauri/src/sbs_parser.rs:14-26` (struct definition)
- Modify: `src-tauri/src/sbs_parser.rs:75-87` (parse function return)

**Step 1: Write the failing test**

Add to `sbs_parser.rs` test module (after line 244):

```rust
#[test]
fn test_message_count_defaults_to_zero() {
    let line = "MSG,3,1,1,A1B2C3,1,2024/01/15,10:30:00.000,2024/01/15,10:30:00.000,,35000,,,45.5,-73.5,,,,,,0";
    let pos = parse_sbs_message(line).unwrap();
    assert_eq!(pos.message_count, 0);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p adsb-pulsar-client-desktop-lib test_message_count_defaults_to_zero`
Expected: FAIL — `no field message_count on type AircraftPosition`

**Step 3: Implement — add field to struct and parse function**

In `AircraftPosition` struct (after `timestamp` field, line 25):

```rust
    pub message_count: u64,
```

In the `Some(AircraftPosition { ... })` block (after `timestamp,` line 86):

```rust
        message_count: 0,
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p adsb-pulsar-client-desktop-lib test_message_count`
Expected: PASS

**Step 5: Commit**

```bash
git add src-tauri/src/sbs_parser.rs
git commit -m "feat: add message_count field to AircraftPosition (default 0)"
```

---

### Task 2: Track message counts in Rust bridge

**Files:**
- Modify: `src-tauri/src/bridge.rs:137-179` (relay_messages function)

**Step 1: No unit test for this task** — `bridge.rs` is tightly coupled to `tauri::AppHandle` and tested via integration. The correctness of count accumulation is tested end-to-end via the TypeScript tests.

**Step 2: Add message count tracking to relay_messages**

Add a `message_counts` HashMap alongside the existing `buffer` (after line 143):

```rust
    let mut message_counts: HashMap<String, u64> = HashMap::new();
```

In the `Ok(data)` branch, after the `buffer.insert(...)` line (line 155), add counting for every parsed message:

```rust
                            if let Some(pos) = parse_sbs_message(&line) {
                                *message_counts.entry(pos.hex_ident.clone()).or_insert(0) += 1;
                                buffer.insert(pos.hex_ident.clone(), pos);
                            }
```

(Replace the existing `if let Some(pos) = parse_sbs_message(&line) { buffer.insert(...) }` block.)

In both flush paths (normal flush at line 172-175 and channel-closed flush at line 163-165), attach counts before emitting:

```rust
                    let mut batch: Vec<AircraftPosition> = buffer.drain().map(|(_, v)| v).collect();
                    for pos in &mut batch {
                        if let Some(count) = message_counts.remove(&pos.hex_ident) {
                            pos.message_count = count;
                        }
                    }
                    let _ = app.emit("adsb:message", &batch);
```

**Step 3: Run Rust tests to verify no regressions**

Run: `cargo test --workspace`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src-tauri/src/bridge.rs
git commit -m "feat: count all SBS-1 messages per aircraft in bridge before throttling"
```

---

### Task 3: Add `message_count` to TypeScript types

**Files:**
- Modify: `src/lib/types.ts:1-14` (AircraftPosition interface)
- Modify: `src/lib/types.ts:16-33` (AircraftTrack interface)

**Step 1: Add field to both interfaces**

In `AircraftPosition` (after `timestamp: string;` line 13):

```typescript
  message_count: number;
```

In `AircraftTrack` (after `last_seen: number;` line 32):

```typescript
  /** Total SBS-1 messages received for this aircraft (pre-throttle cumulative count). */
  message_count: number;
```

**Step 2: Fix all TypeScript errors from missing field**

Update `makeTrack` helper in `src/contexts/__tests__/AircraftTrackingContext.test.ts` (add to defaults):

```typescript
    message_count: 0,
```

Update `makeTrack` helper in `src/components/__tests__/AircraftTable.test.tsx` (add to defaults):

```typescript
    message_count: 0,
```

Update `makeTrack` in `src/hooks/__tests__/useAircraftTracks.test.ts` — if it has a `makeTrack` helper, add the field there too.

**Step 3: Run TypeScript tests to verify no regressions**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/lib/types.ts src/contexts/__tests__/AircraftTrackingContext.test.ts src/components/__tests__/AircraftTable.test.tsx src/hooks/__tests__/useAircraftTracks.test.ts
git commit -m "feat: add message_count field to TypeScript AircraftPosition and AircraftTrack"
```

---

### Task 4: Accumulate message_count in AircraftTrackingContext

**Files:**
- Modify: `src/contexts/AircraftTrackingContext.tsx:28` (export mergePositionInto)
- Modify: `src/contexts/AircraftTrackingContext.tsx:28-43` (mergePositionInto body)
- Modify: `src/contexts/AircraftTrackingContext.tsx:66-87` (new track init in handleBatch)
- Test: `src/contexts/__tests__/AircraftTrackingContext.test.ts`

**Step 1: Write failing tests**

Add to `AircraftTrackingContext.test.ts`. First, update the import to include `mergePositionInto` (we'll export it in step 3):

```typescript
import { appendPosition, mergePositionInto } from "../AircraftTrackingContext";
import type { AircraftTrack, AircraftPosition } from "@/lib/types";
```

Add a helper for creating AircraftPosition:

```typescript
function makePosition(hex: string, overrides: Partial<AircraftPosition> = {}): AircraftPosition {
  return {
    hex_ident: hex,
    callsign: null,
    altitude: null,
    ground_speed: null,
    track: null,
    latitude: null,
    longitude: null,
    vertical_rate: null,
    squawk: null,
    is_on_ground: null,
    timestamp: "2024-01-15 10:30:00",
    message_count: 1,
    ...overrides,
  };
}
```

Add the test block:

```typescript
describe("mergePositionInto — message_count", () => {
  it("accumulates message_count from incoming position", () => {
    const track = makeTrack({ message_count: 10 });
    mergePositionInto(track, makePosition("A1B2C3", { message_count: 5 }), Date.now());
    expect(track.message_count).toBe(15);
  });

  it("accumulates across multiple merges", () => {
    const track = makeTrack({ message_count: 0 });
    mergePositionInto(track, makePosition("A1B2C3", { message_count: 3 }), Date.now());
    mergePositionInto(track, makePosition("A1B2C3", { message_count: 7 }), Date.now());
    expect(track.message_count).toBe(10);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/contexts/__tests__/AircraftTrackingContext.test.ts`
Expected: FAIL — `mergePositionInto is not exported` or `message_count is not accumulated`

**Step 3: Implement**

Export `mergePositionInto` — change line 28 from:

```typescript
function mergePositionInto(track: AircraftTrack, pos: AircraftPosition, now: number) {
```

to:

```typescript
export function mergePositionInto(track: AircraftTrack, pos: AircraftPosition, now: number) {
```

Add accumulation inside `mergePositionInto` (after `track.last_seen = now;` line 39):

```typescript
  track.message_count += pos.message_count;
```

Add initialization in `handleBatch` new track creation (after `last_seen: now,` line 81):

```typescript
          message_count: pos.message_count,
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/contexts/__tests__/AircraftTrackingContext.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/contexts/AircraftTrackingContext.tsx src/contexts/__tests__/AircraftTrackingContext.test.ts
git commit -m "feat: accumulate message_count in AircraftTrackingContext merge logic"
```

---

### Task 5: Add RxTS and Msg# columns to AircraftTable

**Files:**
- Modify: `src/components/AircraftTable.tsx:7-12` (SortKey type)
- Modify: `src/components/AircraftTable.tsx:74-85` (table header)
- Modify: `src/components/AircraftTable.tsx:88-137` (active row cells)
- Modify: `src/components/AircraftTable.tsx:140-196` (history section — colSpan and row cells)
- Modify: `src/components/AircraftTable.tsx:198-207` (empty state colSpan)
- Test: `src/components/__tests__/AircraftTable.test.tsx`

**Step 1: Write failing tests**

Add to `AircraftTable.test.tsx`:

```typescript
describe("AircraftTable columns", () => {
  it("renders RxTS column header", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123")]} />);
    expect(screen.getByText("RxTS")).toBeInTheDocument();
  });

  it("renders Msg# column header", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123")]} />);
    expect(screen.getByText("Msg#")).toBeInTheDocument();
  });

  it("displays relative time in RxTS column", () => {
    const twoMinAgo = Date.now() - 120_000;
    render(<AircraftTable tracks={[makeTrack("ABC123", { last_seen: twoMinAgo })]} />);
    expect(screen.getByText("2m ago")).toBeInTheDocument();
  });

  it("displays message count in Msg# column", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123", { message_count: 42 })]} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/__tests__/AircraftTable.test.tsx`
Expected: FAIL — "RxTS" and "Msg#" not found in document

**Step 3: Implement**

Add `last_seen` and `message_count` to `SortKey` union type (line 7-12):

```typescript
type SortKey =
  | "callsign"
  | "hex_ident"
  | "altitude"
  | "ground_speed"
  | "squawk"
  | "last_seen"
  | "message_count";
```

Add column headers in `<thead>` (after the Lon header, before closing `</tr>`):

```tsx
            <SortHeader label="RxTS" field="last_seen" />
            <SortHeader label="Msg#" field="message_count" />
```

Add cells to active track rows (after the Lon `<td>`, before closing `</tr>`):

```tsx
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {timeAgo(t.last_seen)}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.message_count.toLocaleString()}
              </td>
```

Update history divider `colSpan` from 9 to 11 (line 143).

Add cells to history track rows (after the Lon `<td>`, before closing `</tr>`):

```tsx
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {timeAgo(t.last_seen)}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.message_count.toLocaleString()}
              </td>
```

Update empty state `colSpan` from 9 to 11 (line 201).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/__tests__/AircraftTable.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/AircraftTable.tsx src/components/__tests__/AircraftTable.test.tsx
git commit -m "feat: add RxTS and Msg# sortable columns to AircraftTable"
```

---

### Task 6: Full CI verification

**Files:** None (verification only)

**Step 1: Run full Rust CI gate**

Run: `cd adsb-feed/rust && cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --workspace --check`
Expected: All pass

**Step 2: Run full TypeScript CI gate**

Run: `cd adsb-feed/rust/adsb-pulsar-client-desktop && npm test && npx next lint`
Expected: All pass

**Step 3: Verify test count increased**

Rust: should be ~85 tests (was ~84, +1 new)
TypeScript: should be ~88 tests (was ~84, +4 new)

**Step 4: Final commit if any formatting/lint fixes needed**

```bash
git add -A && git commit -m "chore: fix lint/format issues from RxTS and Msg# feature"
```
