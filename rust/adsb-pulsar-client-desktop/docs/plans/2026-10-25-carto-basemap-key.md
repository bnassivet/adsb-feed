# Fix: dark basemap shows "API KEY REQUIRED" (CARTO raster tiles)

## Context

The desktop app's dark theme loads `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`
(`TILE_CONFIGS.dark`, `rust/adsb-pulsar-client-desktop/src/components/MapInner.tsx:64`) with no key.
Since 2026-09-25 CARTO serves raster tiles only with `?key=…` (free: 5M tiles/month
non-commercial, 1M commercial; key from carto.com/basemaps/apikey); keyless requests get a
watermark tile. Vector styles are keyless *for now* but would need MapLibre GL — rejected.

Decision (user): **keep Leaflet raster, add an optional CARTO key, fall back to Esri's keyless
Dark Gray Canvas when no key is configured**, so a fresh checkout never shows the watermark.
Light theme (OSM) unchanged.

Side finding: neither CSP (`tauri.conf.json`, `scripts/tauri-dev-config.py`) allows
`*.basemaps.cartocdn.com` in `img-src` — must be added along with the Esri host.

## Steps (TDD: red → green per step)

0. Save this plan as `rust/adsb-pulsar-client-desktop/docs/plans/2026-10-25-carto-basemap-key.md`
   (rust/CLAUDE.md requires plans there before implementation).

1. **Pure basemap module** — new `src/lib/basemap.ts` (mirrors `src/lib/agent-url.ts` style):
   - `export const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY?.trim() || undefined;`
     (Next inlines `NEXT_PUBLIC_*` at dev-server start / `next build` — doc comment says so, like agent-url.ts).
   - `export function tileConfig(theme: MapTheme, cartoKey?: string): TileConfig`
     returning `{ url, attribution, maxZoom, subdomains? }`:
     - `light` → current OSM entry, unchanged.
     - `dark` + key → `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`,
       `subdomains: "abcd"`, `maxZoom: 20`, attribution OSM + CARTO (existing string, link to carto.com/attributions).
     - `dark` without key (undefined/empty/whitespace) →
       `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`
       (note `{y}/{x}` order), `maxZoom: 16`, attribution `Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors`.
   - Tests `src/lib/__tests__/basemap.test.ts`: light ignores key; dark+key contains `dark_all` and `?key=`;
     key is URL-encoded; empty/whitespace key → Esri; Esri URL uses `{y}/{x}`; no-key URL never hits cartocdn
     (regression for the watermark).

2. **Wire into MapInner.tsx** — delete `TILE_CONFIGS`; `const tile = tileConfig(mapTheme, CARTO_API_KEY);`
   pass `subdomains`/`maxZoom` to `<TileLayer>`, and change `key={mapTheme}` → `key={tile.url}` so Leaflet
   rebuilds the layer when the URL changes. (MapInner is untested by convention; logic lives in step 1.)

3. **CSP** — add `https://*.basemaps.cartocdn.com https://server.arcgisonline.com` to `img-src` in
   `src-tauri/tauri.conf.json` **and** `scripts/tauri-dev-config.py::csp()` (its docstring requires mirroring).
   Extend `scripts/tests/test_stack_paths.sh` "CSP keeps the map tile sources" check to require both hosts (red first).

4. **Config plumbing** —
   - `adsb-stack-template.toml` `[desktop]`: `carto_api_key = ""` with a comment (why, where to get it,
     empty = Esri fallback, adsb-stack.toml is gitignored so the key stays local).
   - `scripts/stack.sh` desktop launch: append `NEXT_PUBLIC_CARTO_API_KEY=$(cfg desktop carto_api_key "")`
     **only when non-empty**, so a key from the shell or `.env.local` is not clobbered by an empty value.
   - Direct `npm run tauri dev` users: `NEXT_PUBLIC_CARTO_API_KEY` in `.env.local` (confirm it is gitignored).

5. **Docs** — DESIGN.md (map/basemap section): providers, key, fallback, CSP; desktop `CLAUDE.md` Gotchas:
   one line "CARTO raster needs `?key=` since 2026-09-25; no key → Esri fallback; CSP lists both hosts in two files".

## Critical files
- `rust/adsb-pulsar-client-desktop/src/lib/basemap.ts` (new) + `src/lib/__tests__/basemap.test.ts` (new)
- `rust/adsb-pulsar-client-desktop/src/components/MapInner.tsx`
- `rust/adsb-pulsar-client-desktop/src-tauri/tauri.conf.json`
- `scripts/tauri-dev-config.py`, `scripts/tests/test_stack_paths.sh`, `scripts/stack.sh`
- `adsb-stack-template.toml`

## Verification
- `npx vitest run src/lib/__tests__/basemap.test.ts`, then `npm test && npm run lint && npx tsc --noEmit`
  (tsc count compared as a delta against the ~55 pre-existing test-file errors).
- `sh scripts/tests/test_stack_paths.sh` → OK.
- Manual: `make up-desktop` with `carto_api_key = ""` → dark theme shows Esri dark gray tiles, no watermark;
  set a real key, restart desktop → CARTO Dark Matter tiles; DevTools console shows no CSP `img-src` violations;
  toggle light/dark switches cleanly.
- `graphify update .` after code changes. Commit on `fix/carto_api_tiles` (no push).
