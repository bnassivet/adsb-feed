/**
 * Is this response a tile worth keeping?
 *
 * Offline there is no second chance: a bad tile stored once is what the map
 * shows until the cache is cleared. Two kinds of bad tile get past `res.ok`:
 *
 * - a non-image body served with 200 (a captive portal, a proxy error page);
 * - a provider's placeholder image. CARTO answers a missing *or invalid* key
 *   with one fixed "API KEY REQUIRED" PNG, 200 OK, `immutable` for 30 days.
 *   Its ETag (`wm-…`) would identify it, but ETag is not a CORS-safelisted
 *   header and CARTO does not expose it, so the page cannot read it. The bytes
 *   are identical for every tile, so a size + SHA-256 fingerprint works, and
 *   the size check means real tiles are never hashed.
 */

export interface Placeholder {
  name: string;
  bytes: number;
  sha256: string;
}

export const KNOWN_PLACEHOLDERS: readonly Placeholder[] = [
  {
    name: "carto-api-key-required",
    bytes: 2513,
    sha256: "cc3f31364a735d9a8179af36b3db7617cdff8bdb0248654ebcc3df91607abedc",
  },
];

export type TileCheck = "ok" | "not-image" | "placeholder";

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function checkTile(
  contentType: string | null,
  data: ArrayBuffer,
  placeholders: readonly Placeholder[] = KNOWN_PLACEHOLDERS,
): Promise<TileCheck> {
  if (!contentType?.toLowerCase().startsWith("image/") || data.byteLength === 0) return "not-image";
  const sameSize = placeholders.filter((p) => p.bytes === data.byteLength);
  if (sameSize.length > 0) {
    const hash = await sha256Hex(data);
    if (sameSize.some((p) => p.sha256 === hash)) return "placeholder";
  }
  return "ok";
}
