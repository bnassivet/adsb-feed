# DuckDB History UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a HistoryBrowser panel in the left sidebar that lets users browse past aircraft from DuckDB and load their trajectories onto the map as imported tracks.

**Architecture:** Pure utility `recordsToTrack()` in `src/lib/history-convert.ts` converts `PositionRecord[]` → `AircraftTrack`. `HistoryBrowser` component calls `getStorageStats()`, `getAircraftSummary()`, and `getTrajectory()` from the existing command wrappers, then feeds results into the existing `importTracks` hook. No backend changes needed.

**Tech Stack:** React 19, Next.js 15, TypeScript, Vitest + @testing-library/react, Tailwind CSS v4

---

## Reference

- Design doc: `docs/plans/2026-02-23-duckdb-history-ui-design.md`
- Test runner: `npm test` (all), `npx vitest run src/lib/__tests__/history-convert.test.ts` (single file)
- All tests must stay green after each task: `npm test`
- Tauri mock: `src/test/mocks/tauri.ts` — mock `invoke` via `vi.mock("@tauri-apps/api/core", ...)`

---

### Task 1: `history-convert.ts` — pure `recordsToTrack` utility

**Files:**
- Create: `src/lib/history-convert.ts`
- Create: `src/lib/__tests__/history-convert.test.ts`

**Context:** `PositionRecord` rows from DuckDB are sorted by `timestamp_ms` and reconstructed into an `AircraftTrack`. The resulting track is injected into the existing imported-track pipeline (no map changes needed). The conversion must be a pure function — no side effects, no React — so it's fully testable.

**Step 1: Write the failing tests**

Create `src/lib/__tests__/history-convert.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { PositionRecord } from "@/lib/types";
import { recordsToTrack } from "@/lib/history-convert";

function makeRecord(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return {
    hex_ident: "ABCDEF",
    callsign: "TEST01",
    latitude: 48.0,
    longitude: 2.0,
    altitude: 10000,
    ground_speed: 250,
    track: 90,
    vertical_rate: 0,
    squawk: "7700",
    is_on_ground: false,
    timestamp_ms: 1_000_000,
    ...overrides,
  };
}

describe("recordsToTrack", () => {
  it("converts a single record to an AircraftTrack", () => {
    const record = makeRecord({ timestamp_ms: 1_000_000 });
    const track = recordsToTrack([record]);
    expect(track.hex_ident).toBe("ABCDEF");
    expect(track.callsign).toBe("TEST01");
    expect(track.latitude).toBe(48.0);
    expect(track.longitude).toBe(2.0);
    expect(track.altitude).toBe(10000);
    expect(track.first_seen).toBe(1_000_000);
    expect(track.last_seen).toBe(1_000_000);
    expect(track.message_count).toBe(1);
    expect(track.positions).toEqual([[48.0, 2.0, 10000]]);
  });

  it("sorts records by timestamp_ms before building positions", () => {
    const r1 = makeRecord({ timestamp_ms: 2_000, latitude: 48.2 });
    const r2 = makeRecord({ timestamp_ms: 1_000, latitude: 48.1 });
    const r3 = makeRecord({ timestamp_ms: 3_000, latitude: 48.3 });
    // Pass in unsorted order
    const track = recordsToTrack([r1, r2, r3]);
    expect(track.first_seen).toBe(1_000);
    expect(track.last_seen).toBe(3_000);
    expect(track.positions).toEqual([
      [48.1, expect.any(Number), expect.anything()],
      [48.2, expect.any(Number), expect.anything()],
      [48.3, expect.any(Number), expect.anything()],
    ]);
  });

  it("uses last (latest) record for scalar fields", () => {
    const r1 = makeRecord({ timestamp_ms: 1_000, altitude: 5000, callsign: "OLD" });
    const r2 = makeRecord({ timestamp_ms: 2_000, altitude: 10000, callsign: "NEW" });
    const track = recordsToTrack([r1, r2]);
    expect(track.altitude).toBe(10000);
    expect(track.callsign).toBe("NEW");
  });

  it("sets message_count to the number of records", () => {
    const records = [
      makeRecord({ timestamp_ms: 1_000 }),
      makeRecord({ timestamp_ms: 2_000 }),
      makeRecord({ timestamp_ms: 3_000 }),
    ];
    const track = recordsToTrack(records);
    expect(track.message_count).toBe(3);
  });

  it("handles null altitude in positions", () => {
    const record = makeRecord({ altitude: null });
    const track = recordsToTrack([record]);
    expect(track.positions[0][2]).toBeNull();
  });

  it("generates ISO timestamp string from last timestamp_ms", () => {
    const record = makeRecord({ timestamp_ms: 0 });
    const track = recordsToTrack([record]);
    expect(track.timestamp).toBe(new Date(0).toISOString());
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd adsb-pulsar-client-desktop
npx vitest run src/lib/__tests__/history-convert.test.ts
```

