import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WhatIsHere } from "../WhatIsHere";

describe("WhatIsHere", () => {
  const base = { x: 10, y: 20, lat: 47.21, lng: -1.55, onClose: vi.fn() };

  it("says it is loading, then shows the answer and the point", () => {
    const { rerender } = render(<WhatIsHere {...base} result={null} error={null} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    rerender(<WhatIsHere {...base} result={{ elevationM: 31.4, elevationError: null, depth: null, depthError: null }} error={null} />);
    expect(screen.getByText("Ground 31 m (103 ft)")).toBeInTheDocument();
    expect(screen.getByText("47.21000, -1.55000")).toBeInTheDocument();
  });

  it("shows a failed command and closes", async () => {
    const onClose = vi.fn();
    render(<WhatIsHere {...base} onClose={onClose} result={null} error="No app data directory" />);
    expect(screen.getByText("No app data directory")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("credits the sources", () => {
    render(<WhatIsHere {...base} result={{ elevationM: 0, elevationError: null, depth: null, depthError: null }} error={null} />);
    expect(screen.getByText(/Terrarium/)).toBeInTheDocument();
    expect(screen.getByText(/EMODnet/)).toBeInTheDocument();
  });
});
