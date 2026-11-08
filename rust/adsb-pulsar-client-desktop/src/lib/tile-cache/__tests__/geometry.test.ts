import { describe, expect, it } from "vitest";
import {
  estimateTiles,
  lonLatToTile,
  tileBounds,
  tileIntersectsCircle,
  tilesInRadius,
} from "../geometry";

// Montreal, the app's default centre.
const RX = { lat: 45.5, lon: -73.6 };

describe("tileBounds", () => {
  it("covers the whole Web Mercator world at z0", () => {
    const b = tileBounds(0, 0, 0);
    expect(b.west).toBe(-180);
    expect(b.east).toBe(180);
    expect(b.north).toBeCloseTo(85.0511, 3);
    expect(b.south).toBeCloseTo(-85.0511, 3);
  });

  it("splits the world into quadrants at z1, row 0 being the north", () => {
    const nw = tileBounds(1, 0, 0);
    expect(nw.west).toBe(-180);
    expect(nw.east).toBe(0);
    expect(nw.south).toBeCloseTo(0, 9);
    expect(nw.north).toBeCloseTo(85.0511, 3);
  });
});

describe("lonLatToTile", () => {
  it("is the inverse of tileBounds for a point inside the tile", () => {
    const t = lonLatToTile(RX.lat, RX.lon, 10);
    const b = tileBounds(10, t.x, t.y);
    expect(RX.lon).toBeGreaterThanOrEqual(b.west);
    expect(RX.lon).toBeLessThan(b.east);
    expect(RX.lat).toBeLessThanOrEqual(b.north);
    expect(RX.lat).toBeGreaterThan(b.south);
  });
});

describe("tileIntersectsCircle", () => {
  it("includes the tile holding the receiver, at any radius", () => {
    const t = lonLatToTile(RX.lat, RX.lon, 12);
    expect(tileIntersectsCircle(12, t.x, t.y, RX.lat, RX.lon, 0.1)).toBe(true);
  });

  it("includes a tile that is only partly inside the radius", () => {
    // A z6 tile is ~300 NM wide here: the neighbouring tile's near edge is
    // well inside 500 NM even if its centre may not be.
    const t = lonLatToTile(RX.lat, RX.lon, 6);
    expect(tileIntersectsCircle(6, t.x + 1, t.y, RX.lat, RX.lon, 500)).toBe(true);
  });

  it("excludes a tile on the other side of the world", () => {
    const t = lonLatToTile(-33.9, 151.2, 8); // Sydney
    expect(tileIntersectsCircle(8, t.x, t.y, RX.lat, RX.lon, 500)).toBe(false);
  });

  it("measures across the antimeridian, not around the world", () => {
    // Receiver just west of 180°, tile just east of -180°.
    const t = lonLatToTile(0, -179.9, 8);
    expect(tileIntersectsCircle(8, t.x, t.y, 0, 179.9, 50)).toBe(true);
  });
});

describe("tilesInRadius", () => {
  it("yields only tiles that intersect the circle, for every zoom up to max", () => {
    const tiles = [...tilesInRadius(RX.lat, RX.lon, 100, 7)];
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    for (const t of tiles) {
      expect(tileIntersectsCircle(t.z, t.x, t.y, RX.lat, RX.lon, 100)).toBe(true);
    }
  });

  it("misses no intersecting tile at the deepest zoom", () => {
    const z = 8;
    const yielded = new Set(
      [...tilesInRadius(RX.lat, RX.lon, 100, z)].filter((t) => t.z === z).map((t) => `${t.x}/${t.y}`),
    );
    // Brute-force a generous window around the receiver.
    const c = lonLatToTile(RX.lat, RX.lon, z);
    for (let x = c.x - 6; x <= c.x + 6; x++) {
      for (let y = c.y - 6; y <= c.y + 6; y++) {
        expect(yielded.has(`${x}/${y}`)).toBe(tileIntersectsCircle(z, x, y, RX.lat, RX.lon, 100));
      }
    }
  });

  it("wraps x across the antimeridian instead of yielding out-of-range tiles", () => {
    const n = 2 ** 6;
    for (const t of tilesInRadius(0, 179.9, 200, 6)) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(n);
    }
  });
});

describe("estimateTiles", () => {
  it("grows roughly fourfold per extra zoom level once tiles are small", () => {
    const z9 = estimateTiles(RX.lat, RX.lon, 500, 9).count;
    const z10 = estimateTiles(RX.lat, RX.lon, 500, 10).count;
    const z10Only = z10 - z9;
    const z9Only = z9 - estimateTiles(RX.lat, RX.lon, 500, 8).count;
    expect(z10Only / z9Only).toBeGreaterThan(3.5);
    expect(z10Only / z9Only).toBeLessThan(4.5);
  });

  it("puts a 500 NM radius at a few thousand tiles through z10", () => {
    const { count, bytes } = estimateTiles(RX.lat, RX.lon, 500, 10);
    expect(count).toBeGreaterThan(3000);
    expect(count).toBeLessThan(8000);
    expect(bytes).toBeGreaterThan(count * 1000);
  });
});
