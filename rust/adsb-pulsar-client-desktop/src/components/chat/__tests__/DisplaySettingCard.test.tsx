import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DisplaySettingCard } from "../DisplaySettingCard";

describe("DisplaySettingCard", () => {
  it("shows loading state when in_progress", () => {
    render(<DisplaySettingCard setting="Map Theme" status="in_progress" />);
    expect(screen.getByText("Map Theme")).toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders key-value pairs from JSON result on complete", () => {
    const result = JSON.stringify({ mapTheme: "dark", sidebarOpen: true });
    render(<DisplaySettingCard setting="Connection Status" status="complete" result={result} />);
    expect(screen.getByText("Connection Status")).toBeInTheDocument();
    expect(screen.getByText("mapTheme")).toBeInTheDocument();
    expect(screen.getByText("dark")).toBeInTheDocument();
    expect(screen.getByText("sidebarOpen")).toBeInTheDocument();
    expect(screen.getByText("on")).toBeInTheDocument(); // boolean true → "on"
  });

  it("formats boolean false as off", () => {
    const result = JSON.stringify({ history: false });
    render(<DisplaySettingCard setting="Layers" status="complete" result={result} />);
    expect(screen.getByText("off")).toBeInTheDocument();
  });

  it("formats numbers with locale string", () => {
    const result = JSON.stringify({ altitudeMin: 1000 });
    render(<DisplaySettingCard setting="Density" status="complete" result={result} />);
    expect(screen.getByText("1,000")).toBeInTheDocument();
  });

  it("handles invalid JSON gracefully", () => {
    render(<DisplaySettingCard setting="Test" status="complete" result="not json" />);
    expect(screen.getByText("Test")).toBeInTheDocument();
    // No crash, just empty content
  });
});
