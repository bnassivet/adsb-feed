import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ancestorCrop, findCachedAncestor, MAX_OVERZOOM } from "../overzoom";
import { TileStore } from "../store";

describe("ancestorCrop", () => {
  it("one level up: the parent's quarter the child covers", () => {
    expect(ancestorCrop({ z: 5, x: 11, y: 6 }, 1)).toEqual({
      ancestor: { z: 4, x: 5, y: 3 },
      fx: 0.5,
      fy: 0,
      fsize: 0.5,
    });
  });

  it("several levels up: a smaller square, offset by the child's position in it", () => {
    // 3 levels: an 8×8 grid of children per ancestor; x=13 -> column 5, y=18 -> row 2.
    expect(ancestorCrop({ z: 10, x: 13, y: 18 }, 3)).toEqual({
      ancestor: { z: 7, x: 1, y: 2 },
      fx: 5 / 8,
      fy: 2 / 8,
      fsize: 1 / 8,
    });
  });
});

describe("findCachedAncestor", () => {
  let store: TileStore;
  let seq = 0;
  beforeEach(async () => {
    store = await TileStore.open(`overzoom-${seq++}`);
  });
  afterEach(() => store.close());

  async function put(z: number, x: number, y: number, retina = false) {
    await store.put({
      key: `esri-dark/${z}/${x}/${y}${retina ? "@2x" : ""}`,
      provider: "esri-dark",
      z,
      x,
      y,
      data: new ArrayBuffer(10 + z),
      type: "image/jpeg",
    });
  }

  it("finds the nearest cached ancestor", async () => {
    await put(8, 1, 2);
    await put(9, 3, 4);
    const found = await findCachedAncestor(store, "esri-dark", { z: 11, x: 13, y: 18 }, false);
    expect(found?.crop.ancestor).toEqual({ z: 9, x: 3, y: 4 });
    expect(found?.blob.size).toBe(19);
  });

  it("looks only for the same pixel density", async () => {
    await put(9, 3, 4, true);
    expect(await findCachedAncestor(store, "esri-dark", { z: 11, x: 13, y: 18 }, false)).toBeNull();
    expect(await findCachedAncestor(store, "esri-dark", { z: 11, x: 13, y: 18 }, true)).not.toBeNull();
  });

  it(`gives up after ${MAX_OVERZOOM} levels: past that it is a blur, not a map`, async () => {
    await put(0, 0, 0);
    expect(await findCachedAncestor(store, "esri-dark", { z: MAX_OVERZOOM + 1, x: 0, y: 0 }, false)).toBeNull();
    expect(await findCachedAncestor(store, "esri-dark", { z: MAX_OVERZOOM, x: 0, y: 0 }, false)).not.toBeNull();
  });
});
