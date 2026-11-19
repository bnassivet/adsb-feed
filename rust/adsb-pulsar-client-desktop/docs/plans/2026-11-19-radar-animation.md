# Rain radar: animation of the last hour

Status: implemented on branch `feature/metar-layer` (follows the radar layer,
`2026-11-19-radar-layer.md`); not yet seen in the running app.

## Constraint

`DonneesPubliquesRadar` serves only the current 5-minute mosaic; the API has
no time parameter. `DonneesPubliquesPaquetRadar` returns the last quarter hour
only, and needs a second subscription. So the hour is collected by the app.

## Design

- **Rust keeps what it downloads.** `get_radar` already fetches each new
  mosaic once; after it decodes, the raw file (2.6 MB) is written to
  `<stack data dir>/radar/lame_d_eau-YYYYMMDDTHHMMZ.h5` (temporary name, then
  rename). Frames more than 60 min older than the newest are deleted on each
  save, so the directory holds about 31 MB.
- **Frames exist only for the times the layer was on**, and survive a restart.
  If the newest frame is over an hour old, there is no animation: yesterday's
  rain must not play as "the last hour". Gaps are shown as they are.
- **`get_radar_frames(lat, lng, radiusNm, knownMs)`** renders the saved frames
  for the box, oldest first. Rendered PNGs are cached in memory per box and
  shared with `get_radar`, so nothing is rendered twice. Decoded fields
  (24 MB each) are not kept; missing frames are decoded and rendered on up to
  4 threads. Frames in `knownMs` come back without their image, so a refresh
  sends one new image, not twelve.
- **Webview.** `useRadarFrames` asks when the animation is switched on and
  again each time the latest image changes. `useFrameAnimation` steps every
  500 ms and holds the newest frame 2 s. `RadarLayer` keeps one image overlay
  per frame, all loaded, and switches frames by opacity, so the loop never
  flashes blank. With fewer than two frames, the latest image is shown.
- **Controls.** "Animate last hour" (`adsb-radar-animate`, off by default),
  the frame time and its position ("Frame 02:40 UTC · 3/12"), and while fewer
  than 12 frames exist, how many have been collected and why.

## Tests

- Rust: file names, selection of the hour, pruning on save, the render
  cache (reuse, new box, forgetting), the JSON shape; `load_radar` tells the
  decode step which image it has.
- TS: merging frame answers, views, timing, the frames hook (StrictMode, known
  list, receiver move, errors), the animation hook, the controls.

## Not in this step

- Pause, step or speed controls.
- Backfill from the 15-minute "paquet" product.
- Collecting frames while the layer is off.
