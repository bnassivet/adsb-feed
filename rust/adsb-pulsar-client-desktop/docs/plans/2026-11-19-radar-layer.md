# Météo-France rain radar on the map (phase 0, third layer)

Status: implemented on branch `feature/metar-layer` (follows METAR); live API checked end to end, not yet seen in the running app. Same pattern
as the airspace and METAR layers.

## Source, checked live on 2026-11-19 with a key

API `DonneesPubliquesRadar`:
`https://public-api.meteofrance.fr/public/DPRadar/v1`.

- **Access:** an `apikey` header. Free plan, 850 requests per 5 minutes.
- **The key is a JWT** that carries its own expiry. The first key generated
  for this project was valid for only 5 seconds, so the app reads `exp` and
  says the key has expired instead of passing on a bare 401.
- **Mosaic for mainland France:** `/mosaiques/METROPOLE/observations/{REFLECTIVITE|LAME_D_EAU}`.
  The description JSON gives `validity_time` and a link per product.
  - `REFLECTIVITE` is BUFR only, at 1 km. Not used: decoding BUFR needs
    WMO and local tables.
  - **`LAME_D_EAU` at 500 m is ODIM_H5** (HDF5, 2.6 MB):
    - one `uint16` dataset of 3472×3472 cells, gzip-chunked;
    - quantity `ACRR`, the rain accumulated over 5 minutes, in mm with a gain
      of 0.01; `nodata` 65535, `undetect` 65534;
    - polar stereographic grid:
      `+proj=stere +lat_0=90 +lon_0=0 +lat_ts=45 +ellps=WGS84 +x_0=619652.07 +y_0=5262818.34`,
      lower-left corner at (0, 0), 500 m cells, row 0 at the top.
- **Decoder:** `hdf5-reader` 0.13, pure Rust with no C library, reads the real
  file in 63 ms and matches h5py exactly.

## Design

Rust (`radar_grid.rs` and `radar.rs`):
- **Projection:** the ellipsoidal polar stereographic projection with
  `lat_ts`, checked against pyproj reference values.
- **`decode_odim`:** values, scaling, grid and time window.
- **`render`:** samples the grid at the centre of every pixel of a Web
  Mercator image covering the box around the receiver. Rain in mm/h, i.e.
  ACRR × 60 / accumulation minutes, goes through a fixed colour scale. No rain
  and no coverage are transparent. The output is a PNG.
- **Cache, in memory:** the decoded field and its `validity_time`.
  - The description (about 1 KB) is checked at most every 2.5 minutes.
  - The 2.6 MB product is downloaded only when `validity_time` changes.
  - If a check or download fails, the last image is served with the error.

**Command:** `get_radar(lat, lng, radiusNm, force)` returns
`{pngBase64, bounds, validTimeMs, accumulationMinutes, origin, error}`. The key
comes from `[desktop] meteofrance_api_key`, exported as
`ADSB_METEOFRANCE_API_KEY`.

**TypeScript:**
- `useRadar` polls every 5 minutes while the layer is on;
- `RadarControls`: on/off, opacity, the image's time and age, refresh,
  errors, a colour legend and the credit;
- `RadarLayer`: `L.imageOverlay` on a non-interactive pane below the
  airspaces.

## Not in this step

- Animation of the last hour. The API only serves the latest image, so frames
  would have to be collected over time.
- A rain-rate readout on hover.
- Reflectivity (BUFR).
