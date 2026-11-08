/**
 * A Leaflet layer hosting a deck.gl `Deck`: the overlay keeps Leaflet as the
 * map (tiles, controls, DOM markers) and draws dense data on the GPU.
 *
 * Vendored from deck.gl-leaflet 1.3.1 (MIT, Jan Žák — see ./LICENSE). Why not
 * the npm package: it is `"type": "module"` with a CommonJS `main` named `.js`,
 * so a plain import resolves `LeafletLayer` to undefined; its last release was
 * 2024 and it pins `@deck.gl/core ^9`. Changes from upstream: view maths moved
 * to ./view.ts (tested), private-field access typed in one place, the
 * `_animate` pause/resume dropped (no deck.gl transitions are used here).
 */
import L from "leaflet";
import { Deck, type DeckProps } from "@deck.gl/core";
import { leafletToDeckViewState, zoomAnimOffset } from "./view";

/** The two Leaflet internals the zoom animation needs (same ones L.Renderer uses). */
type MapInternals = L.Map & { _animatingZoom: boolean; _getMapPanePos(): L.Point };

export class DeckLayer extends L.Layer {
  private props: DeckProps;
  private container?: HTMLDivElement;
  private deck?: Deck;

  constructor(props: DeckProps) {
    super();
    this.props = props;
  }

  private get m(): MapInternals {
    return this._map as MapInternals;
  }

  private get zoomAnimated(): boolean {
    return (this as unknown as { _zoomAnimated: boolean })._zoomAnimated;
  }

  onAdd(): this {
    const pane = this.getPane();
    if (!pane) return this;
    this.container = L.DomUtil.create("div", "leaflet-layer");
    if (this.zoomAnimated) L.DomUtil.addClass(this.container, "leaflet-zoom-animated");
    pane.appendChild(this.container);
    this.deck = new Deck({
      ...this.props,
      parent: this.container,
      controller: false,
      style: { zIndex: "auto" },
      viewState: leafletToDeckViewState(this.m.getCenter(), this.m.getZoom()),
    });
    this.update();
    return this;
  }

  onRemove(): this {
    if (this.container) L.DomUtil.remove(this.container);
    this.deck?.finalize();
    this.container = undefined;
    this.deck = undefined;
    return this;
  }

  getEvents(): Record<string, L.LeafletEventHandlerFn> {
    return {
      viewreset: this.reset,
      moveend: this.update,
      zoom: this.onZoom,
      ...(this.zoomAnimated ? { zoomanim: this.onAnimZoom as L.LeafletEventHandlerFn } : {}),
    };
  }

  setProps(props: Partial<DeckProps>): void {
    Object.assign(this.props, props);
    this.deck?.setProps(props);
  }

  pickObject(opts: Parameters<Deck["pickObject"]>[0]): ReturnType<Deck["pickObject"]> {
    return this.deck?.pickObject(opts) ?? null;
  }

  pickMultipleObjects(opts: Parameters<Deck["pickMultipleObjects"]>[0]): ReturnType<Deck["pickMultipleObjects"]> {
    return this.deck?.pickMultipleObjects(opts) ?? [];
  }

  /** Re-sync after a pan/zoom has settled: cover the viewport, redraw at the new view. */
  private update = (): void => {
    if (!this.container || !this.deck || this.m._animatingZoom) return;
    const size = this.m.getSize();
    this.container.style.width = `${size.x}px`;
    this.container.style.height = `${size.y}px`;
    L.DomUtil.setPosition(this.container, this.m._getMapPanePos().multiplyBy(-1));
    this.deck.setProps({ viewState: leafletToDeckViewState(this.m.getCenter(), this.m.getZoom()) });
    this.deck.redraw();
  };

  private reset = (): void => {
    this.updateTransform(this.m.getCenter(), this.m.getZoom());
    this.update();
  };

  private onAnimZoom = (e: L.ZoomAnimEvent): void => this.updateTransform(e.center, e.zoom);

  private onZoom = (): void => this.updateTransform(this.m.getCenter(), this.m.getZoom());

  private updateTransform(center: L.LatLng, zoom: number): void {
    if (!this.container) return;
    const m = this.m;
    const scale = m.getZoomScale(zoom, m.getZoom());
    const offset = zoomAnimOffset({
      scale,
      position: L.DomUtil.getPosition(this.container),
      viewHalf: m.getSize().multiplyBy(0.5),
      centerOffset: m.project(center, zoom).subtract(m.project(m.getCenter(), zoom)),
    });
    const p = L.point(offset.x, offset.y);
    if (L.Browser.any3d) L.DomUtil.setTransform(this.container, p, scale);
    else L.DomUtil.setPosition(this.container, p);
  }
}
