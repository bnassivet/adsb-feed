import { describe, it, expect } from "vitest";
import { aircraftIconHtml } from "../aircraft-icon";

describe("aircraftIconHtml", () => {
  describe("unselected (default)", () => {
    it("returns size 24 for unselected icon", () => {
      const result = aircraftIconHtml(0, "#ff0000", false);
      expect(result.iconSize).toEqual([24, 24]);
      expect(result.iconAnchor).toEqual([12, 12]);
    });

    it("applies rotation transform from heading", () => {
      const result = aircraftIconHtml(180, "#ff0000", false);
      expect(result.html).toContain("rotate(180, 12, 12)");
    });

    it("uses the provided color as fill", () => {
      const result = aircraftIconHtml(0, "rgb(0,255,0)", false);
      expect(result.html).toContain('fill="rgb(0,255,0)"');
    });

    it("uses black stroke for unselected", () => {
      const result = aircraftIconHtml(0, "#ff0000", false);
      expect(result.html).toContain('stroke="#000"');
    });

    it("does not include selected-ring div", () => {
      const result = aircraftIconHtml(0, "#ff0000", false);
      expect(result.html).not.toContain("selected-ring");
    });

    it("returns empty className for unselected", () => {
      const result = aircraftIconHtml(0, "#ff0000", false);
      expect(result.className).toBe("");
    });
  });

  describe("selected", () => {
    it("returns size 36 for selected icon", () => {
      const result = aircraftIconHtml(0, "#ff0000", true);
      expect(result.iconSize).toEqual([36, 36]);
      expect(result.iconAnchor).toEqual([18, 18]);
    });

    it("uses white stroke for selected", () => {
      const result = aircraftIconHtml(0, "#ff0000", true);
      expect(result.html).toContain('stroke="#fff"');
    });

    it("includes selected-ring div", () => {
      const result = aircraftIconHtml(0, "#ff0000", true);
      expect(result.html).toContain("selected-ring");
    });

    it("returns selected-marker className", () => {
      const result = aircraftIconHtml(0, "#ff0000", true);
      expect(result.className).toBe("selected-marker");
    });

    it("uses viewBox matching the larger size", () => {
      const result = aircraftIconHtml(0, "#ff0000", true);
      expect(result.html).toContain('viewBox="0 0 36 36"');
    });

    it("centers the polygon in the larger viewport", () => {
      const result = aircraftIconHtml(90, "#ff0000", true);
      // The rotation center should be at the center of 36x36 = (18, 18)
      expect(result.html).toContain("rotate(90, 18, 18)");
    });
  });
});
