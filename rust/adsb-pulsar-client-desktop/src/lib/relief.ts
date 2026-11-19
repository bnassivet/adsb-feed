/**
 * Relief: Esri's World Hillshade multiplied over the base map. The tiles are
 * opaque grey-on-white; with `multiply`, white leaves the map unchanged and
 * only slopes darken it. Chosen over soft-light and the dark hillshade from
 * composites on both base maps: `docs/plans/2026-11-19-relief.md`.
 */

export const RELIEF_HOST = "https://server.arcgisonline.com";
export const RELIEF_URL = `${RELIEF_HOST}/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}`;
export const RELIEF_ATTRIBUTION = 'Relief © <a href="https://www.esri.com">Esri</a> World Hillshade';
/** CSS `mix-blend-mode` of the relief pane, in both themes. */
export const RELIEF_BLEND = "multiply";
export const DEFAULT_RELIEF_OPACITY = 0.6;
/** Real detail down to here, in the Alps and western France alike (checked). */
export const RELIEF_MAX_NATIVE_ZOOM = 16;
