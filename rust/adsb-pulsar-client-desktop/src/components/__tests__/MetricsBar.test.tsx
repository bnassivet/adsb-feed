import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetricsBar } from "../MetricsBar";
import type { MetricsWithRates } from "@/hooks/useMetrics";

function makeMetrics(overrides: Partial<MetricsWithRates> = {}): MetricsWithRates {
  return {
    messages_sent: 1000,
    messages_received: 5000,
    errors: 0,
    bytes_received: 524288,
    bytes_sent: 262144,
    retry_queue_size: 0,
    elapsed_secs: 120,
    throughput_msg_per_sec: 8.3,
    hits_per_sec: 41.7,
    ...overrides,
  };
}

describe("MetricsBar", () => {
  it("renders all metric values including hits/s", () => {
    render(<MetricsBar metrics={makeMetrics()} />);
    expect(screen.getByText("8.3")).toBeInTheDocument();
    expect(screen.getByText("41.7")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    expect(screen.getByText("512.0 KB")).toBeInTheDocument();
  });

  it("renders hits/s label", () => {
    render(<MetricsBar metrics={makeMetrics()} />);
    expect(screen.getByText("hits/s:")).toBeInTheDocument();
  });

  it("shows errors in red when > 0", () => {
    const { container } = render(<MetricsBar metrics={makeMetrics({ errors: 5 })} />);
    const errorEl = container.querySelector(".text-red-400");
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toBe("5");
  });

  it("shows retry queue in yellow when > 0", () => {
    const { container } = render(<MetricsBar metrics={makeMetrics({ retry_queue_size: 10 })} />);
    const queueEl = container.querySelector(".text-yellow-400");
    expect(queueEl).not.toBeNull();
    expect(queueEl!.textContent).toBe("10");
  });

  it("shows normal styling when zero errors", () => {
    const { container } = render(<MetricsBar metrics={makeMetrics({ errors: 0 })} />);
    const redEl = container.querySelector(".text-red-400");
    expect(redEl).toBeNull();
  });

  it("does not render recording indicators when props are omitted", () => {
    render(<MetricsBar metrics={makeMetrics()} />);
    expect(screen.queryByText("REC Pos")).toBeNull();
    expect(screen.queryByText("REC Raw")).toBeNull();
  });

  it("renders recording indicators when props are provided", () => {
    render(
      <MetricsBar
        metrics={makeMetrics()}
        recordPositions={true}
        recordRaw={false}
        onToggleRecordPositions={() => {}}
        onToggleRecordRaw={() => {}}
      />
    );
    expect(screen.getByText("REC Pos")).toBeInTheDocument();
    expect(screen.getByText("REC Raw")).toBeInTheDocument();
  });

  it("shows red styling when recording is ON", () => {
    const { container } = render(
      <MetricsBar
        metrics={makeMetrics()}
        recordPositions={true}
        recordRaw={true}
        onToggleRecordPositions={() => {}}
        onToggleRecordRaw={() => {}}
      />
    );
    const redDots = container.querySelectorAll(".bg-red-500");
    expect(redDots.length).toBe(2);
  });

  it("shows grey styling when recording is OFF", () => {
    const { container } = render(
      <MetricsBar
        metrics={makeMetrics()}
        recordPositions={false}
        recordRaw={false}
        onToggleRecordPositions={() => {}}
        onToggleRecordRaw={() => {}}
      />
    );
    const greyDots = container.querySelectorAll(".bg-slate-600");
    expect(greyDots.length).toBe(2);
    expect(container.querySelectorAll(".bg-red-500").length).toBe(0);
  });

  it("calls toggle callbacks on click", async () => {
    const user = userEvent.setup();
    const onTogglePos = vi.fn();
    const onToggleRaw = vi.fn();

    render(
      <MetricsBar
        metrics={makeMetrics()}
        recordPositions={true}
        recordRaw={true}
        onToggleRecordPositions={onTogglePos}
        onToggleRecordRaw={onToggleRaw}
      />
    );

    await user.click(screen.getByText("REC Pos"));
    expect(onTogglePos).toHaveBeenCalledOnce();

    await user.click(screen.getByText("REC Raw"));
    expect(onToggleRaw).toHaveBeenCalledOnce();
  });
});
