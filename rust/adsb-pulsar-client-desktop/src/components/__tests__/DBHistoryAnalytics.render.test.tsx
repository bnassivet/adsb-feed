import { beforeEach, describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Recharts draws nothing under jsdom because ResponsiveContainer measures 0×0.
// Give it a fixed size so the real bars render and can be asserted on.
vi.mock("recharts", async (orig) => {
  const actual = await orig<typeof import("recharts")>();
  return {
    ...actual,
    // jsdom never advances Recharts' entry animation past frame 0 (height 0): render final frames.
    Bar: (p: React.ComponentProps<typeof actual.Bar>) => <actual.Bar {...p} isAnimationActive={false} />,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) => (
      <div style={{ width: 400, height: 120 }}>{React.cloneElement(children, { width: 400, height: 120 })}</div>
    ),
  };
});

import { DBHistoryAnalytics } from "../DBHistoryAnalytics";
import { MESSAGE_TYPES } from "@/lib/db-history-analytics";

const color = (key: string) => MESSAGE_TYPES.find((t) => t.key === key)!.color;
const T0 = Date.UTC(2024, 0, 15, 10, 0);
const T1 = Date.UTC(2024, 0, 15, 11, 0);

const props = {
  summaries: [],
  timeBuckets: [
    { bucket_ms: T0, count: 8 },
    { bucket_ms: T1, count: 6 },
  ],
  tzName: "UTC",
  timeMetric: "raw_messages" as const,
  onTimeMetricChange: () => {},
  messageTypeBuckets: [
    { bucket_ms: T0, transmission_type: 3, count: 6 },
    { bucket_ms: T0, transmission_type: 4, count: 2 },
    { bucket_ms: T1, transmission_type: 3, count: 2 },
    { bucket_ms: T1, transmission_type: 4, count: 4 },
  ],
};

/** Opacity of the group wrapping a type's bar segments (the hover-emphasis layer). */
function opacityOf(key: string): string[] {
  return barsOf(key).map((p) => p.parentElement!.getAttribute("opacity") ?? "1");
}

/** Filled bar paths of one colour inside the time chart (not legend swatches, which are spans). */
function barsOf(key: string): Element[] {
  return [...document.querySelectorAll("svg path")].filter(
    (p) => p.getAttribute("fill") === color(key) && p.getAttribute("d"),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("DBHistoryAnalytics — rendered stacked histogram", () => {
  beforeEach(() => localStorage.clear());

  it("draws a segment per type per bucket", async () => {
    render(<DBHistoryAnalytics {...props} />);
    await settle();
    expect(barsOf("t3").length).toBe(2);
    expect(barsOf("t4").length).toBe(2);
  });

  it("removes a type's segments when its legend entry is clicked, and restores them", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...props} />);
    await settle();
    await user.click(screen.getByTestId("dbhist-type-legend-t4"));
    await settle();
    expect(barsOf("t4").length).toBe(0);
    expect(barsOf("t3").length).toBe(2);
    await user.click(screen.getByTestId("dbhist-type-legend-t4"));
    await settle();
    expect(barsOf("t4").length).toBe(2);
  });

  it("hovering a legend entry or a bar changes nothing: the legend filters, it does not highlight", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...props} />);
    await settle();
    await user.hover(screen.getByTestId("dbhist-type-legend-t4"));
    await user.hover(barsOf("t3")[0]);
    expect(opacityOf("t3")).toEqual(["1", "1"]);
    expect(opacityOf("t4")).toEqual(["1", "1"]);
  });

  it("after hiding a type, the remaining types stay at full strength", async () => {
    const user = userEvent.setup();
    render(<DBHistoryAnalytics {...props} />);
    await settle();
    await user.click(screen.getByTestId("dbhist-type-legend-t4"));
    await settle();
    expect(barsOf("t4")).toHaveLength(0);
    expect(opacityOf("t3")).toEqual(["1", "1"]);
  });
});
