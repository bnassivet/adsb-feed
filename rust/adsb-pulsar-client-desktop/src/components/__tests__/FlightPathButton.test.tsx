import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlightPathButton, flightPathTitle } from "../FlightPathButton";

describe("FlightPathButton", () => {
  it("renders an accessible toggle", () => {
    render(<FlightPathButton active={false} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: /route on map/i });
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the pressed state when on", () => {
    render(<FlightPathButton active onToggle={() => {}} hasRoute />);
    expect(screen.getByRole("button", { name: /route on map/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggle when clicked, with or without a route to draw", async () => {
    const onToggle = vi.fn();
    render(<FlightPathButton active onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("flightPathTitle", () => {
  it("explains each state, in the details panel's words", () => {
    expect(flightPathTitle({ active: false })).toBe("Show route on map");
    expect(flightPathTitle({ active: true, hasRoute: true })).toBe("Hide route on map");
    expect(flightPathTitle({ active: true, hasRoute: false })).toBe("Route on map: look up a flight with Show Flight Infos");
  });
});
