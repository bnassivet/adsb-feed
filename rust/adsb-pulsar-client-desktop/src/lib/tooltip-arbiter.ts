/**
 * Arbitrates hover tooltips between GPU dots and Leaflet vector paths.
 *
 * Before deck.gl, dots were `CircleMarker`s on the same Leaflet canvas as the
 * density hexes, range lines and polylines. They were added last, so Leaflet's
 * hit-testing gave a dot under the cursor the hover, and only its tooltip
 * showed. Now the dots live in a separate WebGL overlay, and Leaflet still
 * opens the path's tooltip underneath. This restores the old priority:
 *
 * - **While a dot is hovered**, any path tooltip is closed, both those already open
 *   and any that open later, and its path is remembered.
 * - **When the dot hover ends**, each remembered path the pointer hasn't left (no
 *   `mouseout` from Leaflet) gets its tooltip back at the cursor.
 *
 * Marker tooltips are never touched: over an icon, the dots don't pick at all
 * (see map-hover-target.ts).
 */
import L from "leaflet";

/** `Tooltip._source`, the layer it is bound to: private, but set by Leaflet 1.x on every open. */
type TooltipEvent = L.LeafletEvent & { tooltip: { _source?: L.Layer } };

export class DotTooltipArbiter {
  private dotActive = false;
  /** Path tooltips currently open. */
  private open = new Set<L.Path>();
  /** Paths whose tooltip a dot displaced, mapped to their `mouseout` listener. */
  private displaced = new Map<L.Path, () => void>();

  constructor(private map: L.Map) {
    map.on("tooltipopen", this.onOpen);
    map.on("tooltipclose", this.onClose);
  }

  setDotActive(active: boolean, cursor?: L.LatLng): void {
    if (active === this.dotActive) return;
    this.dotActive = active;
    if (active) {
      for (const p of [...this.open]) this.displace(p);
      return;
    }
    const restore = [...this.displaced.keys()];
    this.clearDisplaced();
    if (cursor) for (const p of restore) p.openTooltip(cursor);
  }

  dispose(): void {
    this.map.off("tooltipopen", this.onOpen);
    this.map.off("tooltipclose", this.onClose);
    this.clearDisplaced();
    this.open.clear();
    this.dotActive = false;
  }

  private onOpen = (e: L.LeafletEvent): void => {
    const src = (e as TooltipEvent).tooltip._source;
    if (!(src instanceof L.Path)) return;
    this.open.add(src);
    // Deferred: closing a tooltip from inside its own open event re-enters Leaflet's add path.
    if (this.dotActive) queueMicrotask(() => this.dotActive && this.displace(src));
  };

  private onClose = (e: L.LeafletEvent): void => {
    const src = (e as TooltipEvent).tooltip._source;
    if (src instanceof L.Path) this.open.delete(src);
  };

  private displace(p: L.Path): void {
    if (!this.displaced.has(p)) {
      const left = () => {
        p.off("mouseout", left);
        this.displaced.delete(p);
      };
      p.on("mouseout", left);
      this.displaced.set(p, left);
    }
    // Closed now, whether or not Leaflet's tooltipclose has fired yet.
    this.open.delete(p);
    p.closeTooltip();
  }

  private clearDisplaced(): void {
    for (const [p, left] of this.displaced) p.off("mouseout", left);
    this.displaced.clear();
  }
}
