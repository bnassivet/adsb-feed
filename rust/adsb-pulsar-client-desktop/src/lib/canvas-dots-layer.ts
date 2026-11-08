/**
 * Imperative half of the typed-array canvas renderer (pure half: ./canvas-dots.ts).
 *
 * Subclasses Leaflet's own `L.Canvas` renderer so resizing, padding, panning
 * and the zoom-animation CSS transform are Leaflet's, unchanged. Only `_draw`
 * is extended: Leaflet's `_redraw` clears the canvas then calls `_draw`, with
 * the context already translated to layer points.
 */
import L from "leaflet";
import type { DotBuckets } from "./canvas-dots";

/** The `L.Canvas` internals used here; stable across Leaflet 1.x. */
interface CanvasInternals {
  _ctx: CanvasRenderingContext2D;
  _bounds: L.Bounds;
  _map: L.Map;
  _draw(): void;
  _redraw(): void;
}

export interface DotStyle {
  radius: number;
  alpha: number;
  /** CSS colour for a bucket's altitude bin (see `DotBuckets.bins`). */
  colorOfBin(bin: number): string;
}

export interface PathSet {
  /** Zoom-0 world pixels; path i is [starts[i], starts[i+1]). */
  x: Float64Array;
  y: Float64Array;
  starts: Uint32Array;
}

export interface LineStyle {
  color: string;
  width: number;
  alpha: number;
}

export class CanvasDotsRenderer extends L.Canvas {
  private dots: { b: DotBuckets; style: DotStyle; colors: string[] } | null = null;
  private lines: { p: PathSet; style: LineStyle } | null = null;
  private heads: { x: Float64Array; y: Float64Array; radius: number; color: string } | null = null;

  private get i(): CanvasInternals {
    return this as unknown as CanvasInternals;
  }

  setDots(b: DotBuckets | null, style: DotStyle): void {
    this.dots = b && { b, style, colors: b.bins.map(style.colorOfBin) };
    this.redrawNow();
  }

  setLines(p: PathSet | null, style: LineStyle): void {
    this.lines = p && { p, style };
    this.redrawNow();
  }

  setHeads(x: Float64Array, y: Float64Array, radius: number, color: string): void {
    this.heads = { x, y, radius, color };
    this.redrawNow();
  }

  /** Synchronous redraw (Leaflet's own `_requestRedraw` defers to the next frame). */
  redrawNow(): void {
    if (this.i._map && this.i._ctx) this.i._redraw();
  }

  _draw(): void {
    (L.Canvas.prototype as unknown as CanvasInternals)._draw.call(this);
    const { _ctx: ctx, _bounds: bounds, _map: map } = this.i;
    if (!bounds) return;
    const s = 2 ** map.getZoom();
    const o = map.getPixelOrigin();
    const view = { x0: bounds.min!.x, y0: bounds.min!.y, x1: bounds.max!.x, y1: bounds.max!.y };
    ctx.save();
    if (this.lines) this.drawLines(ctx, this.lines.p, this.lines.style, s, o);
    if (this.dots) this.drawDots(ctx, this.dots.b, this.dots.style, this.dots.colors, s, o, view);
    if (this.heads) {
      const h = this.heads;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = h.color;
      fillCircles(ctx, h.x, h.y, 0, h.x.length, h.radius, s, o, view);
    }
    ctx.restore();
  }

  private drawDots(ctx: CanvasRenderingContext2D, b: DotBuckets, st: DotStyle, colors: string[], s: number, o: L.Point, view: View) {
    ctx.globalAlpha = st.alpha;
    for (let k = 0; k < b.bins.length; k++) {
      ctx.fillStyle = colors[k];
      fillCircles(ctx, b.x, b.y, b.starts[k], b.starts[k + 1], st.radius, s, o, view);
    }
  }

  private drawLines(ctx: CanvasRenderingContext2D, p: PathSet, st: LineStyle, s: number, o: L.Point) {
    ctx.globalAlpha = st.alpha;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.width;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let t = 0; t + 1 < p.starts.length; t++) {
      const a = p.starts[t], z = p.starts[t + 1];
      if (z - a < 2) continue;
      ctx.moveTo(p.x[a] * s - o.x, p.y[a] * s - o.y);
      for (let j = a + 1; j < z; j++) ctx.lineTo(p.x[j] * s - o.x, p.y[j] * s - o.y);
    }
    ctx.stroke();
  }
}

interface View { x0: number; y0: number; x1: number; y1: number }

/** One path, one fill for a run of same-colour circles; points outside the padded view are skipped. */
function fillCircles(ctx: CanvasRenderingContext2D, x: Float64Array, y: Float64Array, from: number, to: number, r: number, s: number, o: L.Point, v: View) {
  ctx.beginPath();
  for (let j = from; j < to; j++) {
    const px = x[j] * s - o.x;
    const py = y[j] * s - o.y;
    if (px < v.x0 - r || px > v.x1 + r || py < v.y0 - r || py > v.y1 + r) continue;
    ctx.moveTo(px + r, py);
    ctx.arc(px, py, r, 0, 2 * Math.PI);
  }
  ctx.fill();
}
