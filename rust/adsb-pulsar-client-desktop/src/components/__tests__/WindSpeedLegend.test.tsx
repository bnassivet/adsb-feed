import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WindSpeedLegend } from "../WindSpeedLegend";
import { PARTICLE_COLORS } from "@/lib/wind-particles";

describe("WindSpeedLegend", () => {
  it("lists every speed range, fastest at the top", () => {
    render(<WindSpeedLegend theme="dark" />);

    const labels = screen.getAllByTestId("wind-speed-label").map((el) => el.textContent);
    expect(labels).toEqual(["≥100", "80–100", "60–80", "40–60", "20–40", "<20"]);
  });

  it("names the unit", () => {
    render(<WindSpeedLegend theme="dark" />);

    expect(screen.getByText("kt")).toBeInTheDocument();
  });

  it("uses the particle layer's colours for the theme", () => {
    const { unmount } = render(<WindSpeedLegend theme="dark" />);
    let swatches = screen.getAllByTestId("wind-speed-swatch");
    expect(swatches[0]).toHaveStyle({ backgroundColor: PARTICLE_COLORS.dark[5] });
    expect(swatches[5]).toHaveStyle({ backgroundColor: PARTICLE_COLORS.dark[0] });
    unmount();

    render(<WindSpeedLegend theme="light" />);
    swatches = screen.getAllByTestId("wind-speed-swatch");
    expect(swatches[2]).toHaveStyle({ backgroundColor: PARTICLE_COLORS.light[3] });
  });
});
