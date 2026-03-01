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

describe("DetectionRadar", () => {
  it("renders SVG element", () => {
    render(<DetectionRadar sectors={makeSectors()} />);
    expect(screen.getByTestId("detection-radar")).toBeTruthy();
    expect(screen.getByRole("img")).toBeTruthy();
  });

  it("renders radar polygon", () => {
    const sectors = makeSectors([{ bearing_deg: 0, max_distance_nm: 100, position_count: 10 }]);
    render(<DetectionRadar sectors={sectors} />);
    expect(screen.getByTestId("radar-polygon")).toBeTruthy();
  });

  it("renders cardinal labels (N, E, S, W)", () => {
    render(<DetectionRadar sectors={makeSectors()} />);
    const labels = screen.getAllByTestId("cardinal-label");
    expect(labels).toHaveLength(4);
    const texts = labels.map((l) => l.textContent);
    expect(texts).toEqual(["N", "E", "S", "W"]);
  });

  it("renders distance ring labels", () => {
    const sectors = makeSectors([{ bearing_deg: 0, max_distance_nm: 100, position_count: 5 }]);
    render(<DetectionRadar sectors={sectors} />);
    const rings = screen.getAllByTestId("ring-label");
    expect(rings.length).toBeGreaterThan(0);
  });

  it("shows max range text", () => {
    const sectors = makeSectors([{ bearing_deg: 0, max_distance_nm: 150, position_count: 5 }]);
    render(<DetectionRadar sectors={sectors} />);
    expect(screen.getByText(/Max range: 150 NM/)).toBeTruthy();
  });

  it("handles all-zero sectors gracefully", () => {
    render(<DetectionRadar sectors={makeSectors()} />);
    // Should still render without errors — polygon at center
    expect(screen.getByTestId("radar-polygon")).toBeTruthy();
    expect(screen.getByText(/Max range: 1 NM/)).toBeTruthy();
  });
});
