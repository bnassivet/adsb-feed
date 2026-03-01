import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DetectionRadar } from "../DetectionRadar";
import type { DetectionRangeSector } from "@/lib/types";

function makeSectors(overrides: Partial<DetectionRangeSector>[] = []): DetectionRangeSector[] {
  const sectors: DetectionRangeSector[] = Array.from({ length: 36 }, (_, i) => ({
    bearing_deg: i * 10,
    max_distance_nm: 0,
    position_count: 0,
  }));
  for (const o of overrides) {
    const idx = (o.bearing_deg ?? 0) / 10;
    sectors[idx] = { ...sectors[idx], ...o };
  }
  return sectors;
}

const nonZeroSectors = makeSectors([
  { bearing_deg: 0, max_distance_nm: 100, position_count: 10 },
  { bearing_deg: 90, max_distance_nm: 50, position_count: 5 },
]);

describe("DetectionRadar", () => {
  it("renders SVG element", () => {
    render(<DetectionRadar sectors={makeSectors()} mode="polar" />);
    expect(screen.getByTestId("detection-radar")).toBeTruthy();
    expect(screen.getByRole("img")).toBeTruthy();
  });

  it("renders cardinal labels (N, E, S, W)", () => {
    render(<DetectionRadar sectors={makeSectors()} mode="polar" />);
    const labels = screen.getAllByTestId("cardinal-label");
    expect(labels).toHaveLength(4);
    const texts = labels.map((l) => l.textContent);
    expect(texts).toEqual(["N", "E", "S", "W"]);
  });

  it("renders distance ring labels", () => {
    render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);
    const rings = screen.getAllByTestId("ring-label");
    expect(rings.length).toBeGreaterThan(0);
  });

  it("shows max range text", () => {
    const sectors = makeSectors([{ bearing_deg: 0, max_distance_nm: 150, position_count: 5 }]);
    render(<DetectionRadar sectors={sectors} mode="polar" />);
    expect(screen.getByText(/Max range: 150 NM/)).toBeTruthy();
  });

  describe("polar mode", () => {
    it("renders wedges for non-zero sectors", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);
      const wedges = screen.getAllByTestId("radar-wedge");
      expect(wedges).toHaveLength(2);
    });

    it("renders no wedges when all sectors are zero", () => {
      render(<DetectionRadar sectors={makeSectors()} mode="polar" />);
      expect(screen.queryAllByTestId("radar-wedge")).toHaveLength(0);
    });

    it("does not render a polygon path", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);
      expect(screen.queryByTestId("radar-polygon")).toBeNull();
    });
  });

  describe("polygon mode", () => {
    it("renders a single polygon path", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polygon" />);
      expect(screen.getByTestId("radar-polygon")).toBeTruthy();
    });

    it("does not render wedges", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polygon" />);
      expect(screen.queryAllByTestId("radar-wedge")).toHaveLength(0);
    });

    it("renders polygon even when all sectors are zero (points at center)", () => {
      render(<DetectionRadar sectors={makeSectors()} mode="polygon" />);
      expect(screen.getByTestId("radar-polygon")).toBeTruthy();
    });
  });
});
