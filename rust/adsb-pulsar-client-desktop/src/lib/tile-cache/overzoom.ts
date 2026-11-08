import type { TileCoord } from "./geometry";
import { tileKey, type TileProvider } from "./keys";
import type { TileStore } from "./store";

/**
 * Offline, zooming past the downloaded levels would show blank tiles. Instead
 * a missing tile is cut from its nearest cached ancestor and scaled up:
 * blurry, but the coastline is still where it is.
 */

/** How many levels up to look. 5 levels is a 32× enlargement; beyond that it is a blur. */
export const MAX_OVERZOOM = 5;

/** The part of an ancestor `dz` levels up that covers `coord`, as fractions of the ancestor's side. */
export interface AncestorCrop {
  ancestor: TileCoord;
  fx: number;
  fy: number;
  fsize: number;
}

export function ancestorCrop(coord: TileCoord, dz: number): AncestorCrop {
  const n = 2 ** dz;
  return {
    ancestor: { z: coord.z - dz, x: Math.floor(coord.x / n), y: Math.floor(coord.y / n) },
    fx: (coord.x % n) / n,
    fy: (coord.y % n) / n,
    fsize: 1 / n,
  };
}

export async function findCachedAncestor(
  store: Pick<TileStore, "get">,
  provider: TileProvider,
  coord: TileCoord,
  retina: boolean,
): Promise<{ blob: Blob; crop: AncestorCrop } | null> {
  for (let dz = 1; dz <= Math.min(MAX_OVERZOOM, coord.z); dz++) {
    const crop = ancestorCrop(coord, dz);
    const { z, x, y } = crop.ancestor;
    const hit = await store.get(tileKey(provider, z, x, y, retina));
    if (hit) return { blob: hit.blob, crop };
  }
  return null;
}

/**
 * Cut the crop out of the ancestor image and scale it to a full tile. Browser
 * only (canvas); the layer injects a stand-in in tests.
 */
export async function renderCrop(blob: Blob, crop: AncestorCrop, size: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("no 2d context");
    const sw = bitmap.width * crop.fsize;
    const sh = bitmap.height * crop.fsize;
    g.drawImage(bitmap, bitmap.width * crop.fx, bitmap.height * crop.fy, sw, sh, 0, 0, size, size);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );
  } finally {
    bitmap.close();
  }
}
