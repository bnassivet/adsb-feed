import { describe, it, expect } from "vitest";
import { seamarkCellsKey, cellsBounds, describeSeamark, lightText, nearestSeamark, type Seamark } from "../seamark";

describe("cellsBounds", () => {
  it("gives a box inside the key's cells that Rust maps back to the same cells", () => {
    const b = cellsBounds("N46W006,N46W004,N48W006,N48W004")!;
    expect(seamarkCellsKey(b, 10)).toBe("N46W006,N46W004,N48W006,N48W004");
    expect(b.south).toBeGreaterThan(46);
    expect(b.east).toBeLessThan(-2);
    expect(seamarkCellsKey(cellsBounds("S02E008")!, 10)).toBe("S02E008");
    expect(cellsBounds("nonsense")).toBeNull();
  });
});

describe("seamarkCellsKey", () => {
  it("names the 2° cells under the view, like Rust's cells_for", () => {
    expect(seamarkCellsKey({ south: 47.2, west: -5.1, north: 48.9, east: -3.0 }, 10)).toBe("N46W006,N46W004,N48W006,N48W004");
    expect(seamarkCellsKey({ south: 47.0, west: -1.0, north: 47.5, east: -0.5 }, 12)).toBe("N46W002");
    expect(seamarkCellsKey({ south: -1, west: 9, north: -0.5, east: 9.5 }, 12)).toBe("S02E008");
  });

  it("is null below zoom 9, where seamarks are not drawn, and for a view too wide", () => {
    expect(seamarkCellsKey({ south: 47, west: -1, north: 47.5, east: -0.5 }, 8)).toBeNull();
    expect(seamarkCellsKey({ south: 40, west: -10, north: 50, east: 0 }, 9)).toBeNull();
  });
});

const buoy = {
  "seamark:type": "buoy_lateral",
  "seamark:name": "MB1",
  "seamark:buoy_lateral:category": "starboard",
  "seamark:buoy_lateral:colour": "green",
  "seamark:buoy_lateral:shape": "conical",
  "seamark:light:character": "Fl",
  "seamark:light:group": "3",
  "seamark:light:colour": "green",
  "seamark:light:period": "12",
  "seamark:light:range": "5",
  "seamark:topmark:shape": "cone, point up",
  "seamark:topmark:colour": "green",
};

describe("describeSeamark", () => {
  it("titles by name and describes kind, category, colour and shape", () => {
    expect(describeSeamark(buoy)).toEqual({
      title: "MB1",
      lines: ["Lateral buoy · starboard · green, conical", "Light Fl(3) G 12s 5M", "Topmark cone, point up, green"],
    });
  });

  it("titles by kind when there is no name, and humanizes unknown types", () => {
    expect(describeSeamark({ "seamark:type": "harbour", name: "Port du Moulin" }).title).toBe("Port du Moulin");
    expect(describeSeamark({ "seamark:type": "wreck" })).toEqual({ title: "Wreck", lines: [] });
    expect(describeSeamark({ "seamark:type": "some_new_thing" }).title).toBe("Some new thing");
  });

  it("joins multi-colour values and keeps a note short", () => {
    const d = describeSeamark({
      "seamark:type": "buoy_cardinal",
      "seamark:buoy_cardinal:category": "north",
      "seamark:buoy_cardinal:colour": "black;yellow",
      "seamark:information": "x".repeat(200),
    });
    expect(d.lines[0]).toBe("Cardinal buoy · north · black and yellow");
    expect(d.lines[1].length).toBeLessThanOrEqual(121);
    expect(d.lines[1].endsWith("…")).toBe(true);
  });
});

describe("lightText", () => {
  it("writes the chart abbreviation", () => {
    expect(lightText(buoy)).toBe("Fl(3) G 12s 5M");
    expect(lightText({ "seamark:light:character": "Iso", "seamark:light:colour": "white", "seamark:light:period": "4" })).toBe("Iso W 4s");
    expect(lightText({ "seamark:light:character": "Oc", "seamark:light:colour": "white;red;green" })).toBe("Oc WRG");
  });

  it("reads sector lights, saying how many", () => {
    expect(lightText({
      "seamark:light:1:character": "Fl", "seamark:light:1:colour": "white", "seamark:light:1:period": "5",
      "seamark:light:2:character": "Fl", "seamark:light:2:colour": "red", "seamark:light:2:period": "5",
    })).toBe("Fl W 5s (+1 sector)");
  });

  it("is null without a light", () => {
    expect(lightText({ "seamark:type": "rock" })).toBeNull();
  });
});

describe("nearestSeamark", () => {
  const items: Seamark[] = [
    { id: "n1", lat: 0, lon: 0, tags: {} },
    { id: "n2", lat: 0, lon: 10, tags: {} },
  ];
  const project = (s: Seamark) => ({ x: s.lon, y: s.lat });

  it("picks the closest within reach", () => {
    expect(nearestSeamark(items, { x: 8, y: 1 }, project, 5)?.id).toBe("n2");
    expect(nearestSeamark(items, { x: 5, y: 9 }, project, 5)).toBeNull();
  });
});
