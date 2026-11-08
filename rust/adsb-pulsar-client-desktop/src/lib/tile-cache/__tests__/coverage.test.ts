import { describe, expect, it } from "vitest";
import { formatCoverage } from "../coverage";

const c = (z: number, cached: number, total: number) => ({ z, cached, total });

describe("formatCoverage", () => {
  it("groups the complete zooms, then gives a percentage for the rest", () => {
    expect(formatCoverage([c(0, 1, 1), c(1, 2, 2), c(2, 3, 6), c(3, 0, 20)])).toBe("z0–1 complete · z2 50% · z3 0%");
  });

  it("names a single complete zoom on its own", () => {
    expect(formatCoverage([c(0, 1, 1), c(1, 0, 4)])).toBe("z0 complete · z1 0%");
  });

  it("never rounds up to 100%: one missing tile is not complete", () => {
    expect(formatCoverage([c(0, 999, 1000)])).toBe("z0 99%");
  });

  it("treats a zoom with nothing to fetch as complete", () => {
    expect(formatCoverage([c(0, 0, 0)])).toBe("z0 complete");
  });

  it("groups complete zooms after a partial one too", () => {
    expect(formatCoverage([c(0, 0, 1), c(1, 2, 2), c(2, 3, 3)])).toBe("z0 0% · z1–2 complete");
  });
});
