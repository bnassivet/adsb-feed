import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";

// Recharts draws nothing under jsdom: fixed size, no entry animation.
vi.mock("recharts", async (orig) => {
  const actual = await orig<typeof import("recharts")>();
  return {
    ...actual,
    Bar: (p: React.ComponentProps<typeof actual.Bar>) => <actual.Bar {...p} isAnimationActive={false} />,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) => (
      <div style={{ width: 400, height: 90 }}>{React.cloneElement(children, { width: 400, height: 90 })}</div>
    ),
  };
});

import { OpenSkyCreditsChart, OpenSkyCreditsView } from "../OpenSkyCreditsChart";
import type { CreditsReport } from "@/lib/opensky";

const H = 3_600_000;
const START = Date.UTC(2026, 10, 24, 12);

function report(): CreditsReport {
  return {
    daily_limit: 4000,
    generated_ms: START + 24 * H,
    hours: Array.from({ length: 24 }, (_, i) => ({
      hour_start_ms: START + i * H,
      states: i === 23 ? 150 : i === 10 ? 40 : 0,
      tracks: i === 23 ? 4 : 0,
    })),
  };
}

describe("OpenSkyCreditsView", () => {
  it("totals the 24 hours against the limit", () => {
    render(<OpenSkyCreditsView report={report()} />);
    expect(screen.getByTestId("opensky-credits-total")).toHaveTextContent("190 / 4,000 · tracks 4");
  });

  it("adds OpenSky's own remaining count when it sent one", () => {
    render(<OpenSkyCreditsView report={{ ...report(), daily_limit: 8000, states_remaining: 7412 }} />);
    expect(screen.getByTestId("opensky-credits-total")).toHaveTextContent("190 / 8,000 · tracks 4 · 7,412 left at OpenSky");
  });

  it("says nothing of OpenSky's count without one", () => {
    render(<OpenSkyCreditsView report={{ ...report(), states_remaining: null }} />);
    expect(screen.getByTestId("opensky-credits-total")).not.toHaveTextContent(/left/);
  });

  it("draws a bar for each hour with spending, both buckets stacked", () => {
    const { container } = render(<OpenSkyCreditsView report={report()} />);
    const states = container.querySelectorAll('path[fill="#a78bfa"]');
    const tracks = container.querySelectorAll('path[fill="#f472b6"]');
    expect(states.length).toBe(2);
    expect(tracks.length).toBe(1);
  });
});

describe("OpenSkyCreditsChart", () => {
  beforeEach(() => clearMockResponses());

  it("fetches the report and draws it", async () => {
    mockInvokeResponse("get_opensky_credits", report());
    render(<OpenSkyCreditsChart />);
    await waitFor(() => expect(screen.getByTestId("opensky-credits-chart")).toBeInTheDocument());
  });

  it("is a folded section whose title carries the 24 h total", async () => {
    mockInvokeResponse("get_opensky_credits", report());
    render(<OpenSkyCreditsChart />);
    const section = await screen.findByTestId("dbhist-opensky-credits");
    expect(section.tagName).toBe("DETAILS");
    expect(section).not.toHaveAttribute("open");
    const summary = section.querySelector("summary")!;
    expect(summary).toHaveTextContent(/OpenSky Credits/i);
    expect(summary).toHaveTextContent("190 / 4,000");
    // The title is in the summary, not repeated above the chart.
    expect(screen.queryByText(/OpenSky credits — last 24 h/)).toBeNull();
  });

  it("draws nothing when no OpenSky service answers", async () => {
    // No mock: the command rejects, as with the service not running.
    const { container } = render(<OpenSkyCreditsChart />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container).toBeEmptyDOMElement();
  });
});