Expected: 6 failures — `recordsToTrack` not defined.

**Step 3: Implement `recordsToTrack`**

Create `src/lib/history-convert.ts`:

```ts
import type { AircraftTrack, PositionRecord } from "@/lib/types";

/**
 * Converts DuckDB PositionRecord rows for a single aircraft into an AircraftTrack
 * suitable for injection into the existing imported-track pipeline.
 *
 * Records are sorted by timestamp_ms. The latest record's scalar fields
 * (altitude, callsign, etc.) become the track's current state.
 */
export function recordsToTrack(records: PositionRecord[]): AircraftTrack {
  const sorted = [...records].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const last = sorted[sorted.length - 1];
  return {
    hex_ident: last.hex_ident,
    callsign: last.callsign,
    altitude: last.altitude,
    ground_speed: last.ground_speed,
    track: last.track,
    latitude: last.latitude,
    longitude: last.longitude,
    vertical_rate: last.vertical_rate,
    squawk: last.squawk,
    is_on_ground: last.is_on_ground,
    timestamp: new Date(last.timestamp_ms).toISOString(),
    positions: sorted.map(
      (r) => [r.latitude, r.longitude, r.altitude] as [number, number, number | null]
    ),
    first_seen: sorted[0].timestamp_ms,
    last_seen: last.timestamp_ms,
    message_count: sorted.length,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/__tests__/history-convert.test.ts
```

Expected: 6 tests pass.

**Step 5: Run full test suite**

```bash
npm test
```

Expected: all pass.

**Step 6: Commit**

```bash
git add src/lib/history-convert.ts src/lib/__tests__/history-convert.test.ts
git commit -m "feat: add recordsToTrack pure utility for DuckDB→AircraftTrack conversion"
```

---

### Task 2: `HistoryBrowser` component — storage stats strip

**Files:**
- Create: `src/components/HistoryBrowser.tsx`
- Create: `src/components/__tests__/HistoryBrowser.test.tsx`

**Context:** The stats strip shows DB health on mount. The Tauri `invoke` is mocked via `src/test/mocks/tauri.ts`. The component calls `getStorageStats()` and renders row count, DB size, oldest/newest timestamps. If storage is unavailable (command returns a string), it renders a "History unavailable" notice. The `importTracks` prop is wired in a later task — add it to the interface now but don't call it yet.

**Step 1: Write the failing tests**

