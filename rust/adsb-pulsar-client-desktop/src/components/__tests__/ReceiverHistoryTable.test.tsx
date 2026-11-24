import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import { ReceiverHistoryTable } from "../ReceiverHistoryTable";
import type { LocationPeriod } from "@/lib/types";

const FIRST: LocationPeriod = {
  valid_from_ms: Date.UTC(2026, 9, 1),
  valid_to_ms: Date.UTC(2026, 10, 1),
  position: { latitude: 46.7, longitude: -2.3, altitude_ft: 20 },
  origin: "backfill",
  recorded_at_ms: 0,
  note: null,
};
const SECOND: LocationPeriod = {
  valid_from_ms: Date.UTC(2026, 10, 1),
  valid_to_ms: null,
  position: { latitude: 47.2, longitude: -1.55, altitude_ft: null },
  origin: "config",
  recorded_at_ms: 0,
  note: "roof",
};

/** Records every apply_receiver_change call and answers with `reply`. */
function recordChanges(reply: LocationPeriod[] | null = [FIRST, SECOND]) {
  const sent: unknown[] = [];
  mockInvokeResponse("apply_receiver_change", (args: unknown) => {
    sent.push(args);
    return reply;
  });
  return sent;
}

describe("ReceiverHistoryTable", () => {
  beforeEach(() => {
    clearMockResponses();
    mockInvokeResponse("get_receiver_locations", [FIRST, SECOND]);
  });

  it("lists the periods, oldest first, with the current one marked", async () => {
    render(<ReceiverHistoryTable sourceId="pi-a" />);
    const rows = await screen.findAllByTestId("receiver-period");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("46.700000");
    expect(rows[0]).toHaveTextContent("backfill");
    expect(rows[1]).toHaveTextContent("current");
    expect(rows[1]).toHaveTextContent("roof");
  });

  it("explains an empty history", async () => {
    mockInvokeResponse("get_receiver_locations", []);
    render(<ReceiverHistoryTable sourceId="pi-a" />);
    expect(await screen.findByText(/no location history/i)).toBeInTheDocument();
  });

  it("records a back-dated move", async () => {
    const sent = recordChanges();
    const user = userEvent.setup();
    render(<ReceiverHistoryTable sourceId="pi-a" />);
    await screen.findAllByTestId("receiver-period");

    await user.type(screen.getByLabelText("New latitude"), "48.1");
    await user.type(screen.getByLabelText("New longitude"), "-1.6");
    await user.type(screen.getByLabelText("Moved at"), "2026-10-15T08:30");
    await user.type(screen.getByLabelText("Note"), "new mast");
    await user.click(screen.getByRole("button", { name: "Record move" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      sourceId: "pi-a",
      change: {
        kind: "move",
        position: { latitude: 48.1, longitude: -1.6, altitude_ft: null },
        at_ms: new Date("2026-10-15T08:30").getTime(),
      },
      note: "new mast",
    });
  });

  it("corrects one period in place", async () => {
    const sent = recordChanges();
    const user = userEvent.setup();
    render(<ReceiverHistoryTable sourceId="pi-a" />);
    const rows = await screen.findAllByTestId("receiver-period");

    await user.click(within(rows[0]).getByRole("button", { name: "Correct" }));
    const lat = screen.getByLabelText("Corrected latitude");
    await user.clear(lat);
    await user.type(lat, "46.75");
    await user.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      sourceId: "pi-a",
      change: {
        kind: "correct",
        valid_from_ms: FIRST.valid_from_ms,
        position: { latitude: 46.75, longitude: -2.3, altitude_ft: 20 },
      },
    });
  });

  it("removes a period", async () => {
    const sent = recordChanges([FIRST]);
    const user = userEvent.setup();
    render(<ReceiverHistoryTable sourceId="pi-a" />);
    const rows = await screen.findAllByTestId("receiver-period");

    await user.click(within(rows[1]).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      change: { kind: "remove", valid_from_ms: SECOND.valid_from_ms },
    });
    await waitFor(() => expect(screen.getAllByTestId("receiver-period")).toHaveLength(1));
  });

  it("shows the rule a refused change broke", async () => {
    mockInvokeResponse("apply_receiver_change", () => {
      throw "a location period already starts at 1792022400000; correct it instead";
    });
    const user = userEvent.setup();
    render(<ReceiverHistoryTable sourceId="pi-a" />);
    await screen.findAllByTestId("receiver-period");

    await user.type(screen.getByLabelText("New latitude"), "48.1");
    await user.type(screen.getByLabelText("New longitude"), "-1.6");
    await user.type(screen.getByLabelText("Moved at"), "2026-11-01T00:00");
    await user.click(screen.getByRole("button", { name: "Record move" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/correct it instead/);
  });

  it("will not send a move without a position and a time", async () => {
    const sent = recordChanges();
    render(<ReceiverHistoryTable sourceId="pi-a" />);
    await screen.findAllByTestId("receiver-period");
    expect(screen.getByRole("button", { name: "Record move" })).toBeDisabled();
    expect(sent).toHaveLength(0);
  });
});
