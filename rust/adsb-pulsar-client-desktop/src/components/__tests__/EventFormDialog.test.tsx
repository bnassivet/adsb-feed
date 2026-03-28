import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventFormDialog } from "../EventFormDialog";
import type { MapPickResult } from "@/lib/types";

describe("EventFormDialog", () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders create form with required fields", () => {
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} />);

    expect(screen.getByText("New Event of Interest")).toBeTruthy();
    expect(screen.getByText("Title *")).toBeTruthy();
    expect(screen.getByText("Description *")).toBeTruthy();
    expect(screen.getByText("Create")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("renders edit form when editEvent is provided", () => {
    render(
      <EventFormDialog
        editEvent={{
          id: "e1",
          title: "Existing",
          description: "Desc",
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
        }}
        onSave={onSave}
        onCancel={onCancel}
      />
    );

    expect(screen.getByText("Edit Event")).toBeTruthy();
    expect(screen.getByDisplayValue("Existing")).toBeTruthy();
    expect(screen.getByText("Update")).toBeTruthy();
  });

  it("pre-fills location from props", () => {
    render(
      <EventFormDialog
        initialLat={45.5}
        initialLng={-73.6}
        onSave={onSave}
        onCancel={onCancel}
      />
    );

    expect(screen.getByDisplayValue("45.5")).toBeTruthy();
    expect(screen.getByDisplayValue("-73.6")).toBeTruthy();
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} />);

    await user.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables submit when title is empty", () => {
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} />);

    const submitBtn = screen.getByText("Create");
    expect(submitBtn).toBeDisabled();
  });
});

describe("map picking buttons", () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  it("does not show Pick/Draw buttons without onStartMapPick prop", () => {
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} />);
    expect(screen.queryByTitle("Pick location on map")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Draw area on map")).not.toBeInTheDocument();
  });

  it("shows Pick button when onStartMapPick provided and location mode is point", async () => {
    const user = userEvent.setup();
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} onStartMapPick={vi.fn()} />);
    await user.click(screen.getByText("Location"));
    await user.click(screen.getByText("point"));
    expect(screen.getByTitle("Pick location on map")).toBeInTheDocument();
  });

  it("shows Draw button when onStartMapPick provided and location mode is area", async () => {
    const user = userEvent.setup();
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} onStartMapPick={vi.fn()} />);
    await user.click(screen.getByText("Location"));
    await user.click(screen.getByText("area"));
    expect(screen.getByTitle("Draw area on map")).toBeInTheDocument();
  });

  it("calls onStartMapPick('point') when Pick button clicked", async () => {
    const user = userEvent.setup();
    const onStartMapPick = vi.fn();
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} onStartMapPick={onStartMapPick} />);
    await user.click(screen.getByText("Location"));
    await user.click(screen.getByText("point"));
    await user.click(screen.getByTitle("Pick location on map"));
    expect(onStartMapPick).toHaveBeenCalledWith("point");
  });

  it("calls onStartMapPick('area') when Draw button clicked", async () => {
    const user = userEvent.setup();
    const onStartMapPick = vi.fn();
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} onStartMapPick={onStartMapPick} />);
    await user.click(screen.getByText("Location"));
    await user.click(screen.getByText("area"));
    await user.click(screen.getByTitle("Draw area on map"));
    expect(onStartMapPick).toHaveBeenCalledWith("area");
  });
});

describe("picking banner mode", () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  it("shows picking banner when isPickingFromMap is true", () => {
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} isPickingFromMap={true} onStartMapPick={vi.fn()} />);
    expect(screen.getByText(/Click on the map/)).toBeInTheDocument();
  });

  it("hides the full form when isPickingFromMap is true", () => {
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} isPickingFromMap={true} onStartMapPick={vi.fn()} />);
    expect(screen.queryByText("New Event of Interest")).not.toBeInTheDocument();
  });

  it("banner Cancel button calls onCancel", async () => {
    const user = userEvent.setup();
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} isPickingFromMap={true} onStartMapPick={vi.fn()} />);
    await user.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("mapPickResult handling", () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  it("updates lat/lng fields when point result received", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <EventFormDialog onSave={onSave} onCancel={onCancel} onStartMapPick={vi.fn()} />
    );
    // Open location section and set to point mode
    await user.click(screen.getByText("Location"));
    await user.click(screen.getByText("point"));

    // Simulate pick result
    const result: MapPickResult = { type: "point", lat: 45.5, lng: -73.6 };
    rerender(
      <EventFormDialog onSave={onSave} onCancel={onCancel} onStartMapPick={vi.fn()} mapPickResult={result} />
    );

    expect(screen.getByPlaceholderText("Latitude")).toHaveValue(45.5);
    expect(screen.getByPlaceholderText("Longitude")).toHaveValue(-73.6);
  });

  it("updates bbox fields when area result received", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <EventFormDialog onSave={onSave} onCancel={onCancel} onStartMapPick={vi.fn()} />
    );
    await user.click(screen.getByText("Location"));
    await user.click(screen.getByText("area"));

    const result: MapPickResult = { type: "area", north: 46, south: 44, east: -72, west: -74 };
    rerender(
      <EventFormDialog onSave={onSave} onCancel={onCancel} onStartMapPick={vi.fn()} mapPickResult={result} />
    );

    expect(screen.getByPlaceholderText("North")).toHaveValue(46);
    expect(screen.getByPlaceholderText("South")).toHaveValue(44);
    expect(screen.getByPlaceholderText("East")).toHaveValue(-72);
    expect(screen.getByPlaceholderText("West")).toHaveValue(-74);
  });
});

describe("draggable dialog", () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  it("title bar has move cursor for dragging", () => {
    render(<EventFormDialog onSave={onSave} onCancel={onCancel} />);
    const titleBar = screen.getByText("New Event of Interest").closest("[class*='cursor-move']");
    expect(titleBar).toBeInTheDocument();
  });

  it("edit dialog title bar is also draggable", () => {
    render(
      <EventFormDialog
        editEvent={{
          id: "e1",
          title: "Existing",
          description: "Desc",
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
        }}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
    const titleBar = screen.getByText("Edit Event").closest("[class*='cursor-move']");
    expect(titleBar).toBeInTheDocument();
  });
});
