import { describe, expect, it } from "vitest";
import { checkTile, KNOWN_PLACEHOLDERS, sha256Hex } from "../validate";

function buf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe("checkTile", () => {
  it("accepts an image", async () => {
    expect(await checkTile("image/png", buf([1, 2, 3]))).toBe("ok");
    expect(await checkTile("image/jpeg; charset=binary", buf([1]))).toBe("ok");
  });

  it("rejects anything that is not an image (an HTML error page served as 200)", async () => {
    expect(await checkTile("text/html", buf([60, 104]))).toBe("not-image");
    expect(await checkTile(null, buf([1]))).toBe("not-image");
  });

  it("rejects an empty body", async () => {
    expect(await checkTile("image/png", buf([]))).toBe("not-image");
  });

  it("recognises a known placeholder by size and SHA-256", async () => {
    const data = buf([9, 8, 7, 6]);
    const placeholder = { name: "test", bytes: 4, sha256: await sha256Hex(data) };
    expect(await checkTile("image/png", data, [placeholder])).toBe("placeholder");
    // Same size, different bytes: a real tile.
    expect(await checkTile("image/png", buf([9, 8, 7, 5]), [placeholder])).toBe("ok");
  });

  it("knows CARTO's API-key-required tile (same image for a missing or invalid key)", () => {
    expect(KNOWN_PLACEHOLDERS).toContainEqual({
      name: "carto-api-key-required",
      bytes: 2513,
      sha256: "cc3f31364a735d9a8179af36b3db7617cdff8bdb0248654ebcc3df91607abedc",
    });
  });
});
