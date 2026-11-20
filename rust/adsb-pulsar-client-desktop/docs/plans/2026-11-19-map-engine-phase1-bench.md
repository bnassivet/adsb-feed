# Map engines, phase 1: close the open measurements

Phase 1 of the plan in [MAP_ENGINES.md](../MAP_ENGINES.md) → *Recommendation*.
Bench only: nothing ships, and no product code changes.

**Status: done 2026-11-19, go for phase 2.** Results and mitigations:
MAP_ENGINES.md → *Phase 1 results*. The go/no-go for phase 2
is: **every item passes, or has a mitigation that is written down.**

| # | Open item | How it is closed |
|---|---|---|
| 1 | Tiles over the network during gestures | `--net` profiles in the driver: latency per request and one shared bandwidth link, applied to `/fixtures/` tiles only. New `idleMs` metric: gesture end → MapLibre `idle` (every tile in) |
| 2 | A weaker GPU | No second machine here, so three proxies: Chromium with **SwiftShader** (software WebGL, a floor no real GPU is below), **`--dpr 2`** (Retina: 4× the pixels, which the shipping app draws on a Mac and the bench never did), and **`--cpu-throttle N`** (CDP). The driver stays portable, so a real weaker machine can rerun the same command |
| 3 | Visual check: a hill or building hides an aircraft | `/bench/occlusion` probe page + `npm run bench:checks`. The camera is placed explicitly (`calculateCameraOptionsFromTo`). For each scene it finds, by **line of sight over the rendered terrain and buildings**, one aircraft position that must be hidden and one at the same altitude that must be visible, then counts the pixels each one changes in a screenshot. Screenshots are saved for a human look |
| 4 | deck.gl 9.4 reads `map.transform`, which MapLibre 6 moved | The same probe runs with and without `exposeTransform`, overlaid and interleaved, with and without terrain, and records errors and whether deck drew. A canary unit test reads the installed `@deck.gl/mapbox` and fails once it stops reading `map.transform`, which is when the shim can go |

## Scenes (occlusion)

Both stay inside the existing fixtures and away from any receiver.

- **Terrain:** Mount Washington (1917 m, inside `TERRAIN_BBOX`), camera 20 km to
  the west at 2500 m. Real relief, no exaggeration.
- **Buildings:** the tallest building with a `height` in the downtown Montréal
  fixture, found at run time, terrain on (as in `maplibre-deckgl-buildings`).

Expected: interleaved hides the blocked aircraft and shows the clear one;
overlaid shows both (which is why the port must interleave).

## Pure code (tested first)

`src/bench/net.ts` — profiles and a shared-link scheduler.
`src/bench/occlusion.ts` — destination point, point in polygon, line of sight
over an elevation function, changed-pixel count.

## Not in scope

Upgrading deck.gl or pinning MapLibre 5: both need a dependency change, which
phase 2 decides with these results in hand.
