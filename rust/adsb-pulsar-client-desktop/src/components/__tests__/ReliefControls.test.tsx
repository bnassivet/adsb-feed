import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReliefControls } from "../ReliefControls";

describe("ReliefControls", () => {
  it("toggles the relief, hiding the slider while off", async () => {
    const onToggle = vi.fn();
    render(<ReliefControls show={false} onToggle={onToggle} opacity={0.6} onOpacityChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /relief/i }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("has an opacity slider and the credit while on", () => {
    const onOpacityChange = vi.fn();
    render(<ReliefControls show onToggle={vi.fn()} opacity={0.6} onOpacityChange={onOpacityChange} />);
    fireEvent.change(screen.getByRole("slider", { name: /relief opacity/i }), { target: { value: "40" } });
    expect(onOpacityChange).toHaveBeenCalledWith(0.4);
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /esri/i })).toBeInTheDocument();
  });
});
