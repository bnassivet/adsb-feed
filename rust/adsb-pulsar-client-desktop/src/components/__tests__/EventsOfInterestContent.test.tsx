import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventsOfInterestContent } from "../EventsOfInterestContent";
import type { EventOfInterest } from "@/lib/types";

// Mock tauri dialog to avoid native calls
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

function makeEvent(overrides: Partial<EventOfInterest> = {}): EventOfInterest {
  return {
    id: "evt-1",
    title: "Test Event",
    description: "A test event",
    timestamp_ms: Date.now(),
    end_timestamp_ms: null,
    latitude: null,
    longitude: null,
    bbox_north: null,
    bbox_south: null,
    bbox_east: null,
    bbox_west: null,
    source: "user",
    category: null,
    metadata: null,
    linked_hex_idents: null,
    created_at_ms: Date.now(),
    updated_at_ms: Date.now(),
    ...overrides,
  };
}

const defaultProps = {
  events: [] as EventOfInterest[],
  loading: false,
  onEditEvent: vi.fn(),
  onDeleteEvent: vi.fn().mockResolvedValue(undefined),
};

describe("EventsOfInterestContent", () => {
  it("shows loading state", () => {
    render(<EventsOfInterestContent {...defaultProps} loading={true} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows empty state when no events", () => {
    render(<EventsOfInterestContent {...defaultProps} />);
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
  });

  it("renders event title", () => {
    const events = [makeEvent({ title: "Air Show" })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    expect(screen.getByText("Air Show")).toBeInTheDocument();
  });

  it("renders source badge", () => {
    const events = [makeEvent({ source: "detector" })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    expect(screen.getByText("detector")).toBeInTheDocument();
  });

  it("renders category badge when present", () => {
    const events = [makeEvent({ category: "military" })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    expect(screen.getByText("military")).toBeInTheDocument();
  });

  it("shows point indicator for events with latitude", () => {
    const events = [makeEvent({ latitude: 45.5, longitude: -73.6 })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    expect(screen.getByText(/point/)).toBeInTheDocument();
  });

  it("shows area indicator for events with bbox", () => {
    const events = [makeEvent({ bbox_north: 46, bbox_south: 45, bbox_east: -73, bbox_west: -74 })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    expect(screen.getByText(/area/)).toBeInTheDocument();
  });

  it("calls onEditEvent when clicking a user event", async () => {
    const user = userEvent.setup();
    const onEditEvent = vi.fn();
    const event = makeEvent({ source: "user", title: "My Event" });
    render(<EventsOfInterestContent {...defaultProps} events={[event]} onEditEvent={onEditEvent} />);
    await user.click(screen.getByText("My Event"));
    expect(onEditEvent).toHaveBeenCalledWith(event);
  });

  it("does not call onEditEvent when clicking a non-user event", async () => {
    const user = userEvent.setup();
    const onEditEvent = vi.fn();
    const event = makeEvent({ source: "detector", title: "Detected" });
    render(<EventsOfInterestContent {...defaultProps} events={[event]} onEditEvent={onEditEvent} />);
    await user.click(screen.getByText("Detected"));
    expect(onEditEvent).not.toHaveBeenCalled();
  });

  it("shows delete button only for user events", () => {
    const events = [
      makeEvent({ id: "1", source: "user", title: "User Event" }),
      makeEvent({ id: "2", source: "detector", title: "Detector Event" }),
    ];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    const deleteButtons = screen.getAllByTitle("Delete event");
    expect(deleteButtons).toHaveLength(1);
  });

  it("displays event time in datetime format", () => {
    const ts = new Date("2026-02-23T15:30:00Z").getTime();
    const events = [makeEvent({ timestamp_ms: ts })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    // Should show the formatted datetime (year-month-day hour:minute)
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("displays relative time delta alongside datetime", () => {
    // Use a timestamp 3 days in the past
    const ts = Date.now() - 3 * 24 * 3600_000;
    const events = [makeEvent({ timestamp_ms: ts })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    // Should show the delta (e.g., "3d ago")
    expect(screen.getByText(/3d ago/)).toBeInTheDocument();
  });
});

describe("EventsOfInterestContent multi-select", () => {
  it("shows checkboxes for each event", () => {
    const events = [
      makeEvent({ id: "1", title: "A" }),
      makeEvent({ id: "2", title: "B" }),
    ];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
  });

  it("selecting events shows bulk delete button with count", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent({ id: "1", title: "A" }),
      makeEvent({ id: "2", title: "B" }),
      makeEvent({ id: "3", title: "C" }),
    ];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    expect(screen.getByText(/Delete 2/)).toBeInTheDocument();
  });

  it("bulk delete button calls onDeleteEvents with selected ids", async () => {
    const user = userEvent.setup();
    const onDeleteEvents = vi.fn().mockResolvedValue(undefined);
    const events = [
      makeEvent({ id: "e1", title: "A" }),
      makeEvent({ id: "e2", title: "B" }),
    ];
    render(
      <EventsOfInterestContent
        {...defaultProps}
        events={events}
        onDeleteEvents={onDeleteEvents}
      />
    );
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await user.click(screen.getByText(/Delete 2/));
    expect(onDeleteEvents).toHaveBeenCalledWith(["e1", "e2"]);
  });

  it("deselecting all events hides bulk delete button", async () => {
    const user = userEvent.setup();
    const events = [makeEvent({ id: "1", title: "A" })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox); // select
    expect(screen.getByText(/Delete 1/)).toBeInTheDocument();
    await user.click(checkbox); // deselect
    expect(screen.queryByText(/Delete/)).not.toBeInTheDocument();
  });

  it("clears selection when events prop changes", async () => {
    const user = userEvent.setup();
    const events = [makeEvent({ id: "1", title: "A" })];
    const { rerender } = render(
      <EventsOfInterestContent {...defaultProps} events={events} />
    );
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/Delete 1/)).toBeInTheDocument();

    // Simulate events refresh (e.g., after bulk delete)
    rerender(
      <EventsOfInterestContent {...defaultProps} events={[]} />
    );
    expect(screen.queryByText(/Delete/)).not.toBeInTheDocument();
  });
});

describe("EventsOfInterestContent show/hide", () => {
  it("shows a visibility toggle button for each event", () => {
    const events = [
      makeEvent({ id: "1", title: "A" }),
      makeEvent({ id: "2", title: "B" }),
    ];
    render(
      <EventsOfInterestContent
        {...defaultProps}
        events={events}
        hiddenEventIds={new Set()}
        onToggleEventVisibility={vi.fn()}
      />
    );
    const toggles = screen.getAllByTitle("Hide from map");
    expect(toggles).toHaveLength(2);
  });

  it("shows hidden state for events in hiddenEventIds", () => {
    const events = [
      makeEvent({ id: "1", title: "Visible" }),
      makeEvent({ id: "2", title: "Hidden" }),
    ];
    render(
      <EventsOfInterestContent
        {...defaultProps}
        events={events}
        hiddenEventIds={new Set(["2"])}
        onToggleEventVisibility={vi.fn()}
      />
    );
    expect(screen.getByTitle("Show on map")).toBeInTheDocument();
    expect(screen.getByTitle("Hide from map")).toBeInTheDocument();
  });

  it("calls onToggleEventVisibility with event id when toggle clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const events = [makeEvent({ id: "e1", title: "My Event" })];
    render(
      <EventsOfInterestContent
        {...defaultProps}
        events={events}
        hiddenEventIds={new Set()}
        onToggleEventVisibility={onToggle}
      />
    );
    await user.click(screen.getByTitle("Hide from map"));
    expect(onToggle).toHaveBeenCalledWith("e1");
  });

  it("applies dimmed styling to hidden events", () => {
    const events = [makeEvent({ id: "1", title: "Hidden Event" })];
    render(
      <EventsOfInterestContent
        {...defaultProps}
        events={events}
        hiddenEventIds={new Set(["1"])}
        onToggleEventVisibility={vi.fn()}
      />
    );
    // The event row should have opacity class
    const title = screen.getByText("Hidden Event");
    expect(title.closest("[data-testid='event-row']")).toHaveClass("opacity-50");
  });

  it("does not show visibility toggles when props are not provided", () => {
    const events = [makeEvent({ id: "1", title: "A" })];
    render(<EventsOfInterestContent {...defaultProps} events={events} />);
    expect(screen.queryByTitle("Hide from map")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Show on map")).not.toBeInTheDocument();
  });
});
