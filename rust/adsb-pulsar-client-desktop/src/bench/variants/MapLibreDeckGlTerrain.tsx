"use client";
/** Interleaved + 3D terrain and hillshade, at the default (receiver range) view. */
import { MapLibreDeckGlVariant } from "./MapLibreDeckGl";
import type { BenchParams } from "../harness";

export default function MapLibreDeckGlTerrain({ params }: { params: BenchParams }) {
  return <MapLibreDeckGlVariant params={params} pitched interleaved terrain />;
}
