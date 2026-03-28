import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventsOfInterestPanel } from "../EventsOfInterestPanel";

const baseProps = {
  isOpen: true,
  onToggle: vi.fn(),
  onNewEvent: vi.fn(),
  width: 340,
  onWidthChange: vi.fn(),
  dockedExpanded: true,
  onDockedExpandedChange: vi.fn(),
  floating: false,
  onFloatingChange: vi.fn(),
  floatX: 100,
  floatY: 80,
  floatW: 360,
  floatH: 400,
  onFloatPosChange: vi.fn(),
  onFloatSizeChange: vi.fn(),
};

describe("EventsOfInterestPanel", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = render(<EventsOfInterestPanel {...baseProps} isOpen={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders docked expanded with correct testid", () => {
    render(<EventsOfInterestPanel {...baseProps} />);
    expect(screen.getByTestId("events-panel-docked")).toBeInTheDocument();
  });

  it("renders collapsed strip when dockedExpanded is false", () => {
    render(<EventsOfInterestPanel {...baseProps} dockedExpanded={false} />);
    const panel = screen.getByTestId("events-panel-docked");
    expect(panel).toBeInTheDocument();
    expect(screen.getByTitle("Expand Events")).toBeInTheDocument();
  });

  it("calls onDockedExpandedChange(true) on collapsed strip click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<EventsOfInterestPanel {...baseProps} dockedExpanded={false} onDockedExpandedChange={onChange} />);
    await user.click(screen.getByTitle("Expand Events"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("collapse button calls onDockedExpandedChange(false)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<EventsOfInterestPanel {...baseProps} onDockedExpandedChange={onChange} />);
    await user.click(screen.getByTitle("Collapse panel"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("unpin button switches to floating mode", async () => {
    const onFloating = vi.fn();
    const user = userEvent.setup();
    render(<EventsOfInterestPanel {...baseProps} onFloatingChange={onFloating} />);
    await user.click(screen.getByTitle("Undock to floating window"));
    expect(onFloating).toHaveBeenCalledWith(true);
  });

  it("renders floating panel when floating is true", () => {
    render(<EventsOfInterestPanel {...baseProps} floating={true} />);
    expect(screen.getByTestId("events-panel-floating")).toBeInTheDocument();
    expect(screen.queryByTestId("events-panel-docked")).not.toBeInTheDocument();
  });

  it("floating panel has close button that calls onToggle", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<EventsOfInterestPanel {...baseProps} floating={true} onToggle={onToggle} />);
    await user.click(screen.getByTitle("Close"));
    expect(onToggle).toHaveBeenCalled();
  });

  it("floating panel pin button docks the panel", async () => {
    const onFloating = vi.fn();
    const user = userEvent.setup();
    render(<EventsOfInterestPanel {...baseProps} floating={true} onFloatingChange={onFloating} />);
    await user.click(screen.getByTitle("Dock to right side"));
    expect(onFloating).toHaveBeenCalledWith(false);
  });

  it("renders children in docked mode", () => {
    render(
      <EventsOfInterestPanel {...baseProps}>
        <div data-testid="child-content">Hello</div>
      </EventsOfInterestPanel>,
    );
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  it("renders children in floating mode", () => {
    render(
      <EventsOfInterestPanel {...baseProps} floating={true}>
        <div data-testid="child-content">Hello</div>
      </EventsOfInterestPanel>,
    );
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  it("+ New button calls onNewEvent in docked mode", async () => {
    const onNewEvent = vi.fn();
    const user = userEvent.setup();
    render(<EventsOfInterestPanel {...baseProps} onNewEvent={onNewEvent} />);
    await user.click(screen.getByTitle("Create new event"));
    expect(onNewEvent).toHaveBeenCalled();
  });

  it("+ New button calls onNewEvent in floating mode", async () => {
    const onNewEvent = vi.fn();
    const user = userEvent.setup();
    render(<EventsOfInterestPanel {...baseProps} floating={true} onNewEvent={onNewEvent} />);
    await user.click(screen.getByTitle("Create new event"));
    expect(onNewEvent).toHaveBeenCalled();
  });

  it("shows 'Hide all' button when not all hidden in docked mode", () => {
    render(<EventsOfInterestPanel {...baseProps} allHidden={false} onToggleAllVisibility={vi.fn()} />);
    expect(screen.getByTitle("Hide all from map")).toBeInTheDocument();
  });

  it("shows 'Show all' button when all hidden in docked mode", () => {
    render(<EventsOfInterestPanel {...baseProps} allHidden={true} onToggleAllVisibility={vi.fn()} />);
    expect(screen.getByTitle("Show all on map")).toBeInTheDocument();
  });

  it("calls onToggleAllVisibility when toggle clicked in docked mode", async () => {
    const user = userEvent.setup();
    const onToggleAll = vi.fn();
    render(<EventsOfInterestPanel {...baseProps} allHidden={false} onToggleAllVisibility={onToggleAll} />);
    await user.click(screen.getByTitle("Hide all from map"));
    expect(onToggleAll).toHaveBeenCalled();
  });

  it("calls onToggleAllVisibility when toggle clicked in floating mode", async () => {
    const user = userEvent.setup();
    const onToggleAll = vi.fn();
    render(<EventsOfInterestPanel {...baseProps} floating={true} allHidden={true} onToggleAllVisibility={onToggleAll} />);
    await user.click(screen.getByTitle("Show all on map"));
    expect(onToggleAll).toHaveBeenCalled();
  });

  it("does not show visibility toggle when props not provided", () => {
    render(<EventsOfInterestPanel {...baseProps} />);
    expect(screen.queryByTitle("Hide all from map")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Show all on map")).not.toBeInTheDocument();
  });
});
