import { describe, it, expect, beforeEach } from "vitest";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import {
  listReceivers,
  getReceiverLocations,
  applyReceiverChange,
} from "@/lib/commands";
import type { LocationPeriod, ReceiverSummary } from "@/lib/types";

const PERIOD: LocationPeriod = {
  valid_from_ms: 1_000,
  valid_to_ms: null,
  position: { latitude: 46.7, longitude: -2.3, altitude_ft: 20 },
  origin: "config",
  recorded_at_ms: 1_005,
  note: null,
};

describe("receiver commands", () => {
  beforeEach(() => clearMockResponses());

  it("lists receivers", async () => {
    const receivers: ReceiverSummary[] = [
      { source_id: "pi-a", name: null, first_seen_ms: 1_000, current: PERIOD, period_count: 1 },
    ];
    mockInvokeResponse("list_receivers", receivers);
    expect(await listReceivers()).toEqual(receivers);
  });

  it("asks for one receiver's history by id", async () => {
    let sent: unknown;
    mockInvokeResponse("get_receiver_locations", (args: unknown) => {
      sent = args;
      return [PERIOD];
    });
    expect(await getReceiverLocations("pi-a")).toEqual([PERIOD]);
    expect(sent).toEqual({ sourceId: "pi-a" });
  });

  it("sends a change in the backend's tagged shape, with its note", async () => {
    let sent: unknown;
    mockInvokeResponse("apply_receiver_change", (args: unknown) => {
      sent = args;
      return [PERIOD];
    });
    const out = await applyReceiverChange(
      "pi-a",
      { kind: "move", position: PERIOD.position, at_ms: 5_000 },
      "moved to the roof"
    );
    expect(out).toEqual([PERIOD]);
    expect(sent).toEqual({
      sourceId: "pi-a",
      change: { kind: "move", position: PERIOD.position, at_ms: 5_000 },
      note: "moved to the roof",
    });
  });

  it("passes a no-op back as null", async () => {
    mockInvokeResponse("apply_receiver_change", null);
    expect(
      await applyReceiverChange("pi-a", { kind: "remove", valid_from_ms: 1_000 })
    ).toBeNull();
  });
});
