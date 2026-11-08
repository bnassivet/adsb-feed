import { describe, it, expect } from "vitest";
import { isBareMapTarget } from "../map-hover-target";

function mapDom() {
  document.body.innerHTML = `
    <div id="map" class="leaflet-container">
      <div class="leaflet-pane leaflet-map-pane">
        <div class="leaflet-pane leaflet-tile-pane"><img id="tile"></div>
        <div class="leaflet-pane leaflet-overlay-pane"><canvas id="vectors"></canvas></div>
        <div class="leaflet-pane leaflet-deckDots-pane"><canvas id="deck"></canvas></div>
        <div class="leaflet-pane leaflet-marker-pane"><div class="leaflet-marker-icon"><svg id="icon"><path id="iconPath"/></svg></div></div>
        <div class="leaflet-pane leaflet-tooltip-pane"><div id="tip" class="leaflet-tooltip"><b id="tipText">x</b></div></div>
        <div class="leaflet-pane leaflet-popup-pane"><div id="popup"></div></div>
      </div>
      <div class="leaflet-control-container"><a id="zoomIn"></a></div>
    </div>`;
  return document.getElementById("map")!;
}

describe("isBareMapTarget", () => {
  it("accepts the map surface: container, tiles, vector canvas, the deck canvas", () => {
    const map = mapDom();
    for (const id of ["tile", "vectors", "deck"]) expect(isBareMapTarget(document.getElementById(id), map)).toBe(true);
    expect(isBareMapTarget(map, map)).toBe(true);
  });

  it("rejects anything with its own hover: aircraft icons, tooltips, popups, controls", () => {
    const map = mapDom();
    for (const id of ["icon", "iconPath", "tip", "tipText", "popup", "zoomIn"]) {
      expect(isBareMapTarget(document.getElementById(id), map)).toBe(false);
    }
  });

  it("rejects targets outside the map and non-elements", () => {
    const map = mapDom();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    expect(isBareMapTarget(outside, map)).toBe(false);
    expect(isBareMapTarget(null, map)).toBe(false);
  });
});
