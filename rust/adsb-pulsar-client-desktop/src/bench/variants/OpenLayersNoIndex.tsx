"use client";
/** OpenLayers WebGL, one Feature per point, no R-tree in the source. */
import { OpenLayersVariant } from "./OpenLayers";
import type { BenchParams } from "../harness";

export default function OpenLayersNoIndex({ params }: { params: BenchParams }) {
  return <OpenLayersVariant params={params} mode="noindex" />;
}