Create `src/components/__tests__/HistoryBrowser.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HistoryBrowser } from "@/components/HistoryBrowser";
import type { AircraftTrack } from "@/lib/types";

// Mock the Tauri invoke function
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const STATS = {
  row_count: 42_000,
  db_size_bytes: 10_485_760, // 10 MB
  oldest_timestamp_ms: new Date("2026-02-20T10:00:00Z").getTime(),
  newest_timestamp_ms: new Date("2026-02-23T12:00:00Z").getTime(),
};

describe("HistoryBrowser", () => {
  const onImportTracks = vi.fn((_tracks: AircraftTrack[]) => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows storage stats after mount", async () => {
    mockInvoke.mockResolvedValue(STATS);
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => {
      expect(screen.getByText(/42,000/)).toBeInTheDocument();
    });
    expect(screen.getByText(/10\.0 MB/i)).toBeInTheDocument();
  });

  it("shows 'History unavailable' when storage is not available", async () => {
    mockInvoke.mockResolvedValue("Storage not available");
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => {
      expect(screen.getByText(/history unavailable/i)).toBeInTheDocument();
    });
  });

  it("shows 'Browse DB History' button when stats load successfully", async () => {
    mockInvoke.mockResolvedValue(STATS);
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => {
      expect(screen.getByText(/browse db history/i)).toBeInTheDocument();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/__tests__/HistoryBrowser.test.tsx
```

Expected: 3 failures — `HistoryBrowser` not defined.

**Step 3: Implement stats strip**

Create `src/components/HistoryBrowser.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { getStorageStats } from "@/lib/commands";
import type { AircraftTrack, StorageStats } from "@/lib/types";

interface Props {
  onImportTracks: (tracks: AircraftTrack[]) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

export function HistoryBrowser({ onImportTracks }: Props) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    getStorageStats().then((result) => {
      if (typeof result === "string") {
        setUnavailable(true);
      } else {
        setStats(result as StorageStats);
      }
    });
  }, []);

  if (unavailable) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500 italic">
        History unavailable
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Stats strip */}
      <div className="px-3 py-1.5 text-xs text-slate-400 border-b border-slate-800 space-y-0.5">
        <div className="flex justify-between">
          <span>Records</span>
          <span className="text-slate-300">{stats.row_count.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span>Size</span>
          <span className="text-slate-300">{formatBytes(stats.db_size_bytes)}</span>
        </div>
        <div className="flex justify-between">
          <span>Oldest</span>
          <span className="text-slate-300">{formatMs(stats.oldest_timestamp_ms)}</span>
        </div>
        <div className="flex justify-between">
          <span>Newest</span>
          <span className="text-slate-300">{formatMs(stats.newest_timestamp_ms)}</span>
        </div>
      </div>

      {/* Browse button — wired in Task 3 */}
      <div className="px-3 py-1">
        <button
          className="w-full px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition"
        >
          Browse DB History
        </button>
      </div>
    </div>
  );
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/__tests__/HistoryBrowser.test.tsx
```

Expected: 3 tests pass.

**Step 5: Run full test suite**

```bash
npm test
```

Expected: all pass.

**Step 6: Commit**

```bash
git add src/components/HistoryBrowser.tsx src/components/__tests__/HistoryBrowser.test.tsx
git commit -m "feat: add HistoryBrowser component with storage stats strip"
```

---

### Task 3: `HistoryBrowser` — aircraft list + trajectory load

**Files:**
- Modify: `src/components/HistoryBrowser.tsx`
- Modify: `src/components/__tests__/HistoryBrowser.test.tsx`

**Context:** Clicking "Browse DB History" expands a panel showing time-range inputs and a list of `AircraftSummary` rows from `getAircraftSummary()`. Clicking a row calls `getTrajectory()` and converts the records to an `AircraftTrack` via `recordsToTrack()`, then calls `onImportTracks([track])`.

**Step 1: Write the failing tests**

Add to `src/components/__tests__/HistoryBrowser.test.tsx`, inside the `describe` block:

