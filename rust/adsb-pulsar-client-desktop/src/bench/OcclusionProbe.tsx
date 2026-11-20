"use client";
/**
 * Occlusion and compatibility probe for MapLibre + deck.gl (phase 1 of
 * docs/MAP_ENGINES.md; driven by `npm run bench:checks`).
 *
 * Query string:
 * - `scene=flat|terrain|buildings`: flat has no 3D content (compatibility only);
 *   terrain is Mount Washington from the Terrarium fixture; buildings is the
 *   tallest downtown building in the Protomaps fixture, on terrain.
 * - `mode=interleaved|overlaid`: deck.gl inside MapLibre's render pass, or on its
 *   own canvas on top.
 * - `shim=1|0`: whether `exposeTransform` (deck.gl 9.4 on MapLibre 6) is applied.
 *
 * The page places the camera, computes from the rendered surface one aircraft
 * that must be hidden and one at the same altitude that must be visible
 * (src/bench/occlusion.ts), and exposes `window.__probe` so the driver can show
 * each in turn and diff screenshots.
 */
import { useEffect, useRef } from "react";
import { Map as MlMap, setWorkerUrl, type LngLatLike, type MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScatterplotLayer } from "@deck.gl/layers";
import { benchStyle, CITY_VIEW } from "./maplibre-style";
import { exposeTransform } from "./maplibre-compat";
import { twoFrames } from "./harness";
import {
  changedPixels,
  destination,
  distanceM,
  findProbes,
  pointInPolygon,
  type ElevationAt,
  type LngLat,
  type Point3,
  type Probes,
} from "./occlusion";

type Scene = "flat" | "terrain" | "buildings";
type Show = "none" | "hidden" | "visible";

/** Mount Washington, inside the Terrarium fixture (TERRAIN_BBOX). */
const SUMMIT_GUESS: LngLat = [-71.3033, 44.2706];
const PROBE_RGB: [number, number, number] = [255, 0, 255];

export interface ProbeInfo {
  scene: Scene;
  mode: "interleaved" | "overlaid";
  shim: boolean;
  camera: Point3 | null;
  anchor: (Point3 & { what: string }) | null;
  probes: Probes | null;
  /** Why no probe pair could be placed, if so. */
  note?: string;
}

declare global {
  interface Window {
    __probe?: {
      info: ProbeInfo;
      show(which: Show): Promise<void>;
      /** Changed pixels between two PNG screenshots (base64). */
      diff(a: string, b: string): Promise<number>;
    };
    __probeError?: string;
    __probeErrors?: string[];
  }
}

const idle = (map: MlMap) =>
  new Promise<void>((r) => (map.loaded() && !map.isMoving() ? r() : map.once("idle", () => r())));

