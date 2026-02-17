# Export/Import Aircraft Track History — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to export all tracked aircraft (active + history) to a GeoJSON file and import previously exported files as a visually distinct overlay layer.

**Architecture:** Frontend-only approach. Pure functions convert between `AircraftTrack` and GeoJSON `FeatureCollection`. Tauri's `dialog` and `fs` plugins handle native file dialogs and disk I/O. Imported tracks live in a separate `importedRef` Map in `AircraftTrackingContext` with no TTL. Both History and Imported table sections are collapsible.

**Tech Stack:** TypeScript, React 19, Tauri v2 dialog/fs plugins, GeoJSON (RFC 7946), Vitest

---

## Task 1: Install Tauri dialog and fs plugins

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `package.json` (npm dependency)

**Step 1: Install npm packages**

Run:
```bash
cd adsb-pulsar-client-desktop
npm install @tauri-apps/plugin-dialog @tauri-apps/plugin-fs
```

**Step 2: Add Rust plugin dependencies to `src-tauri/Cargo.toml`**

Add to `[dependencies]`:
```toml
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
```

**Step 3: Register plugins in `src-tauri/src/lib.rs`**

In the `tauri::Builder::default()` chain, add after the existing `.plugin(...)` calls:
```rust
.plugin(tauri_plugin_dialog::init())
.plugin(tauri_plugin_fs::init())
```

**Step 4: Add permissions in `src-tauri/capabilities/default.json`**

Add to the `permissions` array:
```json
"dialog:default",
"fs:default"
```

**Step 5: Verify it builds**

Run: `cd adsb-pulsar-client-desktop && npm run tauri build -- --debug 2>&1 | tail -20`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/capabilities/default.json package.json package-lock.json
git commit -m "chore: add Tauri dialog and fs plugins for export/import"
```

---

## Task 2: GeoJSON conversion — `tracksToGeoJSON`

**Files:**
- Create: `src/lib/geojson.ts`
- Create: `src/lib/__tests__/geojson.test.ts`

**Step 1: Write failing tests for `tracksToGeoJSON`**

Create `src/lib/__tests__/geojson.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { tracksToGeoJSON } from "@/lib/geojson";
import type { AircraftTrack } from "@/lib/types";

function makeTrack(overrides: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "A1B2C3",
    callsign: "AAL123",
    altitude: 35000,
    ground_speed: 450,
    track: 90,
    latitude: 48.86,
    longitude: 2.35,
    vertical_rate: 0,
    squawk: "1200",
    is_on_ground: false,
    timestamp: "2026/02/16 14:30:00.000",
    positions: [[48.86, 2.35, 35000], [48.88, 2.40, 35500]],
    last_seen: 1739712600000,
    message_count: 847,
    ...overrides,
  };
}

