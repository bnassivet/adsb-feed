import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetectionRadar } from "../DetectionRadar";
import type { DetectionRangeSector } from "@/lib/types";

function makeSectors(overrides: Partial<DetectionRangeSector>[] = []): DetectionRangeSector[] {
  const sectors: DetectionRangeSector[] = Array.from({ length: 36 }, (_, i) => ({
    bearing_deg: i * 10,
    max_distance_nm: 0,
    position_count: 0,
    min_altitude: null,
    max_altitude: null,
    flight_count: 0,
  }));
  for (const o of overrides) {
    const idx = (o.bearing_deg ?? 0) / 10;
    sectors[idx] = { ...sectors[idx], ...o };
  }
  return sectors;
}

const nonZeroSectors = makeSectors([
  { bearing_deg: 0, max_distance_nm: 100, position_count: 10, min_altitude: 5000, max_altitude: 40000 },
  { bearing_deg: 90, max_distance_nm: 50, position_count: 5, min_altitude: 10000, max_altitude: 35000 },
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

  describe("sector tooltips (polar mode)", () => {
    it("shows tooltip on wedge hover with bearing, distance, and count", async () => {
      const user = userEvent.setup();
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);

      const wedges = screen.getAllByTestId("radar-wedge");
      await user.hover(wedges[0]); // 0° sector: 100 NM, 10 positions

      const tooltip = screen.getByTestId("sector-tooltip");
      expect(tooltip).toBeTruthy();
      expect(tooltip.textContent).toContain("0°");
      expect(tooltip.textContent).toContain("100");
      expect(tooltip.textContent).toContain("10");
    });

    it("hides tooltip when mouse leaves wedge", async () => {
      const user = userEvent.setup();
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);

      const wedges = screen.getAllByTestId("radar-wedge");
      await user.hover(wedges[0]);
      expect(screen.getByTestId("sector-tooltip")).toBeTruthy();

      await user.unhover(wedges[0]);
      expect(screen.queryByTestId("sector-tooltip")).toBeNull();
    });

    it("updates tooltip content when hovering a different wedge", async () => {
      const user = userEvent.setup();
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);

      const wedges = screen.getAllByTestId("radar-wedge");
      await user.hover(wedges[1]); // 90° sector: 50 NM, 5 positions

      const tooltip = screen.getByTestId("sector-tooltip");
      expect(tooltip.textContent).toContain("90°");
      expect(tooltip.textContent).toContain("50");
      expect(tooltip.textContent).toContain("5");
    });

    it("shows min/max altitude in tooltip when available", async () => {
      const user = userEvent.setup();
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);

      const wedges = screen.getAllByTestId("radar-wedge");
      await user.hover(wedges[0]); // 0° sector: min 5000, max 40000

      const tooltip = screen.getByTestId("sector-tooltip");
      expect(tooltip.textContent).toContain("5,000");
      expect(tooltip.textContent).toContain("40,000");
      expect(tooltip.textContent).toContain("ft");
    });

    it("hides altitude line in tooltip when altitude is null", async () => {
      const user = userEvent.setup();
      const sectors = makeSectors([
        { bearing_deg: 0, max_distance_nm: 100, position_count: 10, min_altitude: null, max_altitude: null },
      ]);
      render(<DetectionRadar sectors={sectors} mode="polar" />);

      const wedges = screen.getAllByTestId("radar-wedge");
      await user.hover(wedges[0]);

      const tooltip = screen.getByTestId("sector-tooltip");
      expect(tooltip.textContent).not.toContain("Alt:");
      expect(tooltip.textContent).not.toContain("ft");
    });

  });

  describe("sector tooltips (polygon mode)", () => {
    it("renders invisible hit zones over the polygon", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polygon" />);
      const hitZones = screen.getAllByTestId("sector-hit-zone");
      expect(hitZones).toHaveLength(2); // only non-zero sectors
    });

    it("shows tooltip on hit zone hover with bearing, distance, and count", async () => {
      const user = userEvent.setup();
      render(<DetectionRadar sectors={nonZeroSectors} mode="polygon" />);

      const hitZones = screen.getAllByTestId("sector-hit-zone");
      await user.hover(hitZones[0]); // 0° sector: 100 NM, 10 positions

      const tooltip = screen.getByTestId("sector-tooltip");
      expect(tooltip).toBeTruthy();
      expect(tooltip.textContent).toContain("0°");
      expect(tooltip.textContent).toContain("100");
      expect(tooltip.textContent).toContain("10");
    });

    it("hides tooltip when mouse leaves hit zone", async () => {
      const user = userEvent.setup();
      render(<DetectionRadar sectors={nonZeroSectors} mode="polygon" />);

      const hitZones = screen.getAllByTestId("sector-hit-zone");
      await user.hover(hitZones[0]);
      expect(screen.getByTestId("sector-tooltip")).toBeTruthy();

      await user.unhover(hitZones[0]);
      expect(screen.queryByTestId("sector-tooltip")).toBeNull();
    });

    it("does not render hit zones in polar mode", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);
      expect(screen.queryAllByTestId("sector-hit-zone")).toHaveLength(0);
    });
  });

  describe("ring scale", () => {
    it("labels rings at round multiples of the step", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" ringStep={25} />);
      const labels = screen.getAllByTestId("ring-label").map((l) => l.textContent);
      expect(labels).toEqual(["25 NM", "50 NM", "75 NM", "100 NM"]);
    });

    it("defaults to 25 NM rings", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" />);
      expect(screen.getAllByTestId("ring-label")[0].textContent).toBe("25 NM");
    });

    it("raises the step rather than drawing more than 5 rings", () => {
      const far = makeSectors([{ bearing_deg: 0, max_distance_nm: 180, position_count: 1 }]);
      render(<DetectionRadar sectors={far} mode="polar" ringStep={25} />);
      const labels = screen.getAllByTestId("ring-label").map((l) => l.textContent);
      expect(labels).toEqual(["50 NM", "100 NM", "150 NM", "200 NM"]);
    });

    it("states the step under the chart", () => {
      render(<DetectionRadar sectors={nonZeroSectors} mode="polar" ringStep={25} />);
      expect(screen.getByText(/25 NM\/ring/)).toBeTruthy();
    });
  });

  describe("density overlay", () => {
    // Max 40 NM → 25 NM rings: 2 rings, 50 NM scale.
    // Sector 0 bins: 0-5: 2, 10-15: 3, 30-35: 10. Sector 90: 5-10: 5.
    const banded = makeSectors([
      { bearing_deg: 0, max_distance_nm: 40, position_count: 15, band_counts: [2, 0, 3, 0, 0, 0, 10] },
      { bearing_deg: 90, max_distance_nm: 10, position_count: 5, band_counts: [0, 5] },
    ]);

    it("polar mode colors each sector × ring band", () => {
      render(<DetectionRadar sectors={banded} mode="polar" ringStep={25} showDensity />);
      // sector 0: [0-25: 5, 25-50: 10]; sector 90: [0-25: 5]
      expect(screen.getAllByTestId("density-cell")).toHaveLength(3);
    });

    it("polygon mode colors each sector × 10 NM cell", () => {
      render(<DetectionRadar sectors={banded} mode="polygon" ringStep={25} showDensity />);
      // sector 0: [0-10: 2, 10-20: 3, 30-40: 10]; sector 90: [0-10: 5]
      expect(screen.getAllByTestId("density-cell")).toHaveLength(4);
    });

    it("polar wedges fade to a light veil over the density", () => {
      render(<DetectionRadar sectors={banded} mode="polar" ringStep={25} showDensity />);
      expect(screen.getAllByTestId("radar-wedge")[0].getAttribute("fill-opacity")).toBe("0.06");
    });

    it("polygon fades to a light veil over the density", () => {
      render(<DetectionRadar sectors={banded} mode="polygon" ringStep={25} showDensity />);
      expect(screen.getByTestId("radar-polygon").getAttribute("fill-opacity")).toBe("0.05");
    });

    it("polar mode keeps filled wedges when density is off", () => {
      render(<DetectionRadar sectors={banded} mode="polar" ringStep={25} />);
      expect(screen.getAllByTestId("radar-wedge")[0].getAttribute("fill-opacity")).toBe("0.35");
    });

    it("clips polygon-mode density to the range polygon", () => {
      const { container } = render(
        <DetectionRadar sectors={banded} mode="polygon" ringStep={25} showDensity />,
      );
      const group = screen.getAllByTestId("density-cell")[0].parentElement!;
      const id = group.getAttribute("clip-path")!.match(/^url\(#(.+)\)$/)![1];
      const clip = container.querySelector(`clipPath[id="${id}"]`)!;
      expect(clip.querySelector("path")!.getAttribute("d")).toBe(
        screen.getByTestId("radar-polygon").getAttribute("d"),
      );
    });

    it("clips polar-mode density to the sector wedges", () => {
      const { container } = render(
        <DetectionRadar sectors={banded} mode="polar" ringStep={25} showDensity />,
      );
      const group = screen.getAllByTestId("density-cell")[0].parentElement!;
      const id = group.getAttribute("clip-path")!.match(/^url\(#(.+)\)$/)![1];
      const clip = container.querySelector(`clipPath[id="${id}"]`)!;
      const clipPaths = [...clip.querySelectorAll("path")].map((p) => p.getAttribute("d"));
      const wedges = screen.getAllByTestId("radar-wedge").map((w) => w.getAttribute("d"));
      expect(clipPaths).toEqual(wedges);
    });

    it("draws no density cells when the option is off", () => {
      render(<DetectionRadar sectors={banded} mode="polar" ringStep={25} />);
      expect(screen.queryAllByTestId("density-cell")).toHaveLength(0);
    });

    it("lists positions per ring band in the tooltip", async () => {
      const user = userEvent.setup();
      render(<DetectionRadar sectors={banded} mode="polar" ringStep={25} showDensity />);
      await user.hover(screen.getAllByTestId("radar-wedge")[0]);
      const lines = screen.getAllByTestId("tooltip-band").map((l) => l.textContent);
      expect(lines).toEqual(["0–25 NM: 5", "25–50 NM: 10"]);
    });

    it("keeps the tooltip free of bands when the option is off", async () => {
      const user = userEvent.setup();
      render(<DetectionRadar sectors={banded} mode="polar" ringStep={25} />);
      await user.hover(screen.getAllByTestId("radar-wedge")[0]);
      expect(screen.queryAllByTestId("tooltip-band")).toHaveLength(0);
    });
  });
});
