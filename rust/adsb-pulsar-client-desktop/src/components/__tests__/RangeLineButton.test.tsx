import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RangeLineButton, rangeLineTitle } from "../RangeLineButton";

describe("RangeLineButton", () => {
  it("renders an accessible toggle", () => {
    render(<RangeLineButton active={false} onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: /range lines to receiver/i });
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the pressed state when on", () => {
    render(<RangeLineButton active onToggle={() => {}} hasTargets />);
    expect(screen.getByRole("button", { name: /range lines to receiver/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggle when clicked", async () => {
    const onToggle = vi.fn();
    render(<RangeLineButton active={false} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("is disabled without a receiver and does not toggle", async () => {
    const onToggle = vi.fn();
    render(<RangeLineButton active={false} onToggle={onToggle} disabled />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "No receiver location set");
    await userEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("rangeLineTitle", () => {
  it("explains each state", () => {
    expect(rangeLineTitle({ active: false })).toBe("Show range lines to selected aircraft");
    expect(rangeLineTitle({ active: true, hasTargets: true })).toBe("Hide range lines");
    expect(rangeLineTitle({ active: true, hasTargets: false })).toBe("Range lines on: select an aircraft");
    expect(rangeLineTitle({ active: true, disabled: true })).toBe("No receiver location set");
  });
});