describe("tracksToGeoJSON", () => {
  it("converts tracks to a valid FeatureCollection", () => {
    const track = makeTrack();
    const result = tracksToGeoJSON([track], []);

    expect(result.type).toBe("FeatureCollection");
    expect(result.metadata.source).toBe("adsb-pulsar-client-desktop");
    expect(result.metadata.version).toBe(1);
    expect(result.metadata.track_count).toBe(1);
    expect(typeof result.metadata.exported_at).toBe("string");
  });

  it("creates LineString geometry with [lng, lat, alt] coordinates", () => {
    const track = makeTrack();
    const result = tracksToGeoJSON([track], []);
    const feature = result.features[0];

    expect(feature.type).toBe("Feature");
    expect(feature.geometry.type).toBe("LineString");
    // GeoJSON order: [lng, lat, alt]
    expect(feature.geometry.coordinates).toEqual([
      [2.35, 48.86, 35000],
      [2.40, 48.88, 35500],
    ]);
  });

  it("stores all track properties in feature properties", () => {
    const track = makeTrack();
    const result = tracksToGeoJSON([track], []);
    const props = result.features[0].properties;

    expect(props.hex_ident).toBe("A1B2C3");
    expect(props.callsign).toBe("AAL123");
    expect(props.altitude).toBe(35000);
    expect(props.ground_speed).toBe(450);
    expect(props.track).toBe(90);
    expect(props.vertical_rate).toBe(0);
    expect(props.squawk).toBe("1200");
    expect(props.is_on_ground).toBe(false);
    expect(props.timestamp).toBe("2026/02/16 14:30:00.000");
    expect(props.last_seen).toBe(1739712600000);
    expect(props.message_count).toBe(847);
  });

  it("combines active and history tracks", () => {
    const active = makeTrack({ hex_ident: "ACTIVE" });
    const hist = makeTrack({ hex_ident: "HIST01" });
    const result = tracksToGeoJSON([active], [hist]);

    expect(result.features).toHaveLength(2);
    expect(result.metadata.track_count).toBe(2);
    expect(result.features.map(f => f.properties.hex_ident)).toEqual(["ACTIVE", "HIST01"]);
  });

  it("handles track with no positions as Point at [0,0]", () => {
    const track = makeTrack({ positions: [], latitude: null, longitude: null });
    const result = tracksToGeoJSON([track], []);
    const feature = result.features[0];

    expect(feature.geometry.type).toBe("Point");
    expect(feature.geometry.coordinates).toEqual([0, 0]);
    expect(feature.properties.no_position).toBe(true);
  });

  it("handles track with single position as Point", () => {
    const track = makeTrack({ positions: [[48.86, 2.35, 10000]] });
    const result = tracksToGeoJSON([track], []);
    const feature = result.features[0];

    expect(feature.geometry.type).toBe("Point");
    expect(feature.geometry.coordinates).toEqual([2.35, 48.86, 10000]);
  });

  it("returns empty features for no tracks", () => {
    const result = tracksToGeoJSON([], []);

    expect(result.features).toEqual([]);
    expect(result.metadata.track_count).toBe(0);
  });

  it("handles null altitude in positions", () => {
    const track = makeTrack({ positions: [[48.86, 2.35, null], [48.88, 2.40, 10000]] });
    const result = tracksToGeoJSON([track], []);

    expect(result.features[0].geometry.coordinates).toEqual([
      [2.35, 48.86, null],
      [2.40, 48.88, 10000],
    ]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/geojson.test.ts`
Expected: FAIL — module `@/lib/geojson` not found

**Step 3: Implement `tracksToGeoJSON`**

Create `src/lib/geojson.ts`:

```typescript
import type { AircraftTrack } from "./types";

/** GeoJSON FeatureCollection with app metadata. */
export interface TrackGeoJSON {
  type: "FeatureCollection";
  metadata: {
    exported_at: string;
    source: string;
    version: number;
    track_count: number;
  };
  features: TrackFeature[];
}

type TrackGeometry =
  | { type: "LineString"; coordinates: [number, number, number | null][] }
  | { type: "Point"; coordinates: [number, number] | [number, number, number | null] };

export interface TrackFeature {
  type: "Feature";
  geometry: TrackGeometry;
  properties: TrackProperties;
}

export interface TrackProperties {
  hex_ident: string;
  callsign: string | null;
  altitude: number | null;
  ground_speed: number | null;
  track: number | null;
  vertical_rate: number | null;
  squawk: string | null;
  is_on_ground: boolean | null;
  timestamp: string;
  last_seen: number;
  message_count: number;
  no_position?: boolean;
}

/** Convert AircraftTrack arrays to a GeoJSON FeatureCollection. */
export function tracksToGeoJSON(
  activeTracks: AircraftTrack[],
  historyTracks: AircraftTrack[],
): TrackGeoJSON {
  const allTracks = [...activeTracks, ...historyTracks];

  return {
    type: "FeatureCollection",
    metadata: {
      exported_at: new Date().toISOString(),
      source: "adsb-pulsar-client-desktop",
      version: 1,
      track_count: allTracks.length,
    },
    features: allTracks.map(trackToFeature),
  };
}

function trackToFeature(track: AircraftTrack): TrackFeature {
  const properties: TrackProperties = {
    hex_ident: track.hex_ident,
    callsign: track.callsign,
    altitude: track.altitude,
    ground_speed: track.ground_speed,
    track: track.track,
    vertical_rate: track.vertical_rate,
    squawk: track.squawk,
    is_on_ground: track.is_on_ground,
    timestamp: track.timestamp,
    last_seen: track.last_seen,
    message_count: track.message_count,
  };

  // No positions — emit Point at [0, 0] with marker
  if (track.positions.length === 0) {
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { ...properties, no_position: true },
    };
  }

  // Single position — emit Point
  if (track.positions.length === 1) {
    const [lat, lng, alt] = track.positions[0];
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat, alt] },
      properties,
    };
  }

  // Multiple positions — emit LineString
  // Convert internal [lat, lng, alt] to GeoJSON [lng, lat, alt]
  const coordinates = track.positions.map(
    ([lat, lng, alt]) => [lng, lat, alt] as [number, number, number | null],
  );

  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/geojson.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add src/lib/geojson.ts src/lib/__tests__/geojson.test.ts
git commit -m "feat: add tracksToGeoJSON conversion function"
```

---

## Task 3: GeoJSON conversion — `geoJSONToTracks`

**Files:**
- Modify: `src/lib/geojson.ts`
- Modify: `src/lib/__tests__/geojson.test.ts`

**Step 1: Write failing tests for `geoJSONToTracks`**

Append to `src/lib/__tests__/geojson.test.ts`:

```typescript
import { geoJSONToTracks } from "@/lib/geojson";

describe("geoJSONToTracks", () => {
  it("round-trips tracks through GeoJSON and back", () => {
    const original = makeTrack();
    const geojson = tracksToGeoJSON([original], []);
    const result = geoJSONToTracks(geojson);

    expect(result).toHaveLength(1);
    expect(result[0].hex_ident).toBe("A1B2C3");
    expect(result[0].callsign).toBe("AAL123");
    expect(result[0].altitude).toBe(35000);
    expect(result[0].message_count).toBe(847);
    // Positions should be back in [lat, lng, alt] order
    expect(result[0].positions).toEqual([[48.86, 2.35, 35000], [48.88, 2.40, 35500]]);
  });

  it("handles Point features with no_position flag", () => {
    const track = makeTrack({ positions: [], latitude: null, longitude: null });
    const geojson = tracksToGeoJSON([track], []);
    const result = geoJSONToTracks(geojson);

    expect(result).toHaveLength(1);
    expect(result[0].positions).toEqual([]);
  });

  it("handles single-position Point features", () => {
    const track = makeTrack({ positions: [[48.86, 2.35, 10000]] });
    const geojson = tracksToGeoJSON([track], []);
    const result = geoJSONToTracks(geojson);

    expect(result).toHaveLength(1);
    expect(result[0].positions).toEqual([[48.86, 2.35, 10000]]);
  });

  it("skips features without hex_ident", () => {
    const geojson: TrackGeoJSON = {
      type: "FeatureCollection",
      metadata: { exported_at: "", source: "", version: 1, track_count: 1 },
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: {
          hex_ident: "",  // empty
          callsign: null, altitude: null, ground_speed: null, track: null,
          vertical_rate: null, squawk: null, is_on_ground: null,
          timestamp: "", last_seen: 0, message_count: 0,
        },
      }],
    };
    const result = geoJSONToTracks(geojson);
    expect(result).toHaveLength(0);
  });

  it("rejects invalid JSON structure", () => {
    expect(() => geoJSONToTracks({ type: "wrong" } as unknown as TrackGeoJSON)).toThrow();
  });
});
```

**Step 2: Run tests to verify new tests fail**

Run: `npx vitest run src/lib/__tests__/geojson.test.ts`
Expected: FAIL — `geoJSONToTracks` not exported

**Step 3: Implement `geoJSONToTracks`**

Add to `src/lib/geojson.ts`:

```typescript
/** Parse a GeoJSON FeatureCollection back into AircraftTrack[]. Skips invalid features. */
export function geoJSONToTracks(geojson: TrackGeoJSON): AircraftTrack[] {
  if (geojson.type !== "FeatureCollection") {
    throw new Error(`Invalid GeoJSON: expected FeatureCollection, got "${geojson.type}"`);
  }

  const tracks: AircraftTrack[] = [];

  for (const feature of geojson.features) {
    const props = feature.properties;
    if (!props.hex_ident) continue; // skip features without hex_ident

    let positions: [number, number, number | null][] = [];

    if (feature.geometry.type === "LineString") {
      // Convert GeoJSON [lng, lat, alt] back to internal [lat, lng, alt]
      positions = feature.geometry.coordinates.map(
        ([lng, lat, alt]) => [lat, lng, alt] as [number, number, number | null],
      );
    } else if (feature.geometry.type === "Point" && !props.no_position) {
      const coords = feature.geometry.coordinates;
      const alt = coords.length >= 3 ? (coords[2] as number | null) : null;
      positions = [[coords[1] as number, coords[0] as number, alt]];
    }
    // Point with no_position: positions stays []

    tracks.push({
      hex_ident: props.hex_ident,
      callsign: props.callsign,
      altitude: props.altitude,
      ground_speed: props.ground_speed,
      track: props.track,
      latitude: positions.length > 0 ? positions[positions.length - 1][0] : null,
      longitude: positions.length > 0 ? positions[positions.length - 1][1] : null,
      vertical_rate: props.vertical_rate,
      squawk: props.squawk,
      is_on_ground: props.is_on_ground,
      timestamp: props.timestamp,
      positions,
      last_seen: props.last_seen,
      message_count: props.message_count,
    });
  }

  return tracks;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/geojson.test.ts`
Expected: All 12 tests PASS

**Step 5: Run full test suite to check for regressions**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/lib/geojson.ts src/lib/__tests__/geojson.test.ts
git commit -m "feat: add geoJSONToTracks conversion for import"
```

---

## Task 4: Add Tauri dialog/fs mocks for tests

**Files:**
- Modify: `src/test/mocks/tauri.ts`

**Step 1: Add mocks for dialog and fs plugins**

Append to `src/test/mocks/tauri.ts`:

```typescript
// Mock @tauri-apps/plugin-dialog
const mockDialogSave = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
const mockDialogOpen = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);

export function mockSaveDialogResponse(path: string | null): void {
  mockDialogSave.mockResolvedValueOnce(path);
}

export function mockOpenDialogResponse(path: string | null): void {
  mockDialogOpen.mockResolvedValueOnce(path);
}

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockDialogSave(...args),
  open: (...args: unknown[]) => mockDialogOpen(...args),
}));

// Mock @tauri-apps/plugin-fs
const mockWriteTextFile = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockReadTextFile = vi.fn<() => Promise<string>>().mockResolvedValue("");

export function mockReadFileResponse(content: string): void {
  mockReadTextFile.mockResolvedValueOnce(content);
}

export { mockWriteTextFile, mockReadTextFile };

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
  readTextFile: (...args: unknown[]) => mockReadTextFile(...args),
}));
```

**Step 2: Verify existing tests still pass**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass (new mocks don't affect existing tests)

**Step 3: Commit**

```bash
git add src/test/mocks/tauri.ts
git commit -m "test: add dialog and fs plugin mocks for export/import tests"
```

---

## Task 5: Export/import file operations

**Files:**
- Create: `src/lib/file-io.ts`
- Create: `src/lib/__tests__/file-io.test.ts`

**Step 1: Write failing tests for file I/O functions**

Create `src/lib/__tests__/file-io.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import "@/test/mocks/tauri";
import {
  mockSaveDialogResponse,
  mockOpenDialogResponse,
  mockWriteTextFile,
  mockReadTextFile,
  mockReadFileResponse,
} from "@/test/mocks/tauri";
import { exportTracksToFile, importTracksFromFile } from "@/lib/file-io";
import { tracksToGeoJSON } from "@/lib/geojson";
import type { AircraftTrack } from "@/lib/types";

function makeTrack(overrides: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "A1B2C3",
    callsign: "AAL123",
    altitude: 35000,
    ground_speed: 450,
    track: 90,
    latitude: 48.86,
    longitude: 2.35,
    vertical_rate: 0,
    squawk: "1200",
    is_on_ground: false,
    timestamp: "2026/02/16 14:30:00.000",
    positions: [[48.86, 2.35, 35000]],
    last_seen: 1739712600000,
    message_count: 100,
    ...overrides,
  };
}

describe("exportTracksToFile", () => {
  beforeEach(() => {
    mockWriteTextFile.mockClear();
  });

  it("opens save dialog and writes GeoJSON to selected path", async () => {
    mockSaveDialogResponse("/tmp/tracks.geojson");
    const track = makeTrack();

    const result = await exportTracksToFile([track], []);

    expect(result).toBe(true);
    expect(mockWriteTextFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteTextFile.mock.calls[0];
    expect(path).toBe("/tmp/tracks.geojson");
    const parsed = JSON.parse(content as string);
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features).toHaveLength(1);
  });

  it("returns false when user cancels save dialog", async () => {
    mockSaveDialogResponse(null);

    const result = await exportTracksToFile([], []);

    expect(result).toBe(false);
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });
});

describe("importTracksFromFile", () => {
  beforeEach(() => {
    mockReadTextFile.mockClear();
  });

  it("opens file dialog, reads file, returns parsed tracks", async () => {
    const track = makeTrack();
    const geojson = tracksToGeoJSON([track], []);
    mockOpenDialogResponse("/tmp/tracks.geojson");
    mockReadFileResponse(JSON.stringify(geojson));

    const result = await importTracksFromFile();

    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
    expect(result![0].hex_ident).toBe("A1B2C3");
  });

  it("returns null when user cancels open dialog", async () => {
    mockOpenDialogResponse(null);

    const result = await importTracksFromFile();

    expect(result).toBeNull();
    expect(mockReadTextFile).not.toHaveBeenCalled();
  });

  it("throws on invalid JSON", async () => {
    mockOpenDialogResponse("/tmp/bad.json");
    mockReadFileResponse("not json");

    await expect(importTracksFromFile()).rejects.toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/file-io.test.ts`
Expected: FAIL — module not found

**Step 3: Implement file I/O functions**

Create `src/lib/file-io.ts`:

```typescript
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { tracksToGeoJSON, geoJSONToTracks } from "./geojson";
import type { AircraftTrack } from "./types";
import type { TrackGeoJSON } from "./geojson";

/** Export tracks to a GeoJSON file via native save dialog. Returns true if saved, false if cancelled. */
export async function exportTracksToFile(
  activeTracks: AircraftTrack[],
  historyTracks: AircraftTrack[],
): Promise<boolean> {
  const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultName = `adsb-tracks-${now}.geojson`;

  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
  });

  if (!path) return false;

  const geojson = tracksToGeoJSON(activeTracks, historyTracks);
  const content = JSON.stringify(geojson, null, 2);
  await writeTextFile(path, content);

  return true;
}

/** Import tracks from a GeoJSON file via native open dialog. Returns tracks or null if cancelled. */
export async function importTracksFromFile(): Promise<AircraftTrack[] | null> {
  const path = await open({
    multiple: false,
    filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
  });

  if (!path) return null;

  const content = await readTextFile(path as string);
  const geojson: TrackGeoJSON = JSON.parse(content);

  return geoJSONToTracks(geojson);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/file-io.test.ts`
Expected: All 5 tests PASS

**Step 5: Run full test suite**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/lib/file-io.ts src/lib/__tests__/file-io.test.ts
git commit -m "feat: add file I/O functions for export/import via Tauri dialog"
```

---

## Task 6: Add imported tracks to AircraftTrackingContext

**Files:**
- Modify: `src/contexts/AircraftTrackingContext.tsx`
- Modify: `src/contexts/__tests__/AircraftTrackingContext.test.ts`

**Step 1: Write failing tests**

Add a new `describe("imported tracks")` block to the existing context test file. If the test file does not exist yet, create `src/contexts/__tests__/AircraftTrackingContext.test.ts`:

```typescript
// Add to existing test file or create new
import { describe, it, expect } from "vitest";
import "@/test/mocks/tauri";

describe("imported tracks in context", () => {
  // These tests verify the interface changes — the actual context integration
  // is tested via useAircraftTracks hook tests in Task 7
});
```

The key changes to `AircraftTrackingContext.tsx` are:
1. Add `importedRef: useRef<Map<string, AircraftTrack>>(new Map())`
2. Add `importTracks(tracks: AircraftTrack[])` callback that populates `importedRef`
3. Add `clearImported()` callback that clears `importedRef`
4. Expose `imported` Map and callbacks in context value

**Step 2: Modify context interface and provider**

In `src/contexts/AircraftTrackingContext.tsx`:

Add to `AircraftTrackingContextValue`:
```typescript
interface AircraftTrackingContextValue {
  tracks: Map<string, AircraftTrack>;
  history: Map<string, AircraftTrack>;
  imported: Map<string, AircraftTrack>;
  version: number;
  importTracks: (tracks: AircraftTrack[]) => void;
  clearImported: () => void;
}
```

In the provider, add:
```typescript
const importedRef = useRef<Map<string, AircraftTrack>>(new Map());

const importTracks = useCallback((tracks: AircraftTrack[]) => {
  const map = importedRef.current;
  map.clear();
  for (const t of tracks) {
    map.set(t.hex_ident, t);
  }
  setUpdateCounter((c) => c + 1);
}, []);

const clearImported = useCallback(() => {
  importedRef.current.clear();
  setUpdateCounter((c) => c + 1);
}, []);
```

Update the memoized value:
```typescript
const value = useMemo<AircraftTrackingContextValue>(
  () => ({
    tracks: tracksRef.current,
    history: historyRef.current,
    imported: importedRef.current,
    version: updateCounter,
    importTracks,
    clearImported,
  }),
  [updateCounter, importTracks, clearImported],
);
```

**Step 3: Run all tests**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass (existing consumers destructure only what they use)

**Step 4: Commit**

```bash
git add src/contexts/AircraftTrackingContext.tsx
git commit -m "feat: add imported tracks state to AircraftTrackingContext"
```

---

## Task 7: Expose imported tracks in useAircraftTracks hook

**Files:**
- Modify: `src/hooks/useAircraftTracks.ts`
- Modify: `src/hooks/__tests__/useAircraftTracks.test.ts` (if exists, or the context tests)

**Step 1: Update hook to return imported tracks**

In `src/hooks/useAircraftTracks.ts`, add:

```typescript
export function useAircraftTracks(filters: Filters) {
  const { tracks: tracksMap, history: historyMap, imported: importedMap, version, importTracks, clearImported } = useAircraftTrackingContext();

  // ... existing tracks and history useMemo ...

  const imported = useMemo(
    () => Array.from(importedMap.values()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  return { tracks, history, imported, importTracks, clearImported };
}
```

Note: imported tracks are NOT filtered (they're a static reference layer).

**Step 2: Run tests**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/hooks/useAircraftTracks.ts
git commit -m "feat: expose imported tracks from useAircraftTracks hook"
```

---

## Task 8: Collapsible table sections

**Files:**
- Modify: `src/components/AircraftTable.tsx`
- Modify: `src/components/__tests__/AircraftTable.test.tsx`

**Step 1: Write failing tests for collapsible sections**

Add to `src/components/__tests__/AircraftTable.test.tsx`:

```typescript
describe("collapsible sections", () => {
  it("renders history section header with track count", () => {
    render(<AircraftTable tracks={[]} historyTracks={[makeTrack({ hex_ident: "H1" })]} />);
    expect(screen.getByText(/History/)).toBeInTheDocument();
    expect(screen.getByText("(1)")).toBeInTheDocument();
  });

  it("collapses history rows when header is clicked", async () => {
    const user = userEvent.setup();
    render(<AircraftTable tracks={[]} historyTracks={[makeTrack({ hex_ident: "H1" })]} />);

    // History rows visible initially
    expect(screen.getByTestId("row-hist-H1")).toBeInTheDocument();

    // Click header to collapse
    await user.click(screen.getByTestId("history-section-header"));
    expect(screen.queryByTestId("row-hist-H1")).not.toBeInTheDocument();

    // Click again to expand
    await user.click(screen.getByTestId("history-section-header"));
    expect(screen.getByTestId("row-hist-H1")).toBeInTheDocument();
  });

  it("renders imported section header with track count", () => {
    render(<AircraftTable tracks={[]} importedTracks={[makeTrack({ hex_ident: "I1" })]} />);
    expect(screen.getByText(/Imported/)).toBeInTheDocument();
  });

  it("collapses imported rows when header is clicked", async () => {
    const user = userEvent.setup();
    render(<AircraftTable tracks={[]} importedTracks={[makeTrack({ hex_ident: "I1" })]} />);

    expect(screen.getByTestId("row-imported-I1")).toBeInTheDocument();

    await user.click(screen.getByTestId("imported-section-header"));
    expect(screen.queryByTestId("row-imported-I1")).not.toBeInTheDocument();
  });

  it("hides imported section when no imported tracks", () => {
    render(<AircraftTable tracks={[]} importedTracks={[]} />);
    expect(screen.queryByTestId("imported-section-header")).not.toBeInTheDocument();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/__tests__/AircraftTable.test.tsx`
Expected: FAIL

**Step 3: Implement collapsible sections**

Modify `src/components/AircraftTable.tsx`:

1. Add `importedTracks` to Props:
```typescript
interface Props {
  tracks: AircraftTrack[];
  historyTracks?: AircraftTrack[];
  importedTracks?: AircraftTrack[];
  selectedHexIdent?: string | null;
  onSelectTrack?: (hex: string) => void;
}
```

2. Add collapse state:
```typescript
const [historyCollapsed, setHistoryCollapsed] = useState(false);
const [importedCollapsed, setImportedCollapsed] = useState(false);
```

3. Replace the existing history divider with a clickable collapsible header:
```typescript
{sortedHistory.length > 0 && (
  <tr
    data-testid="history-section-header"
    className="cursor-pointer select-none"
    onClick={() => setHistoryCollapsed(prev => !prev)}
  >
    <td colSpan={11} className="px-3 py-1 bg-slate-800/80">
      <span className="text-[10px] text-slate-500 uppercase tracking-wider">
        {historyCollapsed ? "\u25B8" : "\u25BE"}{" "}
        History ({sortedHistory.length})
      </span>
    </td>
  </tr>
)}

{!historyCollapsed && sortedHistory.map((t) => {
  // ... existing history row rendering ...
})}
```

4. Add imported section after history:
```typescript
{sortedImported.length > 0 && (
  <tr
    data-testid="imported-section-header"
    className="cursor-pointer select-none"
    onClick={() => setImportedCollapsed(prev => !prev)}
  >
    <td colSpan={11} className="px-3 py-1 bg-indigo-900/30">
      <span className="text-[10px] text-indigo-400 uppercase tracking-wider">
        {importedCollapsed ? "\u25B8" : "\u25BE"}{" "}
        Imported ({sortedImported.length})
      </span>
    </td>
  </tr>
)}

{!importedCollapsed && sortedImported.map((t) => (
  <tr
    key={`imported-${t.hex_ident}`}
    data-testid={`row-imported-${t.hex_ident}`}
    className="border-b border-slate-800 opacity-60"
  >
    <td className="px-3 py-1.5 font-mono font-semibold text-indigo-300">
      {t.callsign ?? "—"}
    </td>
    <td className="px-3 py-1.5 font-mono text-indigo-400/60">{t.hex_ident}</td>
    <td className="px-3 py-1.5 font-mono">
      <span style={{ color: altitudeToColor(t.altitude) }}>
        {t.altitude?.toLocaleString() ?? "—"}
      </span>
    </td>
    <td className="px-3 py-1.5 font-mono">{t.ground_speed?.toFixed(0) ?? "—"}</td>
    <td className="px-3 py-1.5 font-mono">{t.track?.toFixed(0) ?? "—"}{t.track !== null ? "\u00B0" : ""}</td>
    <td className="px-3 py-1.5 font-mono">{t.vertical_rate?.toFixed(0) ?? "—"}</td>
    <td className="px-3 py-1.5 font-mono text-slate-400">{t.squawk ?? "—"}</td>
    <td className="px-3 py-1.5 font-mono text-slate-500">{t.latitude?.toFixed(4) ?? "—"}</td>
    <td className="px-3 py-1.5 font-mono text-slate-500">{t.longitude?.toFixed(4) ?? "—"}</td>
    <td className="px-3 py-1.5 font-mono text-slate-500">{timeAgo(t.last_seen)}</td>
    <td className="px-3 py-1.5 font-mono text-slate-400">{t.message_count.toLocaleString()}</td>
  </tr>
))}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/__tests__/AircraftTable.test.tsx`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/components/AircraftTable.tsx src/components/__tests__/AircraftTable.test.tsx
git commit -m "feat: add collapsible History and Imported sections to aircraft table"
```

---

## Task 9: Export/Import buttons in header + sidebar imported toggle

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/Filters.tsx`
- Modify: `src/components/__tests__/Filters.test.tsx`

**Step 1: Write failing tests for Filters imported section**

Add to `src/components/__tests__/Filters.test.tsx`:

```typescript
describe("imported tracks section", () => {
  it("shows imported toggle when importedCount > 0", () => {
    render(<FiltersPanel {...defaultProps} importedCount={5} showImported={true} onToggleImported={vi.fn()} onClearImported={vi.fn()} />);
    expect(screen.getByText(/Show imported/)).toBeInTheDocument();
    expect(screen.getByText("(5")).toBeInTheDocument();
  });

  it("hides imported section when importedCount is 0", () => {
    render(<FiltersPanel {...defaultProps} importedCount={0} showImported={false} onToggleImported={vi.fn()} onClearImported={vi.fn()} />);
    expect(screen.queryByText(/Show imported/)).not.toBeInTheDocument();
  });

  it("calls onClearImported when clear button clicked", async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(<FiltersPanel {...defaultProps} importedCount={3} showImported={true} onToggleImported={vi.fn()} onClearImported={onClear} />);
    await user.click(screen.getByText("Clear"));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/__tests__/Filters.test.tsx`
Expected: FAIL

**Step 3: Add imported props to FiltersPanel**

Add to the `Props` interface in `src/components/Filters.tsx`:

```typescript
importedCount: number;
showImported: boolean;
onToggleImported: () => void;
onClearImported: () => void;
```

Add the imported section JSX after the history toggle:

```typescript
{/* Imported overlay toggle — only visible when imported tracks exist */}
{importedCount > 0 && (
  <div>
    <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={showImported}
        onChange={onToggleImported}
        className="accent-indigo-500"
      />
      <span>
        Show imported{" "}
        <span className="text-indigo-400/60 font-mono">({importedCount})</span>
      </span>
    </label>
    <button
      onClick={onClearImported}
      className="mt-1 ml-5 text-[10px] text-slate-500 hover:text-red-400 transition"
    >
      Clear
    </button>
  </div>
)}
```

**Step 4: Run Filters tests**

Run: `npx vitest run src/components/__tests__/Filters.test.tsx`
Expected: PASS (new and existing tests)

**Step 5: Wire up page.tsx**

Modify `src/app/page.tsx`:

1. Add state/imports:
```typescript
import { exportTracksToFile, importTracksFromFile } from "@/lib/file-io";

// In Dashboard component:
const { tracks, history, imported, importTracks, clearImported } = useAircraftTracks(filters);
const [showImported, setShowImported] = useLocalStorage<boolean>("adsb-show-imported", true);
const visibleImported = showImported ? imported : [];
```

2. Add handler functions:
```typescript
async function handleExport() {
  try {
    setError(null);
    await exportTracksToFile(tracks, history);
  } catch (e) {
    setError(String(e));
  }
}

async function handleImport() {
  try {
    setError(null);
    const tracks = await importTracksFromFile();
    if (tracks) importTracks(tracks);
  } catch (e) {
    setError(String(e));
  }
}

function handleToggleImported() {
  setShowImported((prev: boolean) => !prev);
}
```

3. Add Export/Import buttons to header (between error span and Start/Stop button):
```typescript
<button
  onClick={handleExport}
  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
  title="Export tracks to GeoJSON"
>
  Export
</button>
<button
  onClick={handleImport}
  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded transition"
  title="Import tracks from GeoJSON"
>
  Import
</button>
```

4. Pass imported props to FiltersPanel:
```typescript
<FiltersPanel
  {...existingProps}
  importedCount={imported.length}
  showImported={showImported}
  onToggleImported={handleToggleImported}
  onClearImported={clearImported}
/>
```

5. Pass `importedTracks` to AircraftTable:
```typescript
<AircraftTable
  tracks={allTracks}
  historyTracks={visibleHistory}
  importedTracks={visibleImported}
  selectedHexIdent={selectedHexIdent}
  onSelectTrack={handleSelectTrack}
/>
```

**Step 6: Run full test suite**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/app/page.tsx src/components/Filters.tsx src/components/__tests__/Filters.test.tsx
git commit -m "feat: add Export/Import buttons and imported tracks toggle"
```

---

## Task 10: Render imported tracks on map

**Files:**
- Modify: `src/components/Map.tsx` (the dynamic wrapper)
- Modify: `src/components/MapInner.tsx`
- Modify: `src/app/page.tsx` (pass `importedTracks` prop)

**Step 1: Add `importedTracks` to Map/MapInner Props**

In `MapInner.tsx`, add to Props interface:
```typescript
importedTracks?: AircraftTrack[];
```

**Step 2: Render imported tracks as dashed indigo polylines**

Add after the history tracks block and before the active tracks block in `MapInner.tsx`:

```typescript
{/* Imported tracks — dashed indigo polylines, no markers */}
{(importedTracks ?? []).map((t) => {
  if (t.positions.length < 2) return null;
  return (
    <Polyline
      key={`imported-${t.hex_ident}`}
      positions={toLatLngs(t.positions)}
      pathOptions={{
        color: "#818cf8",
        weight: 2,
        opacity: 0.5,
        dashArray: "6 4",
      }}
    >
      <Tooltip sticky>
        <div className="text-xs">
          <div className="font-bold text-indigo-300">
            {t.callsign ?? t.hex_ident}
          </div>
          <div>Hex: {t.hex_ident}</div>
          <div>Alt: {formatAlt(t.altitude)}</div>
          <div className="text-indigo-300">Imported</div>
        </div>
      </Tooltip>
    </Polyline>
  );
})}
```

**Step 3: Pass importedTracks through Map wrapper and from page.tsx**

In `src/components/Map.tsx` (dynamic wrapper), add `importedTracks` to the props interface and forward it.

In `src/app/page.tsx`, pass:
```typescript
<Map
  {...existingProps}
  importedTracks={visibleImported}
/>
```

**Step 4: Run full test suite**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass

**Step 5: Visual verification**

Run: `npm run tauri dev`
1. Start feed, let some tracks accumulate
2. Click Export — verify save dialog appears, file saves
3. Stop feed, clear tracks
4. Click Import — verify open dialog, tracks appear as dashed indigo lines on map and in imported table section
5. Toggle "Show Imported" in sidebar — verify tracks show/hide
6. Click "Clear" — verify imported tracks disappear

**Step 6: Commit**

```bash
git add src/components/Map.tsx src/components/MapInner.tsx src/app/page.tsx
git commit -m "feat: render imported tracks as dashed indigo polylines on map"
```

---

## Task 11: Final integration test and CI check

**Step 1: Run full Rust test suite**

Run: `cd adsb-feed/rust && cargo test --workspace`
Expected: All ~84 tests pass

**Step 2: Run Rust lints**

Run: `cargo clippy --workspace -- -D warnings && cargo fmt --workspace --check`
Expected: No warnings, no format issues

**Step 3: Run full TypeScript test suite**

Run: `cd adsb-pulsar-client-desktop && npm test`
Expected: All tests pass

**Step 4: Run Next.js lint**

Run: `npx next lint`
Expected: No lint errors

**Step 5: Build check**

Run: `npx next build`
Expected: Build succeeds

**Step 6: Final commit (if any adjustments needed)**

```bash
git commit -m "test: verify full CI passes for export/import feature"
```
