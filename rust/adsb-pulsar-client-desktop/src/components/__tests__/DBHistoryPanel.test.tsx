import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DBHistoryPanel } from "../DBHistoryPanel";

const baseProps = {
  isOpen: true,
  onToggle: vi.fn(),
  width: 360,
  onWidthChange: vi.fn(),
  dockedExpanded: true,
  onDockedExpandedChange: vi.fn(),
  floating: false,
  onFloatingChange: vi.fn(),
  floatX: 100,
  floatY: 80,
  floatW: 400,
  floatH: 600,
  onFloatPosChange: vi.fn(),
  onFloatSizeChange: vi.fn(),
};

describe("DBHistoryPanel", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = render(<DBHistoryPanel {...baseProps} isOpen={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders docked expanded with correct testid", () => {
    render(<DBHistoryPanel {...baseProps} />);
    expect(screen.getByTestId("dbhistory-panel-docked")).toBeInTheDocument();
  });

  it("renders collapsed strip when dockedExpanded is false", () => {
    render(<DBHistoryPanel {...baseProps} dockedExpanded={false} />);
    const panel = screen.getByTestId("dbhistory-panel-docked");
    expect(panel).toBeInTheDocument();
    expect(screen.getByTitle("Expand DB History")).toBeInTheDocument();
  });

  it("calls onDockedExpandedChange(true) on collapsed strip click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryPanel {...baseProps} dockedExpanded={false} onDockedExpandedChange={onChange} />);

    await user.click(screen.getByTitle("Expand DB History"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("collapse button calls onDockedExpandedChange(false)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryPanel {...baseProps} onDockedExpandedChange={onChange} />);

    await user.click(screen.getByTitle("Collapse panel"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("unpin button switches to floating mode", async () => {
    const onFloating = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryPanel {...baseProps} onFloatingChange={onFloating} />);

    await user.click(screen.getByTitle("Undock to floating window"));
    expect(onFloating).toHaveBeenCalledWith(true);
  });

  it("renders floating panel when floating is true", () => {
    render(<DBHistoryPanel {...baseProps} floating={true} />);
    expect(screen.getByTestId("dbhistory-panel-floating")).toBeInTheDocument();
    expect(screen.queryByTestId("dbhistory-panel-docked")).not.toBeInTheDocument();
  });

  it("floating panel has close button that calls onToggle", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryPanel {...baseProps} floating={true} onToggle={onToggle} />);

    await user.click(screen.getByTitle("Close"));
    expect(onToggle).toHaveBeenCalled();
  });

  it("floating panel pin button docks the panel", async () => {
    const onFloating = vi.fn();
    const user = userEvent.setup();
    render(<DBHistoryPanel {...baseProps} floating={true} onFloatingChange={onFloating} />);

    await user.click(screen.getByTitle("Dock to right side"));
    expect(onFloating).toHaveBeenCalledWith(false);
  });

  it("renders children in docked mode", () => {
    render(
      <DBHistoryPanel {...baseProps}>
        <div data-testid="child-content">Hello</div>
      </DBHistoryPanel>,
    );
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  it("renders children in floating mode", () => {
    render(
      <DBHistoryPanel {...baseProps} floating={true}>
        <div data-testid="child-content">Hello</div>
      </DBHistoryPanel>,
    );
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });
});
