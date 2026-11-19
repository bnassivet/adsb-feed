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
    showHoverInfo: true,
    onToggleHoverInfo: vi.fn(),
    types: [
      { type: 4, label: "CTR", count: 3 },
      { type: 1, label: "Restricted", count: 5 },
      { type: 7, label: "TMA", count: 2 },
    ],
    hiddenTypes: [],
    onHiddenTypesChange: vi.fn(),
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

  it("toggles the hover readout", async () => {
    const p = props({ showHoverInfo: false });
    render(<AirspaceControls {...p} />);
    const box = screen.getByRole("checkbox", { name: /hover/i });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(p.onToggleHoverInfo).toHaveBeenCalledOnce();
  });

  it("hides the hover toggle while the layer is off", () => {
    render(<AirspaceControls {...props({ show: false })} />);
    expect(screen.queryByRole("checkbox", { name: /hover/i })).toBeNull();
  });

  describe("area type filter", () => {
    const open = async () => userEvent.click(screen.getByRole("button", { name: /area types/i }));

    it("summarises the selection on the closed combo", () => {
      const { rerender } = render(<AirspaceControls {...props()} />);
      expect(screen.getByRole("button", { name: /area types/i })).toHaveTextContent("All types");
      rerender(<AirspaceControls {...props({ hiddenTypes: [1] })} />);
      expect(screen.getByRole("button", { name: /area types/i })).toHaveTextContent("2 of 3 types");
      expect(screen.queryByRole("checkbox", { name: /TMA/ })).toBeNull();
    });

    it("lists each type with its count, checked when shown", async () => {
      render(<AirspaceControls {...props({ hiddenTypes: [1] })} />);
      await open();
      expect(screen.getByRole("checkbox", { name: "CTR (3)" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Restricted (5)" })).not.toBeChecked();
    });

    it("hides and shows one type", async () => {
      const p = props({ hiddenTypes: [1] });
      render(<AirspaceControls {...p} />);
      await open();
      await userEvent.click(screen.getByRole("checkbox", { name: "TMA (2)" }));
      expect(p.onHiddenTypesChange).toHaveBeenLastCalledWith([1, 7]);
      await userEvent.click(screen.getByRole("checkbox", { name: "Restricted (5)" }));
      expect(p.onHiddenTypesChange).toHaveBeenLastCalledWith([]);
    });

    it("has All and None", async () => {
      const p = props({ hiddenTypes: [1] });
      render(<AirspaceControls {...p} />);
      await open();
      await userEvent.click(screen.getByRole("button", { name: "All" }));
      expect(p.onHiddenTypesChange).toHaveBeenLastCalledWith([]);
      await userEvent.click(screen.getByRole("button", { name: "None" }));
      expect(p.onHiddenTypesChange).toHaveBeenLastCalledWith([1, 4, 7]);
    });

    it("keeps hidden types that are absent from this data", async () => {
      // A type hidden while flying elsewhere stays hidden when it reappears.
      const p = props({ hiddenTypes: [2] });
      render(<AirspaceControls {...p} />);
      await open();
      await userEvent.click(screen.getByRole("checkbox", { name: "CTR (3)" }));
      expect(p.onHiddenTypesChange).toHaveBeenLastCalledWith([2, 4]);
      await userEvent.click(screen.getByRole("button", { name: "All" }));
      expect(p.onHiddenTypesChange).toHaveBeenLastCalledWith([2]);
    });

    it("is not offered before any airspace is loaded", () => {
      render(<AirspaceControls {...props({ types: [] })} />);
      expect(screen.queryByRole("button", { name: /area types/i })).toBeNull();
    });
  });

  it("credits openAIP and its licence", () => {
    render(<AirspaceControls {...props()} />);
    expect(screen.getByText(/openAIP/)).toBeInTheDocument();
    expect(screen.getByText(/CC BY-NC-SA/)).toBeInTheDocument();
  });
});
