"use client";
/** OpenLayers WebGL, one MultiPoint per 1000 ft altitude bin instead of one Feature per point. */
import { OpenLayersVariant } from "./OpenLayers";
import type { BenchParams } from "../harness";

export default function OpenLayersBinned({ params }: { params: BenchParams }) {
  return <OpenLayersVariant params={params} mode="binned" />;
}
