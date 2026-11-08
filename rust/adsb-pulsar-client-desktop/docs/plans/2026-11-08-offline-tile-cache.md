# Offline map tile cache — client-side (Leaflet + IndexedDB)

## Context
The desktop map loads every basemap tile from the network each time (OSM for light, Esri Dark Gray or CARTO Dark Matter for dark; `src/lib/basemap.ts`). Nothing is cached, so the map is slow on an edge link and blank when offline. The user wants:
- tiles cached within a footprint around the receiver (default 500 NM)
- a Settings section showing the cache size, with controls to clear the cache and change the footprint

Decisions taken with the user:
- **Read-through caching plus an opt-in "Download area" prefetch** to a capped zoom.
- **A configurable maximum size (MB) with LRU eviction.**
- **The cache lives in the client** (Leaflet + IndexedDB), not in Rust. That means **no Rust changes**.

Known limits, accepted:
- The webview owns the storage and may delete it. We request `navigator.storage.persist()` to make that less likely.
- A prefetch runs only while the Settings page is open. Leaving the page cancels it, and the UI says so.

All work is on `feature/map_cache` and follows TDD: one red-green-refactor cycle per commit. Commits are local only, and carry no Co-Authored-By trailer.

## Design
New folder `src/lib/tile-cache/`:

- **`geometry.ts`** (pure, fully tested):
  - `tileBounds(z,x,y)`
  - `tileIntersectsCircle(z,x,y,lat,lon,radiusNm)`, which uses the haversine distance to the nearest point of the tile bbox; reuse the haversine/NM helper already used for the receiver range in Aircraft Details if there is one
  - `tilesInRadius(lat,lon,radiusNm,maxZoom)`, a generator
  - `estimateTiles(...)`, which returns a count and approximate bytes
- **`keys.ts`**: `tileKey(provider,z,x,y,retina)`, for example `esri-dark/10/301/367@2x`. The CARTO API key is never part of the cache key.
- **`store.ts`**: a small IndexedDB wrapper, with no new runtime dependency.
  - The database is `adsb-tile-cache-<stack>`, named from the existing `getStack()` wrapper (`src/lib/commands.ts:67`), so stacks don't share a cache. Without a named stack it is `default`.
  - It has one object store, `tiles`, with fields `{key, provider, z, x, y, blob, bytes, lastAccess}` and indexes on `lastAccess` and `provider`.
  - API: `get(key)` (updates `lastAccess`), `put(entry)`, `stats()` (`{bytes, tiles, perProvider}`), `evictTo(maxBytes)` (walks the `lastAccess` index, oldest first), `pruneOutside(lat,lon,radiusNm)` and `clear()`.
  - Tests use **`fake-indexeddb`**, added as a dev dependency and imported per test file.
- **`settings.ts`**:
  - `TileCacheSettings {enabled:true, radiusNm:500, maxSizeMb:500, prefetchMaxZoom:10}` is stored under the localStorage key `adsb-tile-cache-settings` through the existing `useLocalStorage`, so both routes read the same value.
  - `validateTileCacheSettings` enforces radius 10–1000 NM, size 50–10,000 MB and zoom 0–12.
- **`loadTile.ts`** (the testable core of the layer): `loadTile({key, url, inFootprint, store, settings, fetchFn}) → Blob`.
  - On a hit, return the stored blob.
  - On a miss, `fetch(url, {mode:"cors"})`. If `enabled && inFootprint`, store the blob and then `evictTo(cap)`.
  - Errors propagate.
- **`CachedTileLayer.ts`**: `L.TileLayer.extend` overrides `createTile(coords, done)`.
  - It calls `loadTile` and sets `img.src = URL.createObjectURL(blob)`, revoking the URL on load.
  - If `loadTile` fails, it falls back to `img.src = directUrl`, so Leaflet's normal error tile still appears.
  - It is wrapped for React with `createTileLayerComponent` from `@react-leaflet/core` (a react-leaflet v5 peer that is already installed).
- **`prefetch.ts`**: `prefetchArea({provider, lat, lon, radiusNm, maxZoom, signal, onProgress, concurrency:4})`.
  - It skips tiles that are already cached and reports `{done, total, bytes, failed}`.
  - It **refuses the `osm` provider**, because the OpenStreetMap tile policy forbids bulk downloads. Read-through caching still works for OSM.

