import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventsCard } from "../EventsCard";

describe("EventsCard", () => {
  it("shows loading state when in_progress", () => {
    render(<EventsCard status="in_progress" />);
    expect(screen.getByText("Events (0)")).toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders events table on complete", () => {
    const events = [
      {
        id: "e1",
        title: "Low flyover",
        category: "surveillance",
        timestamp_ms: 1712900000000,
        latitude: 48.8,
        longitude: 2.3,
      },
    ];
    render(<EventsCard status="complete" result={JSON.stringify(events)} />);
    expect(screen.getByText("Events (1)")).toBeInTheDocument();
    expect(screen.getByText("Low flyover")).toBeInTheDocument();
    expect(screen.getByText("surveillance")).toBeInTheDocument();
  });

  it("renders truncated result with note", () => {
    const result = {
      total: 50,
      showing: 20,
      data: [
        { id: "e1", title: "Test", category: null, timestamp_ms: 1712900000000 },
      ],
      note: "Showing first 20 events.",
    };
    render(<EventsCard status="complete" result={JSON.stringify(result)} />);
    expect(screen.getByText("Events (50)")).toBeInTheDocument();
    expect(screen.getByText("Showing first 20 events.")).toBeInTheDocument();
  });

  it("handles invalid JSON gracefully", () => {
    render(<EventsCard status="complete" result="not json" />);
    expect(screen.getByText("Events (0)")).toBeInTheDocument();
  });

  it("shows dash for missing category", () => {
    const events = [
      { id: "e1", title: "Unnamed", category: null, timestamp_ms: 1712900000000 },
    ];
    render(<EventsCard status="complete" result={JSON.stringify(events)} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
