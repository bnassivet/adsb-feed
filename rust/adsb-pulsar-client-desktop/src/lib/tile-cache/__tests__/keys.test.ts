import { describe, expect, it } from "vitest";
import { fillTileUrl, tileKey } from "../keys";

describe("tileKey", () => {
  it("is provider/z/x/y", () => {
    expect(tileKey("esri-dark", 10, 301, 367)).toBe("esri-dark/10/301/367");
  });

  it("keeps the retina variant separate", () => {
    expect(tileKey("carto-dark", 5, 1, 2, true)).toBe("carto-dark/5/1/2@2x");
  });
});

describe("fillTileUrl", () => {
  it("fills Esri's row-before-column template", () => {
    const url = fillTileUrl(
      { url: "https://h/tile/{z}/{y}/{x}" },
      { z: 3, x: 5, y: 2 },
      false,
    );
    expect(url).toBe("https://h/tile/3/2/5");
  });

  it("rotates subdomains deterministically and fills {r}", () => {
    const tile = { url: "https://{s}.c/{z}/{x}/{y}{r}.png?key=k", subdomains: "abcd" };
    expect(fillTileUrl(tile, { z: 1, x: 0, y: 1 }, true)).toBe("https://b.c/1/0/1@2x.png?key=k");
    expect(fillTileUrl(tile, { z: 1, x: 1, y: 1 }, false)).toBe("https://c.c/1/1/1.png?key=k");
  });

  it("defaults {s} to Leaflet's abc", () => {
    expect(fillTileUrl({ url: "https://{s}.o/{z}/{x}/{y}.png" }, { z: 0, x: 0, y: 0 }, false)).toBe(
      "https://a.o/0/0/0.png",
    );
  });
});
