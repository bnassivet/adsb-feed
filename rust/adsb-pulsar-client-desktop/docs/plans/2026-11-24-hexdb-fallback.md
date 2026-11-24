# hexdb.io as a fallback flight-info source

## Context
"Show Flight Infos" in the details panel asks adsbdb.com only. When adsbdb has no record for an airframe ("Aircraft not in the database") or a callsign ("No route known"), we show nothing, though hexdb.io (keyless and free) often knows it. Goal: when adsbdb answers **not found (404)**, ask hexdb.io for the same part. Errors (timeout, 429, 5xx) keep today's behaviour: the stale cache or the error, and no hexdb call.

hexdb v1 answers, checked live on 2026-11-24:
- `GET https://hexdb.io/api/v1/aircraft/{hex}` returns 200 `{"ModeS","Registration","Manufacturer","ICAOTypeCode","Type","RegisteredOwners","OperatorFlagCode"}`, or 404 when unknown
- `GET https://hexdb.io/api/v1/route/icao/{callsign}` returns 200 `{"flight":"DLH400","route":"EDDF-KJFK","updatetime":…}`
- `GET https://hexdb.io/api/v1/airport/icao/{icao}` returns 200 `{"country_code","region_name","iata","icao","airport","latitude","longitude"}`
- `GET https://hexdb.io/hex-image-thumb?hex={hex}` returns a plain-text URL such as `https://hexdb.io/static/aircraft-images/D-AIBD-thumb.jpg`
- Attribution on the site: "Data courtesy of PlaneBase/PlanePlotter, Jim Mason, Steve Hibberd, ip2location and Airport-Data"

## Design (all core logic in `rust/adsb-data-server/src/flight_info.rs`)
The existing shape stays as it is: pure parsers, with the fetch passed in as an `Fn(String) -> Fut` closure and called once per URL. That means **no change to the callers** in `adsb-data-server/src/server.rs` or the desktop's `commands.rs::get_flight_info`. hexdb URLs go through the same closure.

1. **Provider tag.** Add `provider: Option<String>` (`"adsbdb"` | `"hexdb"`) to `AircraftInfo` and `FlightRoute` in `adsb-data-engine/src/types.rs`. Add a `provider TEXT` column to `aircraft_info` and `flight_routes` with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, following the `rejected_positions` migration at `storage.rs:261`. Read it and write it in the get/upsert sync functions. Old rows read back as NULL, and the UI treats NULL as adsbdb.
2. **hexdb parsers.** These are pure and unit-tested:
   - `parse_hexdb_aircraft(hex, status, body, now)`: maps `ICAOTypeCode` to `icao_type`, `Type` to `type_name`, `Manufacturer`, `Registration`, and `RegisteredOwners` to `owner`. There is no owner country. A 404 means not found.
   - `parse_hexdb_route_codes(body) -> Option<(origin, dest)>`: splits `route` on `-`, takes the first and last valid 4-character codes, and copes with multi-stop routes.
   - `parse_hexdb_airport(body) -> Airport`: maps `airport` to `name`, `iata`, `country_code` to `country` (an ISO code; adsbdb gives a country name), and latitude/longitude. `city` is None.
   - `parse_hexdb_photo(body) -> Option<String>`: accepted only if it starts with `https://hexdb.io/`. Anything else, such as "n/a" or HTML, gives None.
3. **Fallback inside the fetch step.** The generic `refresh()` stays as it is. Each part's parse step becomes an async "fetch this part" helper:
   - Airframe: adsbdb is asked first. If it answers found, or answers with an error, that answer stands. If it answers not found, ask hexdb.
     - hexdb found: use that row. Then make one extra request for `hex-image-thumb`; if it fails, the row simply has no photo. Cache the row with `provider = "hexdb"`.
     - hexdb not found too: keep a negative row, cached for one day as today.
     - hexdb error: return the not-found row, **uncached**, with the hexdb error appended, so the next click tries again.
   - Route: same rule. hexdb found gives the route codes. Then fetch each airport, two requests at most. If an airport request fails, the route still has that airport's ICAO code, just without its details. `airline_*` stays None.
