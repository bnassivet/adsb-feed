"use client";
/**
 * Cesium 3D globe: points as a PointPrimitiveCollection and tracks as a
 * PolylineCollection — the idiomatic primitive API a port of the app would use
 * (Entities would be heavier). Positions are at their true altitude, which is
 * the reason to consider Cesium at all. No Ion: no imagery (the bench blocks
 * tiles for every variant), ellipsoid terrain, no sky.
 *
 * Cesium is NOT bundled: Next's minifier corrupts a template literal in
 * Cesium's ESM build ("Octal escape sequences are not allowed in template
 * strings" at chunk load). Its prebuilt, already-minified `Cesium.js` is loaded
 * as a script instead, with workers and assets beside it — the usual way to
 * use Cesium with Next. The driver serves node_modules/cesium/Build/Cesium under
 * /vendor/cesium/ (never via public/, which ships).
 */
import { useEffect, useRef } from "react";
import type * as CesiumNs from "cesium";
import { flatten, type Flat } from "../flatten";
import { altitudeRgb, LINE_RGB } from "../color";
import { flatToEcef, zoomToCameraHeight } from "../cesium-geo";
import { installBench, BENCH_VIEW, type BenchParams } from "../harness";
import type { AircraftTrack } from "@/lib/types";
import type { Style } from "../stats";

type C = typeof CesiumNs;

class Scene3D {
  private points: CesiumNs.PointPrimitiveCollection;
  private lines: CesiumNs.PolylineCollection;
  private heads: CesiumNs.PointPrimitiveCollection;
  private lineMaterial: CesiumNs.Material;
  private colors = new Map<number, CesiumNs.Color>();

  constructor(private C: C, scene: CesiumNs.Scene, private live: boolean) {
    this.points = scene.primitives.add(new C.PointPrimitiveCollection());
    this.lines = scene.primitives.add(new C.PolylineCollection());
    this.heads = scene.primitives.add(new C.PointPrimitiveCollection());
    this.lineMaterial = C.Material.fromType("Color", { color: C.Color.fromBytes(...LINE_RGB, 128) });
  }

  private color(alt: number, alpha: number): CesiumNs.Color {
    const [r, g, b] = altitudeRgb(alt);
    const key = (r << 16) | (g << 8) | b;
    let c = this.colors.get(key);
    if (!c) this.colors.set(key, (c = this.C.Color.fromBytes(r, g, b, alpha)));
    return c;
  }

  set(tracks: AircraftTrack[], style: Style): void {
    const { C } = this;
    const f: Flat = flatten(tracks);
    const xyz = flatToEcef(f);
    const at = (i: number) => new C.Cartesian3(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
    this.points.removeAll();
    this.lines.removeAll();
    this.heads.removeAll();

    if (style === "dots") {
      const alpha = Math.round((this.live ? 0.6 : 0.4) * 255);
      const size = (this.live ? 3 : 2.5) * 2;
      for (let i = 0; i < f.count; i++) {
        this.points.add({ position: at(i), color: this.color(f.alt[i], alpha), pixelSize: size });
      }
    } else {
      for (let t = 0; t + 1 < f.starts.length; t++) {
        const positions: CesiumNs.Cartesian3[] = [];
        for (let i = f.starts[t]; i < f.starts[t + 1]; i++) positions.push(at(i));
        if (positions.length > 1) this.lines.add({ positions, width: 2, material: this.lineMaterial });
      }
    }
    if (this.live) {
      for (const h of f.heads) this.heads.add({ position: at(h), color: C.Color.WHITE.withAlpha(0.9), pixelSize: 10 });
    }
  }
}

/** Load the prebuilt Cesium.js once; resolves to its `window.Cesium` global. */
function loadCesium(base: string): Promise<C> {
  const w = window as unknown as { Cesium?: C; CESIUM_BASE_URL?: string };
  if (w.Cesium) return Promise.resolve(w.Cesium);
  w.CESIUM_BASE_URL = base;
  // Sizes the widget's canvas to its container; without it the canvas stays 300×150.
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = `${base}Widgets/widgets.css`;
  document.head.appendChild(css);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${base}Cesium.js`;
    s.onload = () => (w.Cesium ? resolve(w.Cesium) : reject(new Error("Cesium.js loaded without a Cesium global")));
    s.onerror = () => reject(new Error(`failed to load ${s.src}`));
    document.head.appendChild(s);
  });
}

export default function Cesium({ params }: { params: BenchParams }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const container = el.current;
    let widget: CesiumNs.CesiumWidget | null = null;
    let handler: CesiumNs.ScreenSpaceEventHandler | null = null;
    let disposed = false;

    (async () => {
      const C = await loadCesium(new URL("/vendor/cesium/", window.location.href).href);
      if (disposed) return;

      widget = new C.CesiumWidget(container, {
        baseLayer: false,
        terrainProvider: new C.EllipsoidTerrainProvider(),
        skyBox: false,
        skyAtmosphere: false,
        creditContainer: document.createElement("div"),
      });
      const scene = widget.scene;
      scene.globe.baseColor = C.Color.fromCssColorString("#111111");
      scene.globe.showGroundAtmosphere = false;
      scene.fog.enabled = false;
      scene.backgroundColor = C.Color.fromCssColorString("#111111");
      // Points at altitude must not be hidden by the globe's horizon test.
      scene.globe.depthTestAgainstTerrain = false;

      const camera = scene.camera;
      const [lat, lng] = BENCH_VIEW.center;
      const fov = (camera.frustum as CesiumNs.PerspectiveFrustum).fov ?? Math.PI / 3;
      const height = zoomToCameraHeight(BENCH_VIEW.zoom, lat, container.clientWidth, container.clientHeight, fov);
      camera.setView({ destination: C.Cartesian3.fromDegrees(lng, lat, height) });

      // Same gesture as the 2D variants: double-click zooms in one level about
      // the centre, shift+double-click out, animated like Leaflet's 250 ms.
      handler = new C.ScreenSpaceEventHandler(scene.canvas);
      const zoomBy = (factor: number) => {
        const c = camera.positionCartographic;
        camera.flyTo({ destination: C.Cartesian3.fromRadians(c.longitude, c.latitude, c.height * factor), duration: 0.25 });
      };
      handler.setInputAction(() => zoomBy(0.5), C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
      handler.setInputAction(() => zoomBy(2), C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK, C.KeyboardEventModifier.SHIFT);

      const data = new Scene3D(C, scene, params.scenario === "live");
      installBench(
        {
          // Primitive buffers are built in the next render's update pass; resolve after it.
          setData: (tracks, style) =>
            new Promise<void>((resolve) => {
              data.set(tracks, style);
              const off = scene.postRender.addEventListener(() => {
                off();
                resolve();
              });
              scene.requestRender();
            }),
          onMoveEnd: (cb) => camera.moveEnd.addEventListener(cb),
        },
        params,
      );
    })().catch((e) => {
      window.__benchError = String(e);
    });

    return () => {
      disposed = true;
      handler?.destroy();
      widget?.destroy();
    };
  }, [params]);

  return <div ref={el} style={{ position: "fixed", inset: 0, background: "#111" }} />;
}
