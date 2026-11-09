/**
 * Pure Leaflet → deck.gl view maths. Vendored from deck.gl-leaflet 1.3.1
 * (MIT, Jan Žák — see ./LICENSE), split out of the layer so it is testable.
 */

export interface XY {
  x: number;
  y: number;
}

export interface DeckViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/** deck.gl's web-mercator zoom counts 512 px tiles; Leaflet's counts 256 px, hence -1. */
export function leafletToDeckViewState(center: { lat: number; lng: number }, zoom: number): DeckViewState {
  return { longitude: center.lng, latitude: center.lat, zoom: zoom - 1, pitch: 0, bearing: 0 };
}

/**
 * Top-left of the deck canvas while Leaflet CSS-animates a zoom, so the
 * already-drawn frame scales with the tiles instead of lagging behind them.
 * Same maths as Leaflet's own `Renderer._updateTransform`.
 *
 * @param scale        Leaflet `getZoomScale(targetZoom, currentZoom)`
 * @param position     the container's current pane position
 * @param viewHalf     half the map size
 * @param centerOffset target centre minus current centre, projected at the target zoom
 */
export function zoomAnimOffset(a: { scale: number; position: XY; viewHalf: XY; centerOffset: XY }): XY {
  const { scale, position, viewHalf, centerOffset } = a;
  return {
    x: -viewHalf.x * scale + position.x + viewHalf.x - centerOffset.x,
    y: -viewHalf.y * scale + position.y + viewHalf.y - centerOffset.y,
  };
}