4. **Photo allow-list.** Add `"hexdb.io"` to `ALLOWED_HOSTS` in `adsb-pulsar-client-desktop/src-tauri/src/aircraft_photo.rs`. The URL still comes only from our cache, and the downloaded bytes still go through `sniff_mime`.
5. **Fetch error text.** `fetch_adsbdb` is in fact a generic GET. Its error strings say "adsbdb unreachable", so name the host taken from the URL instead. I'm keeping the function name; renaming it is a refactor I'd ask you about separately.
6. **UI** (`src/components/FlightInfoSection.tsx`, `src/lib/flight-info.ts`, `src/lib/types.ts`):
   - Add `provider: string | null` to both TS types.
   - A pure `sourceLabel(info)` returns "adsbdb.com", "hexdb.io" or "adsbdb.com + hexdb.io", and the footer shows it.
   - The photo caption shows the host of `photo_url`, not a hard-coded "airport-data.com".
   - The button title mentions both sources.
7. **Agent tool text.** `rust/adsb-agent/src/adsb_agent/server_tools.py:81`: the `lookupFlightInfo` description says "adsbdb, with hexdb.io as a fallback". Add `"hexdb"` to the phrase check in `tests/test_server_tools.py:65`.

## TDD order (red, then green, for each step)
1. `adsb-data-engine` storage: `provider` round-trips through upsert/get for both tables, and an existing DB without the column opens and gets migrated.
2. `flight_info.rs`: add hexdb fixtures (the JSON above) and extend `FakeWeb` to answer hexdb URLs, with switches for "adsbdb 404 / hexdb known / hexdb 404 / hexdb error". Tests:
   - A known adsbdb airframe never asks hexdb.
   - adsbdb 404 with hexdb known gives a hexdb airframe with a photo, and the second lookup is served from cache.
   - Both 404 gives a negative row, and the next lookup asks neither source.
   - adsbdb 429 or an offline fetch never asks hexdb.
   - hexdb error after an adsbdb 404 is not cached, and the error is shown.
   - Route fallback fills both airports. If one airport request fails, that airport keeps only its ICAO code.
   - Parser unit tests, including multi-stop routes and a bad photo body.
3. `aircraft_photo.rs`: `check_url` accepts `https://hexdb.io/static/...` and still refuses other hosts.
4. Vitest: `sourceLabel` cases; `AircraftDetailsPanel.flightInfo.test.tsx` shows "hexdb.io" in the footer and caption for a hexdb answer.
5. Python: the description phrase test.

## Docs and git
- Save this plan as `rust/adsb-pulsar-client-desktop/docs/plans/2026-11-24-hexdb-fallback.md` before coding.
- DESIGN.md: add hexdb rows to the external-endpoints table (around line 5977) and a "Fallback: hexdb.io" subsection under "Flight info from the web (adsbdb)" (around line 6421), with the attribution line. Run `graphify update .` afterwards.
- Branch `feature/hexdb-fallback`. Commit only, with no push and no Co-Authored-By trailer.

## Verification
- From `rust/`: `cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check`. Also build `-p adsb-data-server --features web-lookup` so the real fetch path compiles.
- From the desktop: `npm test && npm run lint && npx tsc --noEmit`, comparing the error count against the existing ~55.
- From `rust/adsb-agent`: `uv run pytest tests/test_server_tools.py`.
- Manual check: `npm run tauri dev`, pick a live aircraft that adsbdb doesn't know (or a hex where `curl api.adsbdb.com/v0/aircraft/<hex>` returns 404 and hexdb returns 200), click Show Flight Infos, and confirm the type, registration, photo and the "Source: hexdb.io" footer.

## Revision (same day): API v2, and a cached "unknown" goes to hexdb

Two changes requested after review:
- **v2 instead of v1.** `/api/v2/aircraft/{hex}` returns photo links inline
  (`images.full` / `images.thumbnail`), and `/api/v2/routes/{callsign}` returns
  both airports in full. That is one hexdb request per part, with no
  `hex-image-thumb` or airport calls, and a real full-size photo link.
- **A cached "unknown" from adsbdb is not a reason to wait.** It sends hexdb a
  request at once, without asking adsbdb again within its day. Only an
  unknown answer from hexdb, which means both sources were asked, is cached
  for a day.
