import { describe, it, expect } from "vitest";
import { zoomToH3Resolution } from "../types";

describe("zoomToH3Resolution", () => {
  it("zoom 3 returns resolution 3", () => {
    expect(zoomToH3Resolution(3)).toBe(3);
  });

  it("zoom 5 returns resolution 3 (boundary)", () => {
    expect(zoomToH3Resolution(5)).toBe(3);
  });

  it("zoom 6 returns resolution 4", () => {
    expect(zoomToH3Resolution(6)).toBe(4);
  });

  it("zoom 7 returns resolution 5", () => {
    expect(zoomToH3Resolution(7)).toBe(5);
  });

  it("zoom 9 returns resolution 6", () => {
    expect(zoomToH3Resolution(9)).toBe(6);
  });

  it("zoom 11 returns resolution 7", () => {
    expect(zoomToH3Resolution(11)).toBe(7);
  });

  it("zoom 14 returns resolution 7 (default)", () => {
    expect(zoomToH3Resolution(14)).toBe(7);
  });
});
