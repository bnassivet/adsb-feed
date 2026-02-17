# Export/Import Aircraft Track History

## Goal

Allow users to export the current aircraft track history (active + history) to a GeoJSON file and import previously exported files as a distinct overlay layer. Supports three use cases: session persistence (reload on restart), data sharing between stations/users, and external analysis in GIS tools (QGIS, Google Earth, Kepler.gl).

## Approach

Frontend-only GeoJSON (Approach A). All serialization happens in JavaScript — no new Rust commands. Uses Tauri's `dialog` and `fs` plugins for native file dialogs and disk I/O.

## GeoJSON Data Model

Each exported file is a GeoJSON `FeatureCollection`. Every `AircraftTrack` becomes a `Feature`:

```json
{
  "type": "FeatureCollection",
  "metadata": {
    "exported_at": "2026-02-16T14:30:00.000Z",
    "source": "adsb-pulsar-client-desktop",
    "version": 1,
    "track_count": 42
  },
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "LineString",
        "coordinates": [[2.35, 48.86, 10500], [2.40, 48.88, 11200]]
      },
      "properties": {
        "hex_ident": "A1B2C3",
        "callsign": "AAL123",
        "altitude": 11200,
        "ground_speed": 420,
        "track": 135,
        "vertical_rate": 500,
        "squawk": "1200",
        "is_on_ground": false,
        "timestamp": "2026/02/16 14:28:30.123",
        "last_seen": 1739712510123,
        "message_count": 847
      }
    }
  ]
}
```

- Coordinates use GeoJSON order: `[longitude, latitude, altitude]` (converted from internal `[lat, lng, alt]`)
- `metadata.version` allows future format evolution
- Tracks with no positions exported as `Point` at `[0, 0]` with `"no_position": true` property
- `metadata` is a GeoJSON "foreign member" (allowed by RFC 7946)

## Export Flow

1. User clicks **Export** button in header toolbar
2. Frontend reads `tracksRef` and `historyRef` from `AircraftTrackingContext`
3. Pure function `tracksToGeoJSON(tracks, history)` converts to GeoJSON `FeatureCollection`
4. Tauri dialog plugin opens native Save dialog (default filename: `adsb-tracks-YYYY-MM-DDTHH-MM-SS.geojson`)
5. Write JSON string to selected file path via Tauri's `fs` plugin

## Import Flow

1. User clicks **Import** button in header toolbar
2. Tauri dialog plugin opens native Open dialog (filter: `*.geojson`, `*.json`)
3. Read file contents via Tauri's `fs` plugin
4. Pure function `geoJSONToTracks(geojson)` validates and converts back to `AircraftTrack[]`
5. Imported tracks stored in new `importedRef` Map in `AircraftTrackingContext`
6. Map and Table render imported tracks as a distinct overlay layer

### Validation

- Must be valid JSON with `type: "FeatureCollection"`
- Each Feature must have `hex_ident` in properties
- Invalid features skipped with console warning (partial import succeeds)
- `metadata.version` checked — warn if higher than current app version

### Overlay Behavior

- Imported tracks are read-only — TTL cleanup does not touch them
- Sidebar toggle "Show Imported" with track count badge controls visibility
- "Clear Imported" button removes all imported tracks
- Imported tracks are NOT re-exported (export captures live+history only)

## UI Integration

### Header Toolbar

Two new buttons between Start/Stop and Settings:

```
[ADS-B Aircraft Tracker] [Socket ●] [Pulsar ●] [⊏⊐]    [error?] [Export ↓] [Import ↑] [Stop] [Settings]
```

Both use slate-700 styling matching the Settings button.

### Sidebar

New section below History toggle (only visible when imported tracks exist):

```
── Imported ──────────────
[✓] Show Imported (12)
[Clear Imported]
```

### Map Rendering

Imported tracks rendered as:
- Dashed polylines in muted indigo (`#818cf8` at 50% opacity)
- No aircraft marker icons
- Z-order: above history, below active tracks

### Table Rendering

Three sections with collapsible headers:
- **Active tracks** — always visible, no header
- **History (N)** — collapsible header with chevron, state in `useLocalStorage("adsb-history-collapsed", false)`
- **Imported (N)** — collapsible header with chevron, state in `useLocalStorage("adsb-imported-collapsed", false)`

Header rows span full table width, clickable, show track count, chevron rotates on toggle.
Imported rows styled with indigo tint to distinguish from live and history.

### Not Changed

- Filters do not apply to imported tracks (static reference layer)
- Density overlay excludes imported tracks
- Imported tracks are not selectable

## Tauri Permissions

Additions to `capabilities/default.json`:
- `dialog:default` — native open/save file dialogs
- `fs:default` — read/write user-selected files

## Files to Create/Modify

### New Files
- `src/lib/geojson.ts` — pure functions: `tracksToGeoJSON()`, `geoJSONToTracks()`
- `src/lib/__tests__/geojson.test.ts` — unit tests for conversion functions

### Modified Files
- `src/contexts/AircraftTrackingContext.tsx` — add `importedRef` Map, `importTracks()`, `clearImported()` methods
- `src/contexts/__tests__/AircraftTrackingContext.test.ts` — tests for import/clear
- `src/hooks/useAircraftTracks.ts` — expose imported tracks
- `src/app/page.tsx` — Export/Import buttons, imported state wiring
- `src/components/AircraftTable.tsx` — collapsible History/Imported sections
- `src/components/__tests__/AircraftTable.test.tsx` — collapsible section tests
- `src/components/Filters.tsx` — "Show Imported" toggle + "Clear Imported" button
- `src/components/__tests__/Filters.test.tsx` — imported toggle tests
- `src/components/MapInner.tsx` — imported track overlay rendering
- `src-tauri/capabilities/default.json` — add dialog + fs permissions
