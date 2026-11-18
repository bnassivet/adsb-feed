/** OpenLayers view → deck.gl MapView viewState, for drawing deck.gl over an OL basemap. */
const R = 6_378_137;

export interface DeckViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
}

/**
 * OL counts zoom in 256 px tiles, deck.gl in 512 px tiles (one level lower for
 * the same view). OL rotation is counter-clockwise radians; deck's bearing is
 * clockwise degrees.
 */
export function olToDeckViewState(center: readonly number[], zoom: number, rotation: number): DeckViewState {
  const longitude = (center[0] / R) * (180 / Math.PI);
  const latitude = (2 * Math.atan(Math.exp(center[1] / R)) - Math.PI / 2) * (180 / Math.PI);
  return { longitude, latitude, zoom: zoom - 1, bearing: (-rotation * 180) / Math.PI };
}
