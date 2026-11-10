import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolCallChip } from "../ToolCallChip";

/* One line per agent tool call that has no card: the tool's name and its
   parameters. The answer text carries the data, so no result is shown. */
describe("ToolCallChip", () => {
  it("shows the tool name and a done mark when complete", () => {
    render(<ToolCallChip name="getCurrentDateTime" status="complete" parameters={{}} />);
    expect(screen.getByText("getCurrentDateTime")).toBeInTheDocument();
    expect(screen.getByLabelText("done")).toBeInTheDocument();
  });

  it.each(["inProgress", "executing"])("shows a running mark while %s", (status) => {
    render(<ToolCallChip name="getStorageStats" status={status} parameters={{}} />);
    expect(screen.getByLabelText("running")).toBeInTheDocument();
  });

  it("lists the parameters as key=value", () => {
    render(
      <ToolCallChip
        name="getAircraftSummary"
        status="complete"
        parameters={{ limit: 10, callsign: "DLH4AB" }}
      />,
    );
    expect(screen.getByText("limit=10")).toBeInTheDocument();
    expect(screen.getByText("callsign=DLH4AB")).toBeInTheDocument();
  });

  it("formats *Ms parameters as dates", () => {
    const ms = Date.UTC(2026, 10, 10, 18, 0);
    render(<ToolCallChip name="getHourlyHeatmap" status="complete" parameters={{ startMs: ms }} />);
    const text = screen.getByText(/^startMs=/).textContent ?? "";
    expect(text).not.toContain(String(ms));
    expect(text).toMatch(/2026/);
  });

  it("shortens long values and keeps the full JSON in the tooltip", () => {
    const routeHint = "a".repeat(200);
    const { container } = render(
      <ToolCallChip name="generateSimulatedTrajectory" status="complete" parameters={{ routeHint }} />,
    );
    const value = screen.getByText(/^routeHint=/).textContent ?? "";
    expect(value.length).toBeLessThan(80);
    expect(value).toMatch(/…$/);
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain(routeHint);
  });

  it("shows only the name when there are no parameters", () => {
    const { container } = render(
      <ToolCallChip name="getStorageStats" status="complete" parameters={{}} />,
    );
    expect(container.textContent).not.toContain("=");
  });

  it("tolerates parameters that are still streaming in", () => {
    render(<ToolCallChip name="getTrajectory" status="inProgress" parameters={undefined} />);
    expect(screen.getByText("getTrajectory")).toBeInTheDocument();
  });
});
