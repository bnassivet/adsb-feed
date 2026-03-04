import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModeTabs } from "../ModeTabs";

function renderTabs(overrides: Partial<Parameters<typeof ModeTabs>[0]> = {}) {
  const defaults = {
    activeMode: "live" as const,
    onModeChange: vi.fn(),
    liveCount: 42,
    analysisCount: 5,
    onClearAnalysis: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  const result = render(<ModeTabs {...props} />);
  return { ...result, ...props };
}

describe("ModeTabs", () => {
  it("renders both tabs with correct counts", () => {
    renderTabs({ liveCount: 10, analysisCount: 3 });
    expect(screen.getByTestId("mode-tab-live")).toHaveTextContent("Live (10)");
    expect(screen.getByTestId("mode-tab-analysis")).toHaveTextContent("Analysis (3)");
  });

  it("active Live tab has blue styling", () => {
    renderTabs({ activeMode: "live" });
    expect(screen.getByTestId("mode-tab-live").className).toContain("text-blue-300");
    expect(screen.getByTestId("mode-tab-analysis").className).toContain("text-slate-500");
  });

  it("active Analysis tab has cyan styling", () => {
    renderTabs({ activeMode: "analysis" });
    expect(screen.getByTestId("mode-tab-analysis").className).toContain("text-cyan-300");
    expect(screen.getByTestId("mode-tab-live").className).toContain("text-slate-500");
  });

  it("clicking Live tab calls onModeChange with 'live'", async () => {
    const user = userEvent.setup();
    const { onModeChange } = renderTabs({ activeMode: "analysis" });
    await user.click(screen.getByTestId("mode-tab-live"));
    expect(onModeChange).toHaveBeenCalledWith("live");
  });

  it("clicking Analysis tab calls onModeChange with 'analysis'", async () => {
    const user = userEvent.setup();
    const { onModeChange } = renderTabs({ activeMode: "live" });
    await user.click(screen.getByTestId("mode-tab-analysis"));
    expect(onModeChange).toHaveBeenCalledWith("analysis");
  });

  it("'Clear all' button visible on Analysis tab when count > 0", () => {
    renderTabs({ activeMode: "analysis", analysisCount: 3 });
    expect(screen.getByTestId("mode-tabs-clear-analysis")).toBeInTheDocument();
  });

  it("'Clear all' button hidden in Live mode", () => {
    renderTabs({ activeMode: "live", analysisCount: 3 });
    expect(screen.queryByTestId("mode-tabs-clear-analysis")).not.toBeInTheDocument();
  });

  it("'Clear all' button hidden when analysis count is 0", () => {
    renderTabs({ activeMode: "analysis", analysisCount: 0 });
    expect(screen.queryByTestId("mode-tabs-clear-analysis")).not.toBeInTheDocument();
  });

  it("'Clear all' button calls onClearAnalysis", async () => {
    const user = userEvent.setup();
    const { onClearAnalysis } = renderTabs({ activeMode: "analysis", analysisCount: 5 });
    await user.click(screen.getByTestId("mode-tabs-clear-analysis"));
    expect(onClearAnalysis).toHaveBeenCalledTimes(1);
  });
});
