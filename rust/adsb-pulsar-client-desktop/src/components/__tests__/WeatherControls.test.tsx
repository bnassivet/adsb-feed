import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WeatherControls, type WeatherControlsProps } from "../WeatherControls";

const MIN = 60_000;

function props(overrides: Partial<WeatherControlsProps> = {}): WeatherControlsProps {
  return {
    show: true,
    onToggle: vi.fn(),
    level: 250,
    onLevelChange: vi.fn(),
    levels: [850, 700, 500, 300, 250, 200],
    availability: "available",
    validTimeMs: 0,
    stale: false,
    nowMs: 35 * MIN,
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    ...overrides,
  };
}

describe("WeatherControls", () => {
  it("toggling the layer calls the handler", async () => {
    const onToggle = vi.fn();
    render(<WeatherControls {...props({ show: false, onToggle })} />);

    await userEvent.setup().click(screen.getByRole("checkbox", { name: /winds aloft/i }));

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("disables the toggle and says why when the live source is not MQTT", () => {
    render(
      <WeatherControls
        {...props({ availability: "unsupported_source", validTimeMs: null, attribution: null })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /winds aloft/i })).toBeDisabled();
    expect(screen.getByText(/mqtt/i)).toBeInTheDocument();
  });

  it("says it is waiting before the first snapshot", () => {
    render(
      <WeatherControls {...props({ availability: "waiting", validTimeMs: null, attribution: null })} />,
    );

    expect(screen.getByText(/waiting for the weather service/i)).toBeInTheDocument();
  });

  it("offers the surface and every level in the snapshot", () => {
    render(<WeatherControls {...props()} />);

    expect(screen.getByRole("button", { name: "SFC" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "FL340 · 250 hPa" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(7);
  });

  it("marks the selected level", () => {
    render(<WeatherControls {...props({ level: 250 })} />);

    expect(screen.getByRole("button", { name: "FL340 · 250 hPa" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "SFC" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the level that was picked", async () => {
    const onLevelChange = vi.fn();
    render(<WeatherControls {...props({ onLevelChange })} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "FL050 · 850 hPa" }));

    expect(onLevelChange).toHaveBeenCalledWith(850);
  });

  it("hides the level picker while the layer is off", () => {
    render(<WeatherControls {...props({ show: false })} />);

    expect(screen.queryByRole("button", { name: "SFC" })).not.toBeInTheDocument();
  });

  it("shows how old the data is", () => {
    render(<WeatherControls {...props()} />);

    expect(screen.getByText(/valid 35 min ago/)).toBeInTheDocument();
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
  });

  it("flags stale data", () => {
    render(<WeatherControls {...props({ stale: true, nowMs: 5 * 60 * MIN })} />);

    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it("credits the data source", () => {
    render(<WeatherControls {...props()} />);

    expect(screen.getByText(/open-meteo/i)).toBeInTheDocument();
  });
});
