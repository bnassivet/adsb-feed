# What's here? and height above ground

Status: implemented on branch `feature/sea-overlays`; not yet seen in the
running app.

## Question

Can the relief or the depth layer give the value at a clicked point? No:
the hillshade is lighting (slope × sun), and the EMODnet layer is a coloured
picture. The data behind them can.

## Sources, checked 2026-11-19

| Need | Source | Check |
|---|---|---|
| Ground height | **Terrarium** tiles, `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, keyless; height = `R*256 + G + B/256 − 32768` m | Mont Blanc 4,779 m (z12), 4,780 m (z14). Sea is exactly 0. |
| Ground height (rejected) | IGN Géoplateforme altimetry, `resource=ign_rge_alti_wld` | 4,757 m but 4.2 s per point; −99999 at sea |
| Sea depth | **EMODnet** `rest.emodnet-bathymetry.eu/depth_sample?geom=POINT(lon lat)` | −1,955 m (min −1,996, max −1,916) in 0.27 s; −22.7 m near the coast in 0.11 s. Over land it answers a **positive** height. |
| Sea depth (alternative) | EMODnet WMS GetFeatureInfo on `emodnet:mean` | works (−1,889 m), single value only |

## Design

- **Rust `terrain.rs`**: Terrarium at z12 (~9 × 7 km tiles), each tile kept
  on disk for good under `<stack data dir>/terrain/12/x/y.png` (terrain does
  not change; a bad answer is not kept), decoded into a 16-tile in-memory set,
  bilinear between pixel centres. `parse_depth` keeps EMODnet's answer only
  when negative.
- **Commands**: `get_ground_elevation(lat, lng)`, and `what_is_here(lat, lng)`
  asking both sources together, each half failing on its own.
- **"What's here?"**: a context-menu item. The box opens where the menu was
  and shows the ground (m and ft), the sea depth with its range, both on a
  coast, or "Sea level".
- **Height above ground** (details panel, "Height AGL"): altitude minus
  `max(ground, 0)`; the QNH altitude at any height when a station is near,
  else pressure altitude marked "std"; no row on the ground. The ground is
  asked once per ~200 m cell, at the cell centre, and the previous value
  stays shown while the next loads.

## Not in this step

- Terrain or depth on hover.
- A terrain profile along the track.
