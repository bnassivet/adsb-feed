import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CenterOnAntennaButton } from "../CenterOnAntennaButton";

describe("CenterOnAntennaButton", () => {
  it("renders an accessible button to center on the antenna", () => {
    render(<CenterOnAntennaButton onClick={() => {}} />);
    expect(
      screen.getByRole("button", { name: /center map on antenna/i }),
    ).toBeInTheDocument();
  });

  it("calls onClick when enabled and clicked", async () => {
    const onClick = vi.fn();
    render(<CenterOnAntennaButton onClick={onClick} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled and does not call onClick when disabled", async () => {
    const onClick = vi.fn();
    render(<CenterOnAntennaButton onClick={onClick} disabled />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
