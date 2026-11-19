"use client";
/** Interleaved + terrain over downtown Montréal at zoom 15: the reference for maplibre-deckgl-buildings. */
import { MapLibreDeckGlVariant } from "./MapLibreDeckGl";
import type { BenchParams } from "../harness";

export default function MapLibreDeckGlCity({ params }: { params: BenchParams }) {
  return <MapLibreDeckGlVariant params={params} pitched interleaved terrain view="city" />;
}
