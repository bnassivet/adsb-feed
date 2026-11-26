import { describe, expect, it, vi } from "vitest";
import { selectingPath } from "../selectable-path";

describe("selectingPath", () => {
  it("selects the track on click", () => {
    const onSelect = vi.fn();
    selectingPath("3C6444-1", onSelect).eventHandlers.click();
    expect(onSelect).toHaveBeenCalledWith("3C6444-1");
  });

  it("keeps the click from reaching the map, whose handler would deselect", () => {
    // Leaflet paths bubble mouse events to the map by default (markers do not).
    expect(selectingPath("X", vi.fn()).bubblingMouseEvents).toBe(false);
  });
});

describe("selectingPath with a context menu", () => {
  it("opens the track's menu where the right-click happened", () => {
    const onMenu = vi.fn();
    const props = selectingPath("3C6444", vi.fn(), onMenu);
    props.eventHandlers.contextmenu?.({ originalEvent: { clientX: 120, clientY: 340 } });
    expect(onMenu).toHaveBeenCalledWith("3C6444", 120, 340);
  });

  it("has no right-click handler without a menu, so the map's own menu still opens", () => {
    expect(selectingPath("3C6444", vi.fn()).eventHandlers.contextmenu).toBeUndefined();
  });
});
