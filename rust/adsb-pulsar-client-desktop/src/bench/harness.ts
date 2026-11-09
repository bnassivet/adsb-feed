/**
 * In-page benchmark runner. Each variant page builds a `BenchTarget` around its
 * map and calls `installBench`; the Playwright driver then calls
 * `window.__bench.*`. Timing happens here, in the page, so Playwright's IPC
 * latency never lands in a measured interval.
 */
import type { AircraftTrack } from "@/lib/types";
import { generateTracks, liveStep, BENCH_CENTER } from "./data";

/**
 * Same view as MapInner (DEFAULT_CENTER, DEFAULT_ZOOM = 8). MapLibre counts zoom
 * in 512 px tiles, so the identical view is one zoom level lower there.
 */
export const BENCH_VIEW = { center: BENCH_CENTER, zoom: 8, maplibreZoom: 7 } as const;
import { summarizeFrames, median, type FrameSummary, type Scenario, type Style } from "./stats";

export const LIVE_AIRCRAFT = 500;
/** 50 trail positions per aircraft at start (the live cap is 100). */
export const LIVE_POINTS = LIVE_AIRCRAFT * 50;
export const LIVE_INTERVAL_MS = 500;
export const LIVE_DURATION_MS = 10_000;

export interface BenchParams {
  size: number;
  style: Style;
  scenario: Exclude<Scenario, "memory">;
  seed: number;
}

const STYLES: readonly Style[] = ["dots", "line"];
const SCENARIOS: readonly BenchParams["scenario"][] = ["initial", "panzoom", "settle", "live"];

export function parseParams(search: string): BenchParams {
  const q = new URLSearchParams(search);
  const size = Number(q.get("size") ?? 10_000);
  const style = (q.get("style") ?? "dots") as Style;
  const scenario = (q.get("scenario") ?? "initial") as BenchParams["scenario"];
  const seed = Number(q.get("seed") ?? 1);
  if (!Number.isInteger(size) || size <= 0) throw new Error(`bad size: ${q.get("size")}`);
  if (!STYLES.includes(style)) throw new Error(`bad style: ${style}`);
  if (!SCENARIOS.includes(scenario)) throw new Error(`bad scenario: ${scenario}`);
  return { size: scenario === "live" ? LIVE_POINTS : size, style, scenario, seed };
}

/** What a variant must provide. */
export interface BenchTarget {
  /** Hand the map new data; resolve once the library reports it has rendered it. */
  setData(tracks: AircraftTrack[], style: Style): Promise<void>;
  /** Subscribe to the end of a pan/zoom gesture. Returns an unsubscribe. */
  onMoveEnd(cb: () => void): () => void;
}

export function nextFrame(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r));
}

/** Two frames: the first may be the one already in flight, the second is painted after our work. */
export async function twoFrames(): Promise<number> {
  await nextFrame();
  return nextFrame();
}

class FrameRecorder {
  private deltas: number[] = [];
  private last = 0;
  private running = false;

  start(): void {
    this.deltas = [];
    this.running = true;
    this.last = 0;
    const loop = (t: number) => {
      if (!this.running) return;
      if (this.last) this.deltas.push(t - this.last);
      this.last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): FrameSummary {
    this.running = false;
    return summarizeFrames(this.deltas);
  }
}

function gpuRenderer(): string {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return "no webgl";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch (e) {
    return `error: ${e}`;
  }
}

function heapMB(): number | null {
  const w = window as unknown as { gc?: () => void };
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (!mem) return null;
  w.gc?.();
  return mem.usedJSHeapSize / 1_048_576;
}

export interface BenchApi {
  params: BenchParams;
  gpu: string;
  /** Initial render: setData → painted. Also loads the data the other scenarios use. */
  initial(): Promise<Record<string, number>>;
  startFrames(): void;
  stopFrames(): FrameSummary;
  /** Settle times recorded since the last call, then cleared. */
  takeSettles(): Record<string, number>;
  live(): Promise<Record<string, number>>;
  heapMB(): number | null;
}

declare global {
  interface Window {
    __bench?: BenchApi;
    __benchError?: string;
    __benchPageErrors?: string[];
  }
}

export function installBench(target: BenchTarget, params: BenchParams): BenchApi {
  const frames = new FrameRecorder();
  let settles: number[] = [];

  target.onMoveEnd(() => {
    const t0 = performance.now();
    void twoFrames().then((t) => settles.push(t - t0));
  });

  const api: BenchApi = {
    params,
    gpu: gpuRenderer(),

    async initial() {
      const genStart = performance.now();
      const tracks = generateTracks({
        points: params.size,
        seed: params.seed,
        live: params.scenario === "live",
        aircraft: LIVE_AIRCRAFT,
      });
      const t0 = performance.now();
      await target.setData(tracks, params.style);
      const rendered = performance.now();
      const t1 = await twoFrames();
      return {
        generateMs: t0 - genStart,
        setDataMs: rendered - t0,
        totalMs: t1 - t0,
        tracks: tracks.length,
      };
    },

    startFrames: () => frames.start(),
    stopFrames: () => frames.stop(),

    takeSettles() {
      const s = settles;
      settles = [];
      return { settleMs: median(s), settleMax: s.length ? Math.max(...s) : NaN, stops: s.length };
    },

    async live() {
      let tracks = generateTracks({ points: LIVE_POINTS, seed: params.seed, live: true, aircraft: LIVE_AIRCRAFT });
      await target.setData(tracks, params.style);
      await twoFrames();
      frames.start();
      const updateCosts: number[] = [];
      const ticks = LIVE_DURATION_MS / LIVE_INTERVAL_MS;
      for (let i = 1; i <= ticks; i++) {
        await new Promise((r) => setTimeout(r, LIVE_INTERVAL_MS));
        tracks = liveStep(tracks, params.seed + i);
        const t0 = performance.now();
        await target.setData(tracks, params.style);
        updateCosts.push(performance.now() - t0);
      }
      const f = frames.stop();
      return { ...f, updateMs: median(updateCosts) };
    },

    heapMB,
  };
  window.__bench = api;
  return api;
}
