/**
 * Sea overlays: OpenSeaMap seamarks and EMODnet depth (colours and contours).
 * Both are keyless image tiles drawn by Leaflet; nothing goes through Rust or
 * the tile cache. Sources and the choice of layers:
 * `docs/plans/2026-11-19-sea-overlays.md`.
 */

export const SEAMARK_URL = "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png";
/** Below this the seamark tiles are empty: no requests at all. */
export const SEAMARK_MIN_ZOOM = 9;
export const SEAMARK_MAX_NATIVE_ZOOM = 18;

export const EMODNET_WMS_URL = "https://ows.emodnet-bathymetry.eu/wms";
/** Sea only: land is transparent in this style. */
export const DEPTH_COLOURS_LAYER = "emodnet:mean_multicolour";
/** White lines and labels, made for a dark map. */
export const DEPTH_CONTOURS_LAYER = "emodnet:contours";

/** Every host the overlays load from, for the CSP (`csp.test.ts`). */
export const SEA_HOSTS = ["https://tiles.openseamap.org", "https://ows.emodnet-bathymetry.eu"];

export const SEAMARK_ATTRIBUTION = 'Seamarks © <a href="https://www.openseamap.org">OpenSeaMap</a> contributors';
export const DEPTH_ATTRIBUTION = 'Depth © <a href="https://emodnet.ec.europa.eu/en/bathymetry">EMODnet Bathymetry</a>';

export const DEFAULT_SEAMARK_OPACITY = 0.9;
/** The colour ramp runs from red to dark blue: faint by default. */
export const DEFAULT_DEPTH_OPACITY = 0.35;

export interface SeaSettings {
  seamarks: boolean;
  seamarkOpacity: number;
  depthColours: boolean;
  depthContours: boolean;
  depthOpacity: number;
}

/** The WMS `layers` parameter for the depth switches; null when both are off. */
export function depthLayers(on: { colours: boolean; contours: boolean }): string | null {
  const layers = [on.colours && DEPTH_COLOURS_LAYER, on.contours && DEPTH_CONTOURS_LAYER].filter(Boolean);
  return layers.length > 0 ? layers.join(",") : null;
}

/**
 * The colours of `emodnet:mean_multicolour` at its legend's marks, sampled
 * from EMODnet's GetLegendGraphic. The scale is not linear: most of the
 * colour goes to shallow water.
 */
export const DEPTH_LEGEND: { depthM: number; color: string }[] = [
  { depthM: 0, color: "#ff5f64" },
  { depthM: 10, color: "#ff000f" },
  { depthM: 50, color: "#f9f408" },
  { depthM: 150, color: "#c5fb00" },
  { depthM: 450, color: "#56fe2c" },
  { depthM: 1000, color: "#08c3e1" },
  { depthM: 2000, color: "#0615e2" },
  { depthM: 3500, color: "#000042" },
];
