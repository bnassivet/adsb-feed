# OpenAIP airspaces on the map (phase 0, first layer)

Status: implemented on branch `feature/openaip-airspaces` (checked in the running app with a live key, 2026-11-19). Design record: DESIGN.md → Airspaces (OpenAIP).
This is the first layer of phase 0 in the map-engine recommendation: new
layers go into the current Leaflet map before any engine change.

## Goal

Show controlled and special-use airspace (CTR, TMA, CTA, restricted, danger,
prohibited, and similar) around the receiver. Hovering a point lists every
airspace above it, with its class and its vertical limits. The data is cached
for each AIRAC cycle and labelled with that cycle. Once the cycle has expired,
the layer says so, because outdated airspace data is a safety issue.

## Constraints found before starting

- **Key required.** OpenAIP's public export bucket became "requester pays"
  (HTTP 400 `UserProjectMissing`), and `api.core.openaip.net` answers 403
  without a key. A free key comes from the openaip.net profile page and is sent
  as `x-openaip-api-key`.
- **The API filters by country only.** `GET /api/airspaces` has `country`,
  `type`, `icaoClass`, `page` and `limit` (at most 1000) parameters, but no
  bbox. The whole country is therefore fetched and filtered locally.
- **Response schema**
  (`https://api.core.openaip.net/api/schemas/response/airspace/airspace-schema.json`):
  - `geometry` is always a `Polygon` with a single ring;
  - `upperLimit` and `lowerLimit` are `{value, unit, referenceDatum}`, where
    unit 0 is metres, 1 feet and 6 flight level, and datum 0 is GND, 1 MSL and
    2 STD;
  - `type` is a code from 0 to 36, and `icaoClass` is 0–6 for A–G or 8 for
    unclassified / special use;
  - the list response has `items` and `totalPages`.
- **Licence:** CC BY-NC-SA 4.0. The map shows the attribution while the layer
  is on.

## Design

**Rust (`src-tauri/src/airspace.rs`) fetches and caches; TypeScript
interprets and draws.**
- The key stays out of the JS bundle and needs no CSP host.
- The cache is a plain file per country and cycle, under
  `<stack data dir>/airspaces/<CC>-<AIRAC>.json`. It holds the raw `items`,
  unchanged, so a parsing change needs no new download.
- `airac_cycle(date)` gives the 28-day cycle (epoch 2001 = 2020-01-02), its
  ident `YYNN`, its effective date and its expiry date.
- `load_airspaces(countries, today, fetcher, dir)`, for each country:
  1. use the file for the current cycle if it exists;
  2. otherwise fetch every page, then write the file;
  3. if the fetch fails, fall back to the newest older file and mark it
     stale (`expired: true`, with its own cycle);
  4. if there is no file at all, return an error for that country.

  The fetcher is a trait, so tests run without the network.
- Command `get_airspaces` returns, per country: the items, the cycle, whether
  it is expired, and an error message if any. Configuration comes from the
  environment: `ADSB_OPENAIP_API_KEY`, and `ADSB_OPENAIP_COUNTRIES` (default
  `FR`). `scripts/stack.sh` exports both from `[desktop] openaip_api_key` and
  `openaip_countries`, which are kept out of `desktop-env` like the CARTO key.

**TypeScript (`src/lib/airspace.ts`) contains only pure functions:**
- `normalizeAirspace` turns a raw OpenAIP item into a type label, a class
  label, limits (`GND`, `2500 ft`, `FL180`, `1500 ft AGL`), a lower bound in
  feet for sorting, and the ring.
- `SHOWN_TYPES` drops the large administrative areas that would cover the
  whole map: FIR, UIR, ACC/FIS sectors, airways and routes, and LTA/UTA.
- `nearPoint` keeps airspaces whose bbox is within a radius of the receiver.
- `airspacesAt` does a point-in-polygon test and sorts by lower limit.
- `airspaceStyle` picks a colour by class or type: restricted, danger and
  prohibited in red and orange, controlled classes in blue and violet.

**Map:**
- `AirspaceLayer` draws imperative Leaflet polygons in their own pane, above
  the tiles and below the density layer, and **non-interactive**. Large
  overlapping polygons would otherwise steal hover from the density hexes and
  clicks from the map, and Leaflet only reports the top one.
- `AirspaceInfo` is a small box showing `airspacesAt(cursor)` during
  mousemove, throttled with rAF. It lists every airspace stacked at that point.

**UI:** a Filters section "Airspaces" with an on/off switch
(`adsb-show-airspaces`, off by default). It shows the cycle, the number shown,
an *expired* warning, and the error, for example a missing key.

## Not in this step

- Chat tool control. Tool descriptions are tuned (fast-path overrides), so
  adding a layer there is its own change.
- Per-type filtering in the UI.
- Altitude-band filtering.
- Airspace volumes in 3D, which is MapLibre phase 3.

## Tests

- **Rust:** AIRAC cycle math (known cycles 2401, 2501 and 2601, year
  boundaries, a 14th cycle in 2020); cache hit, fetch and write, pagination
  merge, stale fallback, error with no cache; country code validation.
- **TS:** limit formatting, normalisation, type filter, nearPoint,
  airspacesAt (nested polygons sorted), style, the command wrapper, the hook,
  and the Filters section.
- **Not tested:** the Leaflet drawing in `MapInner.tsx`, per the existing
  policy.
