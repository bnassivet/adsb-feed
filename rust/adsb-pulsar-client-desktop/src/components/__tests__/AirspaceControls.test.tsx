import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AirspaceControls, type AirspaceControlsProps } from "../AirspaceControls";

function props(over: Partial<AirspaceControlsProps> = {}): AirspaceControlsProps {
  return {
    show: true,
    onToggle: vi.fn(),
    count: 42,
    status: { cycles: ["2611"], expired: false, errors: [] },
    loading: false,
    error: null,
    onReload: vi.fn(),
    opacity: 0.6,
    onOpacityChange: vi.fn(),
    ...over,
  };
}

describe("AirspaceControls", () => {
  it("toggles the layer", async () => {
    const p = props({ show: false });
    render(<AirspaceControls {...p} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /airspaces/i }));
    expect(p.onToggle).toHaveBeenCalledOnce();
  });

  it("shows nothing else while off", () => {
    render(<AirspaceControls {...props({ show: false })} />);
    expect(screen.queryByText(/AIRAC/)).toBeNull();
  });

  it("shows the count and the AIRAC cycle", () => {
    render(<AirspaceControls {...props()} />);
    expect(screen.getByText(/42 airspaces/)).toBeInTheDocument();
    expect(screen.getByText(/AIRAC 2611/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when the data's cycle has expired", () => {
    render(<AirspaceControls {...props({ status: { cycles: ["2610"], expired: true, errors: ["CA: HTTP 500"] } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/expired/i);
    expect(screen.getByText("CA: HTTP 500")).toBeInTheDocument();
  });

  it("shows per-country errors and offers a retry", async () => {
    const p = props({ count: 0, status: { cycles: [], expired: false, errors: ["CA: No OpenAIP API key"] } });
    render(<AirspaceControls {...p} />);
    expect(screen.getByText("CA: No OpenAIP API key")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(p.onReload).toHaveBeenCalledOnce();
  });

  it("shows loading and command errors", () => {
    const { rerender } = render(<AirspaceControls {...props({ loading: true, count: 0, status: { cycles: [], expired: false, errors: [] } })} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    rerender(<AirspaceControls {...props({ error: "No app data directory" })} />);
    expect(screen.getByText("No app data directory")).toBeInTheDocument();
  });

  it("has an opacity slider showing the current percentage", () => {
    render(<AirspaceControls {...props({ opacity: 0.35 })} />);
    const slider = screen.getByRole("slider", { name: /opacity/i });
    expect(slider).toHaveValue("35");
    expect(screen.getByText("35%")).toBeInTheDocument();
  });

  it("reports slider moves as a 0–1 fraction", () => {
    const p = props();
    render(<AirspaceControls {...p} />);
    fireEvent.change(screen.getByRole("slider", { name: /opacity/i }), { target: { value: "20" } });
    expect(p.onOpacityChange).toHaveBeenCalledWith(0.2);
  });

  it("hides the slider while the layer is off", () => {
    render(<AirspaceControls {...props({ show: false })} />);
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("credits openAIP and its licence", () => {
    render(<AirspaceControls {...props()} />);
    expect(screen.getByText(/openAIP/)).toBeInTheDocument();
    expect(screen.getByText(/CC BY-NC-SA/)).toBeInTheDocument();
  });
});