```tsx
import userEvent from "@testing-library/user-event";
import { getAircraftSummary, getTrajectory } from "@/lib/commands";

// Add these mocks at the top of the file (alongside the tauri mock):
vi.mock("@/lib/commands", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/commands")>();
  return {
    ...real,
    getStorageStats: vi.fn(),
    getAircraftSummary: vi.fn(),
    getTrajectory: vi.fn(),
  };
});
import { getStorageStats, getAircraftSummary as mockGetAircraftSummary, getTrajectory as mockGetTrajectory } from "@/lib/commands";

const SUMMARY = [
  {
    hex_ident: "AAAAAA",
    callsign: "SKY001",
    position_count: 100,
    first_seen_ms: 1_000_000,
    last_seen_ms: 2_000_000,
    min_altitude: 5000,
    max_altitude: 35000,
  },
];

const POSITIONS = [
  {
    hex_ident: "AAAAAA",
    callsign: "SKY001",
    latitude: 48.5,
    longitude: 2.3,
    altitude: 30000,
    ground_speed: 450,
    track: 270,
    vertical_rate: -200,
    squawk: null,
    is_on_ground: false,
    timestamp_ms: 1_500_000,
  },
];
```

Then add three tests:

```tsx
it("shows aircraft list when Browse DB History is clicked", async () => {
  vi.mocked(getStorageStats).mockResolvedValue(STATS);
  vi.mocked(mockGetAircraftSummary).mockResolvedValue(SUMMARY);
  render(<HistoryBrowser onImportTracks={onImportTracks} />);
  await waitFor(() => screen.getByText(/browse db history/i));
  await userEvent.click(screen.getByText(/browse db history/i));
  await waitFor(() => {
    expect(screen.getByText("SKY001")).toBeInTheDocument();
  });
});

it("calls onImportTracks with converted track when aircraft row is clicked", async () => {
  vi.mocked(getStorageStats).mockResolvedValue(STATS);
  vi.mocked(mockGetAircraftSummary).mockResolvedValue(SUMMARY);
  vi.mocked(mockGetTrajectory).mockResolvedValue(POSITIONS);
  render(<HistoryBrowser onImportTracks={onImportTracks} />);
  await waitFor(() => screen.getByText(/browse db history/i));
  await userEvent.click(screen.getByText(/browse db history/i));
  await waitFor(() => screen.getByText("SKY001"));
  await userEvent.click(screen.getByText("SKY001"));
  await waitFor(() => {
    expect(onImportTracks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ hex_ident: "AAAAAA", callsign: "SKY001" }),
      ])
    );
  });
});

it("shows time range inputs when Browse is open", async () => {
  vi.mocked(getStorageStats).mockResolvedValue(STATS);
  vi.mocked(mockGetAircraftSummary).mockResolvedValue(SUMMARY);
  render(<HistoryBrowser onImportTracks={onImportTracks} />);
  await waitFor(() => screen.getByText(/browse db history/i));
  await userEvent.click(screen.getByText(/browse db history/i));
  await waitFor(() => {
    expect(screen.getByLabelText(/start/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/end/i)).toBeInTheDocument();
  });
});
```

> **Note on mocking:** The tests mock `@/lib/commands` module directly (not the Tauri invoke). This is cleaner for component tests — see existing `commands.test.ts` for the Tauri-invoke pattern, and existing component tests for module-level mocking.

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/__tests__/HistoryBrowser.test.tsx
```

Expected: 3 new failures — Browse panel not implemented yet.

**Step 3: Extend `HistoryBrowser` with browse panel**

Replace the content of `src/components/HistoryBrowser.tsx` with the full implementation:

```tsx
"use client";
import { useEffect, useState } from "react";
import { getStorageStats, getAircraftSummary, getTrajectory } from "@/lib/commands";
import { recordsToTrack } from "@/lib/history-convert";
import type { AircraftSummary, AircraftTrack, StorageStats } from "@/lib/types";

interface Props {
  onImportTracks: (tracks: AircraftTrack[]) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

/** Returns a datetime-local string (YYYY-MM-DDTHH:MM) from ms epoch. */
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function HistoryBrowser({ onImportTracks }: Props) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [summaries, setSummaries] = useState<AircraftSummary[]>([]);
  const [loading, setLoading] = useState(false);

  // Default time range: last 1 hour
  const now = Date.now();
  const [startVal, setStartVal] = useState(() => toDatetimeLocal(now - 60 * 60 * 1000));
  const [endVal, setEndVal] = useState(() => toDatetimeLocal(now));