## Integration
- **`src/lib/basemap.ts`**: `TileConfig` gains `provider: "osm" | "esri-dark" | "carto-dark"`. Extend `__tests__/basemap.test.ts`.
- **`src/components/MapInner.tsx`** (~L1030 and L1075):
  - Replace `<TileLayer>` with `<CachedTileLayer>` and pass it the provider, the receiver location (already a prop), and the settings from `useLocalStorage`.
  - When the map mounts, run `pruneOutside` and `evictTo` once.
  - When there is no receiver location, tiles are read from the cache but no new ones are stored.
  - The component keeps `key={tile.url}`, so it still remounts when the theme changes.
- **CSP** (both files, kept in sync):
  - Tiles are now fetched with `fetch`, so add `https://server.arcgisonline.com https://*.basemaps.cartocdn.com https://*.openstreetmap.org` to `connect-src`.
  - Add `blob:` to `img-src`.
  - The files are `src-tauri/tauri.conf.json:24` and `adsb-feed/scripts/tauri-dev-config.py` (`csp()`).
- **CORS check first:** run `curl -sI` against each provider and look for `Access-Control-Allow-Origin`. A provider that doesn't send it falls back to pass-through (not cached), and the Settings page says so.

## Settings section
Add a new `src/components/TileCacheSection.tsx`, rendered in `src/app/settings/page.tsx` after **Display**. It uses the same card styling and the storage-mode busy/error/`role="alert"` pattern (L43–88), and contains:
- **Stats:**
  - used MB against the cap, with a bar
  - the tile count
  - a per-provider breakdown
  - the webview quota from `navigator.storage.estimate()`
  - a "persistent storage: yes/no" flag
- **Controls:**
  - Enabled, Radius (NM), Max size (MB) and Prefetch max zoom, each showing the estimated tile count and size
  - **Apply**, which saves and then prunes immediately
  - **Clear cache**, with a confirmation step
- **Download area:**
  - a provider select offering the non-OSM providers that are available (Esri, plus CARTO when there is a key)
  - a progress bar and a Cancel button (`AbortController`)
  - a note: "keep this page open"
  - the button is disabled, with an explanation, when the receiver location is not set
- The receiver location comes from the `Config` the Settings page already loads.

## Types and tests
Add `components/__tests__/TileCacheSection.test.tsx` with tests for:
- rendering the stats
- validating and applying settings
- clearing the cache
- prefetch progress and cancel
- the disabled states

jsdom lacks `URL.createObjectURL`, so stub it in the tests that need it.

## Docs
- `docs/plans/2026-11-08-offline-tile-cache.md`
- a "Map Tile Cache" section in `docs/DESIGN.md` covering the client-side choice and its limits, the footprint, LRU, and the OSM prefetch policy
- `DOCUMENTATION.md`

Run `graphify update .` after the code changes.

## Verification
1. From the desktop app: `npm test && npm run lint`. From `adsb-feed/rust/`: `cargo test --workspace`. The only Rust-side change is the CSP JSON, so this is a sanity check.
2. Run `make up-desktop` with the receiver location set:
   - Pan the map in dark mode. The Settings stats should grow. In the devtools Application → IndexedDB view, `adsb-tile-cache-default` should show entries.
   - Tiles more than 500 NM away should not be stored.
3. In Settings:
   - Download area at z ≤ 8: progress should advance and Cancel should stop it.
   - Shrink the radius and Apply: the size should drop.
   - Clear: the size should go to 0.
4. Go offline: tiles inside the footprint should still render, and those outside should show the error tile.
5. With `STACK=prod`: the database should be `adsb-tile-cache-prod`, separate from the default one.

## Follow-up: offline hardening (2026-11-08)

After a design review, offline use was confirmed as the point of the cache.
The fixes, each one TDD commit:

1. **Store only real tiles** (`validate.ts`). Image content type required; CARTO's
   "API KEY REQUIRED" placeholder (same PNG for a missing or invalid key; ETag
   unreadable cross-origin) is recognised by size + SHA-256, shown but never stored.
2. **Apply prunes around the saved receiver**, not the form draft.
3. **Downloaded tiles are pinned**; eviction takes browsed tiles first.
4. **Write failures are visible**: a window-wide health log shown in Settings;
   downloads stop with `storage-full` on quota errors; a warning when the cap
   exceeds the webview quota.
5. **Refresh, don't expire**: tiles older than 30 days are refetched in the
   background when online; never deleted for age.
6. **Overzoom offline**: a missing tile is cut from its nearest cached ancestor
   (≤ 5 levels).
7. **Coverage per zoom** in Settings ("z0–8 complete · z9 63%").
8. **Concurrent reads**: `get` is read-only; access times are batched.
9. **Download outlives Settings**: the run is a module-level job.

This supersedes the "Known limits" line above about prefetch stopping when
Settings is left. Documented, not coded: prefetch in the build used offline (the
cache is per origin), and the light theme (OSM) is never prefetched.
