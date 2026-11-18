"use client";
/** Pitched with altitude, deck.gl interleaved: the depth-sharing cost alone, vs maplibre-deckgl-3d. */
import { MapLibreDeckGlVariant } from "./MapLibreDeckGl";
import type { BenchParams } from "../harness";

export default function MapLibreDeckGl3dIl({ params }: { params: BenchParams }) {
  return <MapLibreDeckGlVariant params={params} pitched interleaved />;
}
