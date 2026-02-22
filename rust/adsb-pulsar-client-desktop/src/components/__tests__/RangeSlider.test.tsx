import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RangeSlider } from "../RangeSlider";

function renderSlider(overrides: Partial<Parameters<typeof RangeSlider>[0]> = {}) {
  const defaults = {
    min: 0,
    max: 50000,
    step: 1000,
    valueMin: 10000,
    valueMax: 40000,
    onChange: vi.fn(),
    formatLabel: (v: number) => `${v.toLocaleString()} ft`,
  };
  const props = { ...defaults, ...overrides };
  return { ...render(<RangeSlider {...props} />), props };
}

describe("RangeSlider", () => {
  it("renders a label showing formatted min and max values", () => {
    renderSlider();
    expect(screen.getByText(/10,000 ft/)).toBeInTheDocument();
    expect(screen.getByText(/40,000 ft/)).toBeInTheDocument();
  });

  it("renders two range inputs with aria-labels", () => {
    renderSlider();
    expect(screen.getByRole("slider", { name: "minimum" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "maximum" })).toBeInTheDocument();
  });

  it("min input has correct initial value", () => {
    renderSlider({ valueMin: 5000 });
    const minInput = screen.getByRole("slider", { name: "minimum" }) as HTMLInputElement;
    expect(minInput.value).toBe("5000");
  });

  it("max input has correct initial value", () => {
    renderSlider({ valueMax: 35000 });
    const maxInput = screen.getByRole("slider", { name: "maximum" }) as HTMLInputElement;
    expect(maxInput.value).toBe("35000");
  });

  it("moving min handle calls onChange with new min and unchanged max", () => {
    const onChange = vi.fn();
    renderSlider({ valueMin: 10000, valueMax: 40000, onChange });
    fireEvent.change(screen.getByRole("slider", { name: "minimum" }), {
      target: { value: "15000" },
    });
    expect(onChange).toHaveBeenCalledWith(15000, 40000);
  });

  it("moving max handle calls onChange with unchanged min and new max", () => {
    const onChange = vi.fn();
    renderSlider({ valueMin: 10000, valueMax: 40000, onChange });
    fireEvent.change(screen.getByRole("slider", { name: "maximum" }), {
      target: { value: "45000" },
    });
    expect(onChange).toHaveBeenCalledWith(10000, 45000);
  });

  it("min handle is clamped to valueMax - step when dragged past max", () => {
    const onChange = vi.fn();
    renderSlider({ valueMin: 10000, valueMax: 40000, step: 1000, onChange });
    // drag min past max
    fireEvent.change(screen.getByRole("slider", { name: "minimum" }), {
      target: { value: "42000" },
    });
    expect(onChange).toHaveBeenCalledWith(39000, 40000);
  });

  it("max handle is clamped to valueMin + step when dragged past min", () => {
    const onChange = vi.fn();
    renderSlider({ valueMin: 10000, valueMax: 40000, step: 1000, onChange });
    // drag max past min
    fireEvent.change(screen.getByRole("slider", { name: "maximum" }), {
      target: { value: "8000" },
    });
    expect(onChange).toHaveBeenCalledWith(10000, 11000);
  });

  it("uses formatLabel for the label text", () => {
    renderSlider({
      valueMin: 0,
      valueMax: 600,
      formatLabel: (v) => `${v} kts`,
    });
    expect(screen.getByText(/0 kts/)).toBeInTheDocument();
    expect(screen.getByText(/600 kts/)).toBeInTheDocument();
  });
});
