"use client";
/** Interleaved + terrain + OSM 3D buildings over downtown Montréal at zoom 15 (the densest case). */
import { MapLibreDeckGlVariant } from "./MapLibreDeckGl";
import type { BenchParams } from "../harness";

export default function MapLibreDeckGlBuildings({ params }: { params: BenchParams }) {
  return <MapLibreDeckGlVariant params={params} pitched interleaved terrain buildings view="city" />;
}
