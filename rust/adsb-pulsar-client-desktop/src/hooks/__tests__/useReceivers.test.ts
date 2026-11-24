import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearMockResponses, mockInvokeResponse } from "@/test/mocks/tauri";
import { useReceivers } from "../useReceivers";
import type { ReceiverSummary } from "@/lib/types";

const PI_A: ReceiverSummary = {
  source_id: "pi-a",
  name: null,
  first_seen_ms: 0,
  current: null,
  period_count: 0,
};

describe("useReceivers", () => {
  beforeEach(() => clearMockResponses());

  it("loads the receivers on mount", async () => {
    mockInvokeResponse("list_receivers", [PI_A]);
    const { result } = renderHook(() => useReceivers());
    await waitFor(() => expect(result.current.receivers).toEqual([PI_A]));
  });

  it("reads unavailable storage as no receivers", async () => {
    mockInvokeResponse("list_receivers", () => {
      throw new Error("Storage not available");
    });
    const { result } = renderHook(() => useReceivers());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.receivers).toEqual([]);
  });

  it("refreshes on demand", async () => {
    let calls = 0;
    mockInvokeResponse("list_receivers", () => {
      calls += 1;
      return calls === 1 ? [] : [PI_A];
    });
    const { result } = renderHook(() => useReceivers());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.receivers).toEqual([PI_A]);
  });

  it("refreshes on its interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      mockInvokeResponse("list_receivers", () => {
        calls += 1;
        return [];
      });
      renderHook(() => useReceivers(1_000));
      await waitFor(() => expect(calls).toBe(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