  useEffect(() => {
    getStorageStats().then((result) => {
      if (typeof result === "string") {
        setUnavailable(true);
      } else {
        setStats(result as StorageStats);
      }
    });
  }, []);

  async function handleBrowse() {
    if (!browsing) {
      setBrowsing(true);
    }
    setLoading(true);
    const startMs = new Date(startVal).getTime();
    const endMs = new Date(endVal).getTime();
    const results = await getAircraftSummary(startMs, endMs);
    setSummaries(typeof results === "string" ? [] : (results as AircraftSummary[]));
    setLoading(false);
  }

  async function handleLoadTrajectory(summary: AircraftSummary) {
    const startMs = new Date(startVal).getTime();
    const endMs = new Date(endVal).getTime();
    const records = await getTrajectory({
      hex_ident: summary.hex_ident,
      start_ms: startMs,
      end_ms: endMs,
    });
    if (typeof records === "string" || !Array.isArray(records) || records.length === 0) return;
    const track = recordsToTrack(records);
    onImportTracks([track]);
  }

  if (unavailable) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500 italic">
        History unavailable
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Stats strip */}
      <div className="px-3 py-1.5 text-xs text-slate-400 border-b border-slate-800 space-y-0.5">
        <div className="flex justify-between">
          <span>Records</span>
          <span className="text-slate-300">{stats.row_count.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span>Size</span>
          <span className="text-slate-300">{formatBytes(stats.db_size_bytes)}</span>
        </div>
        <div className="flex justify-between">
          <span>Oldest</span>
          <span className="text-slate-300">{formatMs(stats.oldest_timestamp_ms)}</span>
        </div>
        <div className="flex justify-between">
          <span>Newest</span>
          <span className="text-slate-300">{formatMs(stats.newest_timestamp_ms)}</span>
        </div>
      </div>

      {/* Browse button */}
      <div className="px-3 py-1">
        <button
          onClick={handleBrowse}
          className="w-full px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition"
        >
          Browse DB History
        </button>
      </div>

      {/* Time range + aircraft list */}
      {browsing && (
        <div className="flex flex-col gap-1 px-3 pb-2">
          <label className="text-xs text-slate-400">
            Start
            <input
              type="datetime-local"
              value={startVal}
              onChange={(e) => setStartVal(e.target.value)}
              className="block w-full mt-0.5 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200"
            />
          </label>
          <label className="text-xs text-slate-400">
            End
            <input
              type="datetime-local"
              value={endVal}
              onChange={(e) => setEndVal(e.target.value)}
              className="block w-full mt-0.5 px-1.5 py-0.5 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200"
            />
          </label>
          <button
            onClick={handleBrowse}
            disabled={loading}
            className="px-2 py-0.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded transition disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>

          {summaries.length === 0 && !loading && (
            <p className="text-xs text-slate-500 italic">No aircraft found.</p>
          )}

          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
            {summaries.map((s) => (
              <button
                key={s.hex_ident}
                onClick={() => handleLoadTrajectory(s)}
                className="text-left px-2 py-1 text-xs rounded hover:bg-slate-700 transition"
                title={`Load trajectory for ${s.hex_ident}`}
              >
                <span className="text-slate-200 font-mono">
                  {s.callsign ?? s.hex_ident}
                </span>
                <span className="text-slate-500 ml-1">
                  ({s.position_count} pts)
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/__tests__/HistoryBrowser.test.tsx
```

Expected: all 6 tests pass.

**Step 5: Run full test suite**

```bash
npm test
```

Expected: all pass.

**Step 6: Commit**

```bash
git add src/components/HistoryBrowser.tsx src/components/__tests__/HistoryBrowser.test.tsx
git commit -m "feat: extend HistoryBrowser with aircraft list and trajectory loading"
```

---

### Task 4: Wire `HistoryBrowser` into `FiltersPanel` → `LeftPanel` → `page.tsx`

**Files:**
- Modify: `src/components/Filters.tsx`
- Modify: `src/components/LeftPanel.tsx`
- Modify: `src/app/page.tsx`

**Context:** `importTracks` already exists in `page.tsx` via `useAircraftTracks`. We thread it down the prop chain so `HistoryBrowser` can call it. Three surgical edits — no new tests needed (this is prop-threading integration; covered by the HistoryBrowser tests above).

**Step 1: Add `HistoryBrowser` section to `FiltersPanel`**

Open `src/components/Filters.tsx`. Find the end of `FiltersPanel`'s JSX (the last closing `</div>` before the function closes). Add the History section and the new prop.

First, find the `FiltersPanel` props interface (look for `interface FiltersPanelProps` or similar). Add:

```tsx
onImportTracks: (tracks: AircraftTrack[]) => void;
```

Import `AircraftTrack` from `@/lib/types` if not already imported. Import `HistoryBrowser` from `@/components/HistoryBrowser`.

At the bottom of `FiltersPanel`'s JSX, just before the final closing `</div>`, add:

```tsx
{/* DuckDB History Browser */}
<div className="border-t border-slate-700 pt-2 mt-2">
  <div className="px-3 pb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">
    DB History
  </div>
  <HistoryBrowser onImportTracks={onImportTracks} />
</div>
```

Destructure `onImportTracks` in `FiltersPanel`'s parameter list.

**Step 2: Thread `onImportTracks` through `LeftPanel`**

In `src/components/LeftPanel.tsx`, add `onImportTracks` to `LeftPanelProps`:

```tsx
onImportTracks: (tracks: AircraftTrack[]) => void;
```

Import `AircraftTrack` from `@/lib/types`. Pass it through `filterProps` (it's spread via `{...filterProps}` to `FiltersPanel`, so no extra change needed there as long as it's part of `filterProps`).

> `filterProps` is typed as `Omit<LeftPanelProps, "isOpen" | "width" | "onToggle" | "onWidthChange">` — `onImportTracks` will be included automatically.

**Step 3: Pass `importTracks` from `page.tsx`**

In `src/app/page.tsx`, find the `LeftPanel` usage (line ~243). Add the prop:

```tsx
onImportTracks={importTracks}
```

`importTracks` is already destructured from `useAircraftTracks` at line ~44.

**Step 4: Run full test suite**

```bash
npm test
```

Expected: all pass. (The type change in `FiltersPanel` props will cause a TS error if the prop is missing anywhere — the test suite catches this indirectly; `npx tsc --noEmit` in Task 5 catches it directly.)

**Step 5: Commit**

```bash
git add src/components/Filters.tsx src/components/LeftPanel.tsx src/app/page.tsx
git commit -m "feat: wire HistoryBrowser into FiltersPanel via LeftPanel prop threading"
```

---

### Task 5: Final verification

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

**Step 3: Manual smoke test (optional)**

```bash
npm run tauri dev
```

Verify:
1. Left panel shows "DB History" section with record count + DB size
2. Click "Browse DB History" → time range inputs appear + aircraft list loads
3. Click an aircraft row → trajectory appears on map as imported track (indigo polyline)
4. Details panel shows IMPORTED badge when trajectory track is selected
5. "Clear import" button in header removes the loaded trajectory

---

## Summary

| Task | Files | Tests |
|------|-------|-------|
| 1 | `history-convert.ts` | 6 new: sort, scalars, null altitude, message_count |
| 2 | `HistoryBrowser.tsx` | 3 new: stats, unavailable, browse button |
| 3 | `HistoryBrowser.tsx` | 3 new: aircraft list, trajectory load, time inputs |
| 4 | `Filters.tsx`, `LeftPanel.tsx`, `page.tsx` | None (prop threading) |
| 5 | CI gate | Full suite |

**Total new tests:** 12
**Files changed:** 6 (2 created, 4 modified) + 2 test files created
