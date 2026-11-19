/**
 * deck.gl 9.4.1 (`@deck.gl/mapbox`, latest stable as of 2026-11) reads
 * `map.transform` to follow MapLibre's camera onto terrain
 * (`centerCameraOnTerrain`: `map.transform.elevation`). MapLibre 6 moved the
 * transform behind `map._camera.transform`, so with terrain on, `MapboxOverlay`
 * throws "Cannot read properties of undefined (reading 'elevation')" as it
 * attaches. Every field deck reads still exists; only the path changed.
 *
 * Re-expose it as a live getter until deck.gl catches up. A map that already
 * has `transform` (MapLibre ≤ 5, Mapbox) is left untouched.
 */
export function exposeTransform<M extends object>(map: M): M {
  if ("transform" in map) return map;
  Object.defineProperty(map, "transform", {
    configurable: true,
    get: () => (map as unknown as { _camera: { transform: unknown } })._camera.transform,
  });
  return map;
}