async function decode(b64: string): Promise<Uint8ClampedArray> {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

/** MapLibre 6 keeps the transform on the camera; read it there, shim or not. */
function cameraOf(map: MlMap): Point3 {
  const t = (map as unknown as { _camera: { transform: { getCameraLngLat(): { lng: number; lat: number }; getCameraAltitude(): number } } })._camera.transform;
  const ll = t.getCameraLngLat();
  return { lng: ll.lng, lat: ll.lat, alt: t.getCameraAltitude() };
}

function terrainAt(map: MlMap): ElevationAt {
  return (p) => map.queryTerrainElevation(p as LngLatLike);
}

/** Highest point of the DEM near a guess (the fixture's DEM smooths the real summit). */
function findSummit(map: MlMap, guess: LngLat): Point3 {
  let best: Point3 = { lng: guess[0], lat: guess[1], alt: -Infinity };
  for (let dx = -0.04; dx <= 0.04; dx += 0.002) {
    for (let dy = -0.03; dy <= 0.03; dy += 0.002) {
      const p: LngLat = [guess[0] + dx, guess[1] + dy];
      const e = map.queryTerrainElevation(p as LngLatLike) ?? -Infinity;
      if (e > best.alt) best = { lng: p[0], lat: p[1], alt: e };
    }
  }
  return best;
}

interface Building {
  ring: LngLat[];
  height: number;
  bbox: [number, number, number, number];
}

function buildingsOf(map: MlMap): Building[] {
  const out: Building[] = [];
  for (const f of map.querySourceFeatures("osm", { sourceLayer: "buildings" }) as MapGeoJSONFeature[]) {
    const g = f.geometry;
    const rings = g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : [];
    // Same fallback as the style: no height → 6 m.
    const height = Number(f.properties?.height ?? 6) - Number(f.properties?.min_height ?? 0);
    for (const r of rings) {
      const ring = r as LngLat[];
      const xs = ring.map((p) => p[0]);
      const ys = ring.map((p) => p[1]);
      out.push({ ring, height, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  }
  return out;
}

export function OcclusionProbe() {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const q = new URLSearchParams(window.location.search);
    const scene = (q.get("scene") ?? "terrain") as Scene;
    const mode = q.get("mode") === "overlaid" ? "overlaid" : "interleaved";
    const shim = q.get("shim") !== "0";
    const fail = (e: unknown) => (window.__probeError = String(e));
    const record = (msg: string) => (window.__probeErrors ??= []).push(msg);
    const onError = (e: ErrorEvent | PromiseRejectionEvent) => record("reason" in e ? String(e.reason) : e.message);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);

    setWorkerUrl(new URL("/vendor/maplibre/maplibre-gl-worker.mjs", window.location.href).href);
    const start: LngLat = scene === "buildings" ? [CITY_VIEW.center[1], CITY_VIEW.center[0]] : SUMMIT_GUESS;
    const map = new MlMap({
      container: el.current,
      style: benchStyle({ base: window.location.origin, terrain: scene !== "flat", buildings: scene === "buildings" }),
      center: start,
      zoom: scene === "buildings" ? CITY_VIEW.maplibreZoom : 11,
      interactive: false,
      attributionControl: false,
      // The default (60°) silently clamps calculateCameraOptionsFromTo: the
      // camera then sits kilometres higher than asked and nothing can hide.
      maxPitch: 85,
    });
    let rendered: (() => void) | null = null;
    const overlay = new MapboxOverlay({
      interleaved: mode === "interleaved",
      layers: [],
      onAfterRender: () => {
        rendered?.();
        rendered = null;
      },
      onError: (e) => record(`deck: ${e?.message ?? e}`),
    });

    const run = async () => {
      await new Promise<void>((r) => map.once("load", () => r()));
      if (shim) exposeTransform(map);
      try {
        map.addControl(overlay);
      } catch (e) {
        record(`addControl: ${e}`);
      }
      await idle(map);

      const info: ProbeInfo = { scene, mode, shim, camera: null, anchor: null, probes: null };
      let elevationAt: ElevationAt = () => 0;

      if (scene === "terrain") {
        const summit = findSummit(map, SUMMIT_GUESS);
        // From the west, 15 km out and 2.5 km above the (smoothed) summit: a pitch
        // of about 80°, inside maxPitch, low enough for the summit to mask what is behind.
        const from = destination([summit.lng, summit.lat], 270, 15_000);
        map.jumpTo(map.calculateCameraOptionsFromTo({ lng: from[0], lat: from[1] } as never, summit.alt + 2_500, { lng: summit.lng, lat: summit.lat } as never, summit.alt));
        await idle(map);
        elevationAt = terrainAt(map);
        info.anchor = { ...summit, what: "summit (DEM)" };
        info.camera = cameraOf(map);
        info.probes = findProbes({
          camera: info.camera,
          anchor: [summit.lng, summit.lat],
          elevationAt,
          distancesM: Array.from({ length: 15 }, (_, i) => 1_000 + 500 * i),
          lateralM: Array.from({ length: 23 }, (_, i) => 1_000 + 500 * i),
          clearanceM: 300,
          minMarginM: 100,
        });
      } else if (scene === "buildings") {
        const ground = terrainAt(map);
        const all = buildingsOf(map);
        const tallest = all.reduce((a, b) => (b.height > a.height ? b : a));
        const centre: LngLat = [
          tallest.ring.reduce((s, p) => s + p[0], 0) / tallest.ring.length,
          tallest.ring.reduce((s, p) => s + p[1], 0) / tallest.ring.length,
        ];
        const radius = Math.max(...tallest.ring.map((p) => distanceM(centre, p)));
        const base = ground(centre) ?? 0;
        info.anchor = { lng: centre[0], lat: centre[1], alt: base + tallest.height, what: `building ${tallest.height.toFixed(0)} m` };
        // Terrain plus every building standing on the point (extrusions sit on the terrain).
        const surface = (bs: Building[]): ElevationAt => (p) => {
          let h = 0;
          for (const b of bs) {
            if (p[0] < b.bbox[0] || p[0] > b.bbox[2] || p[1] < b.bbox[1] || p[1] > b.bbox[3]) continue;
            if (b.height > h && pointInPolygon(p, b.ring)) h = b.height;
          }
          return (ground(p) ?? 0) + h;
        };
        // Try camera directions until one sees the tower with a clear line beside it.
        for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
          const from = destination(centre, bearing + 180, radius + 600);
          map.jumpTo(map.calculateCameraOptionsFromTo({ lng: from[0], lat: from[1] } as never, base + tallest.height * 0.7, { lng: centre[0], lat: centre[1] } as never, base + tallest.height * 0.4));
          await idle(map);
          elevationAt = surface(buildingsOf(map));
          info.camera = cameraOf(map);
          info.probes = findProbes({
            camera: info.camera,
            anchor: centre,
            elevationAt,
            distancesM: [radius + 20, radius + 40, radius + 60, radius + 90],
            lateralM: Array.from({ length: 30 }, (_, i) => radius + 30 + 15 * i),
            clearanceM: tallest.height * 0.4,
            minMarginM: 5,
            stepM: 3,
          });
          if (info.probes) break;
        }
      } else {
        // No 3D content: the probe is only "does deck draw at all". Aircraft at 1000 m over the centre.
        const c = map.getCenter();
        map.jumpTo({ pitch: 60 });
        await idle(map);
        info.camera = cameraOf(map);
        info.probes = {
          hidden: { lng: c.lng, lat: c.lat, alt: 1_000 },
          visible: { lng: c.lng, lat: c.lat, alt: 1_000 },
          hiddenMarginM: NaN,
          visibleMarginM: NaN,
        };
        info.note = "flat: no 3D content, so nothing can hide the aircraft; checks drawing only";
      }
      if (!info.probes) info.note = "no hidden/visible pair found from this camera";

      const show = (which: Show) =>
        new Promise<void>((resolve) => {
          const p = which === "none" || !info.probes ? null : info.probes[which];
          rendered = () => void twoFrames().then(() => resolve());
          overlay.setProps({
            layers: p
              ? [
                  new ScatterplotLayer<Point3>({
                    id: "probe",
                    data: [p],
                    getPosition: (d) => [d.lng, d.lat, d.alt],
                    getFillColor: PROBE_RGB,
                    radiusUnits: "pixels",
                    getRadius: 10,
                    // Facing the camera: a flat disc seen almost edge-on would hide itself.
                    billboard: true,
                  }),
                ]
              : [],
          });
          map.triggerRepaint();
          // A deck that fails to draw never calls onAfterRender; do not hang the driver.
          setTimeout(() => {
            rendered = null;
            resolve();
          }, 3_000);
        });

      window.__probe = {
        info,
        show,
        diff: async (a, b) => changedPixels(await decode(a), await decode(b)),
      };
    };
    run().catch(fail);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
      map.remove();
    };
  }, []);

  return <div ref={el} style={{ position: "fixed", inset: 0, background: "#111" }} />;
}
