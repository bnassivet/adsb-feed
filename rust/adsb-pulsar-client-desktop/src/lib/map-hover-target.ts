/**
 * Whether a pointer event's target is the bare map surface, where GPU dots
 * may be hovered.
 *
 * The deck.gl overlay picks dots from the map's own `mousemove`, and that event
 * also fires over DOM elements that have their own hover. The case that showed
 * it: the newest live dot sits exactly under its aircraft icon, so hovering
 * the icon opened the icon's tooltip *and* the dot's. Under the old
 * `CircleMarker` dots this couldn't happen, because a canvas path can't be
 * hovered through a DOM element above it.
 */
const OWN_HOVER = ".leaflet-marker-pane, .leaflet-tooltip-pane, .leaflet-popup-pane, .leaflet-control-container";

export function isBareMapTarget(target: EventTarget | null, container: HTMLElement): boolean {
  if (!(target instanceof Element) || !container.contains(target)) return false;
  return target.closest(OWN_HOVER) === null;
}
