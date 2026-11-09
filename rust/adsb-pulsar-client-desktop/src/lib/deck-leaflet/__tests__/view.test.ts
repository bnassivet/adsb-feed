import { describe, it, expect } from "vitest";
import { leafletToDeckViewState, zoomAnimOffset } from "../view";

describe("leafletToDeckViewState", () => {
  it("maps centre to longitude/latitude and is flat (no pitch/bearing)", () => {
    expect(leafletToDeckViewState({ lat: 45.5, lng: -73.6 }, 8)).toEqual({
      longitude: -73.6, latitude: 45.5, zoom: 7, pitch: 0, bearing: 0,
    });
  });

  it("is one zoom level lower than Leaflet (deck.gl counts 512 px tiles, Leaflet 256 px)", () => {
    expect(leafletToDeckViewState({ lat: 0, lng: 0 }, 0).zoom).toBe(-1);
    expect(leafletToDeckViewState({ lat: 0, lng: 0 }, 12.5).zoom).toBe(11.5);
  });
});

describe("zoomAnimOffset", () => {
  const viewHalf = { x: 400, y: 300 };

  it("is the current position when nothing changes", () => {
    expect(zoomAnimOffset({ scale: 1, position: { x: -20, y: 10 }, viewHalf, centerOffset: { x: 0, y: 0 } }))
      .toEqual({ x: -20, y: 10 });
  });

  it("zooming in x2 about the centre pulls the top-left out by half a viewport", () => {
    expect(zoomAnimOffset({ scale: 2, position: { x: 0, y: 0 }, viewHalf, centerOffset: { x: 0, y: 0 } }))
      .toEqual({ x: -400, y: -300 });
  });

  it("zooming out x0.5 pushes it in by a quarter viewport", () => {
    expect(zoomAnimOffset({ scale: 0.5, position: { x: 0, y: 0 }, viewHalf, centerOffset: { x: 0, y: 0 } }))
      .toEqual({ x: 200, y: 150 });
  });

  it("a moving centre (double-click zoom on a point) shifts the canvas the opposite way", () => {
    expect(zoomAnimOffset({ scale: 1, position: { x: 0, y: 0 }, viewHalf, centerOffset: { x: 30, y: -40 } }))
      .toEqual({ x: -30, y: 40 });
  });
});
