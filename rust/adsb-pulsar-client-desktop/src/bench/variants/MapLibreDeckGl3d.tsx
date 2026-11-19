"use client";
/** MapLibre + deck.gl, pitched 60° with every position at its true altitude. */
import { MapLibreDeckGlVariant } from "./MapLibreDeckGl";
import type { BenchParams } from "../harness";

export default function MapLibreDeckGl3d({ params }: { params: BenchParams }) {
  return <MapLibreDeckGlVariant params={params} pitched />;
}
