# METAR stations on the map (phase 0, second layer)

Status: implemented and checked in the running app (2026-11-19), branch `feature/metar-layer` (stacked on
`feature/openaip-airspaces`). Follows the airspace layer's pattern.

## Goal

Show the latest METAR of every station near the receiver, coloured by flight
category (VFR / MVFR / IFR / LIFR). Hovering a station shows its decoded and
raw report. The panel has the same controls as Airspaces: an opacity slider,
an "Info on hover" toggle, and a filter by flight category. Each station's QNH
is kept, because the airspace and terrain layers need it to compare pressure
altitude with heights above MSL.

## Source (checked 2026-11-19)

AviationWeather.gov Data API:
`GET https://aviationweather.gov/api/data/metar?bbox=minLat,minLon,maxLat,maxLon&format=json`.

- **No key needed.** The default answer is the latest report per station:
  106 stations within ~300 NM of Montréal, Canadian stations included.
- **Fields:** `icaoId`, `name`, `lat`, `lon`, `elev`, `obsTime` (epoch s),
  `rawOb`, `fltCat`, `temp`, `dewp`, `wdir`, `wspd`, `wgst`, `visib`, `altim`
  (QNH in hPa), `cover`, `clouds[] {cover, base}`, `wxString`, `metarType`.
- **Missing values:**
  - `fltCat` is null when the station reports no visibility.
  - `wdir` is a number or `"VRB"`.
  - `visib` is a number or a string such as `"10+"`.
- **Empty answer:** HTTP 204 means no data.
- **Usage policy:** AWC asks clients to send a custom User-Agent and to stay
  well under 100 requests per minute.

## Design

**Rust (`src-tauri/src/metar.rs`):** fetches, plus a cache **in memory only**.
The cache policy in MAP_ENGINES.md is "no offline METAR; last reading kept, age
always shown".

- `bbox_around(lat, lng, radiusNm)` rounds the box to 0.1°, so that small
  changes in the receiver's position do not trigger a new fetch.
- `load_metars`:
  - serves the cache while it is under 5 minutes old and covers the same box;
  - otherwise downloads;
  - if the download fails, serves the last snapshot (stale, with the error);
  - never downloads twice within 60 s, even when a reload is forced.
- Command `get_metars(lat, lng, radiusNm, force)` returns
  `{items, fetchedAtMs, origin, error}`, with the raw items kept untouched.

**TypeScript (`src/lib/metar.ts`):** pure functions only.
- `normalizeMetar`, `formatWind`, `metarColor` (the standard category colours);
- `metarCategories` and `filterByCategory`, the counterparts of the airspace
  type filter;
- `metarAt`: the nearest station within a few pixels of the cursor;
- `ageMinutes`: the age of a report. Reports older than 90 minutes are flagged
  as old.

**Hook `useMetars`:** loads when the layer is switched on, and refreshes every
5 minutes while it stays on.

**Map:**
- circle markers on their own non-interactive canvas pane, above the
  airspaces;
- a hover box with the decoded report and the raw `rawOb`.

## Tests

- **Rust:** bbox rounding and clamping, URL, the 204 response and errors,
  cache TTL, a moved box, the stale fallback, the 60 s guard, serialisation.
- **TS:** normalisation (VRB, `"10+"`, missing category), wind formatting,
  colours, category counts and filter, `metarAt`, age, the hook (load,
  refresh, reload), and the controls.
