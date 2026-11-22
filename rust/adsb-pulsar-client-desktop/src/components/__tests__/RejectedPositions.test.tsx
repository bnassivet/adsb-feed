import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { RejectedPositions } from "../RejectedPositions";
import type { RejectedPositionPage } from "@/lib/types";

const fmt = (ms: number) => `t${ms}`;

const page: RejectedPositionPage = {
  total: 3,
  rows: [
    {
      hex_ident: "4CAE9A", callsign: "AFR123", latitude: 83.72, longitude: 58.2138,
      altitude: 39000, timestamp_ms: 2000, source_id: "dev",
      reason: "out_of_range", distance_nm: 2402.3, rejected_at_ms: 9000,
      implied_speed_kt: null,
    },
    {
      hex_ident: "4CA912", callsign: null, latitude: 48.1, longitude: -4.5,
      altitude: null, timestamp_ms: 1000, source_id: "dev",
      reason: "implausible_speed", distance_nm: null, rejected_at_ms: 9000,
      implied_speed_kt: 39102.7,
    },
  ],
};

describe("RejectedPositions", () => {
  beforeEach(() => clearMockResponses());

  it("lists rows with time, identity, position, distance and reason", async () => {
    mockInvokeResponse("get_rejected_positions", page);
    render(<RejectedPositions startMs={0} endMs={5000} formatTime={fmt} />);

    const rows = await screen.findAllByTestId("rejected-row");
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByText("t2000")).toBeInTheDocument();
    expect(first.getByText("AFR123")).toBeInTheDocument();
    expect(first.getByText("4CAE9A")).toBeInTheDocument();
    expect(first.getByText("83.7200, 58.2138")).toBeInTheDocument();
    expect(first.getByText("39,000")).toBeInTheDocument();
    expect(first.getByText("2402")).toBeInTheDocument();
    expect(first.getByText("Out of range")).toBeInTheDocument();

    const second = within(rows[1]);
    expect(second.getByText("Impossible speed")).toBeInTheDocument();
    expect(second.getAllByText("—").length).toBeGreaterThanOrEqual(2); // altitude, distance
  });

  it("says when only part of the total is shown", async () => {
    mockInvokeResponse("get_rejected_positions", page);
    render(<RejectedPositions startMs={0} endMs={5000} formatTime={fmt} />);
    expect(await screen.findByTestId("rejected-count")).toHaveTextContent("2 of 3");
  });

  it("renders an empty state", async () => {
    mockInvokeResponse("get_rejected_positions", { total: 0, rows: [] });
    render(<RejectedPositions startMs={0} endMs={5000} formatTime={fmt} />);
    expect(await screen.findByTestId("rejected-empty")).toHaveTextContent(
      "No rejected positions"
    );
  });

  it("shows the error when the query fails", async () => {
    // No mock response: invoke throws, as for a daemon without the table.
    render(<RejectedPositions startMs={0} endMs={5000} formatTime={fmt} />);
    expect(await screen.findByTestId("rejected-error")).toHaveTextContent(
      "get_rejected_positions"
    );
  });

  it("gives the implied speed of a speed reject", async () => {
    mockInvokeResponse("get_rejected_positions", page);
    render(<RejectedPositions startMs={0} endMs={5000} formatTime={fmt} />);
    const rows = await screen.findAllByTestId("rejected-row");
    expect(within(rows[1]).getByTestId("rejected-speed")).toHaveTextContent("39,103");
    expect(within(rows[0]).getByTestId("rejected-speed")).toHaveTextContent("—");
  });

  describe("show on the map", () => {
    async function setup(shown = [] as typeof page.rows) {
      mockInvokeResponse("get_rejected_positions", page);
      const onShownChange = vi.fn();
      const user = userEvent.setup();
      render(
        <RejectedPositions
          startMs={0}
          endMs={5000}
          formatTime={fmt}
          shown={shown}
          onShownChange={onShownChange}
        />
      );
      const rows = await screen.findAllByTestId("rejected-row");
      return { onShownChange, user, rows };
    }

    it("toggles one row with its eye", async () => {
      const { onShownChange, user, rows } = await setup();
      await user.click(within(rows[1]).getByRole("button", { name: /show on map/i }));
      expect(onShownChange).toHaveBeenLastCalledWith([page.rows[1]]);
    });

    it("an eye reflects what is shown and hides it again", async () => {
      const { onShownChange, user, rows } = await setup([page.rows[0]]);
      const eye = within(rows[0]).getByRole("button", { name: /hide from map/i });
      expect(eye).toHaveAttribute("aria-pressed", "true");
      await user.click(eye);
      expect(onShownChange).toHaveBeenLastCalledWith([]);
    });

    it("shows and hides all rows", async () => {
      const { onShownChange, user } = await setup();
      await user.click(screen.getByRole("button", { name: "Show all" }));
      expect(onShownChange).toHaveBeenLastCalledWith(page.rows);
      await user.click(screen.getByRole("button", { name: "Hide all" }));
      expect(onShownChange).toHaveBeenLastCalledWith([]);
    });

    it("shows and hides only the selected rows", async () => {
      const { onShownChange, user, rows } = await setup();
      const showSelected = screen.getByRole("button", { name: "Show selected" });
      expect(showSelected).toBeDisabled();

      await user.click(within(rows[1]).getByRole("checkbox"));
      await user.click(showSelected);
      expect(onShownChange).toHaveBeenLastCalledWith([page.rows[1]]);
    });

    it("selects every row from the header checkbox", async () => {
      const { onShownChange, user } = await setup();
      await user.click(screen.getByRole("checkbox", { name: /select all/i }));
      await user.click(screen.getByRole("button", { name: "Show selected" }));
      expect(onShownChange).toHaveBeenLastCalledWith(page.rows);
    });
  });
});
