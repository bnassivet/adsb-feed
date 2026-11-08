import { describe, expect, it } from "vitest";
import { tileConfig } from "../basemap";

describe("tileConfig", () => {
  it("serves OpenStreetMap for the light theme, key or not", () => {
    const keyless = tileConfig("light");
    expect(keyless.url).toBe("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(tileConfig("light", "abc")).toEqual(keyless);
  });

  it("serves CARTO Dark Matter with the key when one is configured", () => {
    const tile = tileConfig("dark", "abc123");
    expect(tile.url).toBe("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=abc123");
    expect(tile.subdomains).toBe("abcd");
    expect(tile.attribution).toContain("CARTO");
  });

  it("URL-encodes the key", () => {
    expect(tileConfig("dark", "a b&c").url).toContain("?key=a%20b%26c");
  });

  it.each([undefined, "", "   "])("falls back to keyless Esri when the key is %j", (key) => {
    // Since 2026-09-25 CARTO answers keyless raster requests with an
    // "API KEY REQUIRED" tile, so without a key the dark theme must not
    // touch cartocdn at all.
    const tile = tileConfig("dark", key);
    expect(tile.url).not.toContain("cartocdn");
    expect(tile.url).toContain("server.arcgisonline.com");
    expect(tile.attribution).toContain("Esri");
  });

  it("uses Esri's row-before-column tile order", () => {
    // ArcGIS REST tiles are /tile/{z}/{y}/{x}; copying CARTO's {x}/{y}
    // produces a scrambled map, not an error.
    expect(tileConfig("dark").url).toMatch(/\/tile\/\{z\}\/\{y\}\/\{x\}$/);
  });

  it("names each provider, which the tile cache keys by", () => {
    expect(tileConfig("light").provider).toBe("osm");
    expect(tileConfig("dark").provider).toBe("esri-dark");
    expect(tileConfig("dark", "k").provider).toBe("carto-dark");
  });

  it("returns the same object for keyless themes, so a memoised layer is not rebuilt", () => {
    expect(tileConfig("dark")).toBe(tileConfig("dark"));
    expect(tileConfig("light")).toBe(tileConfig("light"));
  });

  it("caps zoom at what each provider actually serves", () => {
    expect(tileConfig("dark").maxZoom).toBe(16);
    expect(tileConfig("dark", "k").maxZoom).toBe(20);
  });
});
