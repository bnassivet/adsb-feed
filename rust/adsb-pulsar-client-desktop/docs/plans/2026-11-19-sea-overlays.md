# Sea overlays: OpenSeaMap seamarks and EMODnet depth

Status: implemented on branch `feature/sea-overlays` (stacked on
`feature/metar-layer`); not yet seen in the running app. Phase 0 of `docs/MAP_ENGINES.md`, after airspaces,
METAR and the rain radar.

## Sources, checked 2026-11-19

| Layer | Source | Notes |
|---|---|---|
| Seamarks (buoys, lights, harbours) | `https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png` | Keyless XYZ, transparent RGBA. Empty below zoom 9 (334-byte tiles at z6-8), so `minZoom: 9`. Data ODbL (OpenStreetMap). |
| Depth colours | EMODnet Bathymetry WMS `https://ows.emodnet-bathymetry.eu/wms`, layer `emodnet:mean_multicolour` | Keyless. Land is fully transparent (alpha 0), sea opaque, so it works as an overlay. Loud red-to-blue ramp: low default opacity. ~0.8 s per 512 px tile; `cache-control: max-age=8640000`. CC BY 4.0. |
| Depth contours | same WMS, `emodnet:contours` | White lines and labels on transparent: suits the dark map. |

Rejected: `emodnet:mean_atlas_land` and the `atlas_land` style draw land as
well (100 % opaque), so they are base maps, not overlays.

## Design

- **Frontend only.** No key and no processing, so no Rust: Leaflet draws
  `L.tileLayer` (seamarks) and `L.tileLayer.wms` (depth) on their own panes:
  depth at z 320, under the radar (340); seamarks at z 345, above the radar
  and under the airspaces (350).
- **One WMS request for both depth layers**: `layers` is built from the two
  switches (`emodnet:mean_multicolour,emodnet:contours`), 512 px tiles to halve
  the request count against a slow server.
- **Not in the tile cache.** The cache is for the base map and fetches through
  `connect-src`; overlays go through `img-src` and the HTTP cache (EMODnet sends
  100 days). OSM-derived tiles must not be bulk prefetched anyway.
- **Controls** (Filters → Sea): Seamarks (switch, opacity); Depth colours and
  Depth contours (switches, one opacity); a depth legend in metres built from
  the EMODnet legend's colours. Persisted in localStorage like the other layers.
- **Night**: opacity × 0.85, as for the other layers.
- **CSP**: both hosts in `img-src` of `tauri.conf.json` and
  `scripts/tauri-dev-config.py`; `csp.test.ts` checks them.

## Tests

- `lib/sea.ts`: WMS layer list from the switches, legend order, defaults,
  hosts.
- `SeaControls`: switches, sliders, legend only with depth colours on.
- `csp.test.ts`: both sea hosts allowed as images.
- `MapInner` layers are not unit-tested (project rule); checked in the app.

## Not in this step

- Depth under the cursor (WMS GetFeatureInfo).
- Offline copies (phase 4, PMTiles served from Rust).
