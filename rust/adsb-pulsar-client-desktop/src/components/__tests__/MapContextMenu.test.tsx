import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapContextMenu } from "../MapContextMenu";

describe("MapContextMenu", () => {
  const defaultProps = {
    x: 200,
    y: 300,
    lat: 45.5,
    lng: -73.6,
    onCreateEvent: vi.fn(),
    onClose: vi.fn(),
  };

  it("renders menu with Create Event option", () => {
    render(<MapContextMenu {...defaultProps} />);
    expect(screen.getByText("Create Event Here")).toBeTruthy();
  });

  it("shows coordinates", () => {
    render(<MapContextMenu {...defaultProps} />);
    expect(screen.getByText("45.50000, -73.60000")).toBeTruthy();
  });

  it("calls onCreateEvent with coordinates and closes on click", async () => {
    const user = userEvent.setup();
    render(<MapContextMenu {...defaultProps} />);

    await user.click(screen.getByText("Create Event Here"));
    expect(defaultProps.onCreateEvent).toHaveBeenCalledWith(45.5, -73.6);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });
});
