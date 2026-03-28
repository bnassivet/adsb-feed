import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  mockInvokeResponse,
  clearMockResponses,
} from "@/test/mocks/tauri";
import { useEventsOfInterest } from "../useEventsOfInterest";
import type { EventOfInterest } from "@/lib/types";

const sampleEvent: EventOfInterest = {
  id: "evt-1",
  title: "Test Event",
  description: "A test",
  timestamp_ms: 1000,
  end_timestamp_ms: null,
  latitude: 45.5,
  longitude: -73.6,
  bbox_north: null,
  bbox_south: null,
  bbox_east: null,
  bbox_west: null,
  source: "user",
  category: null,
  metadata: null,
  linked_hex_idents: null,
  created_at_ms: 1000,
  updated_at_ms: 1000,
};

describe("useEventsOfInterest", () => {
  beforeEach(() => {
    clearMockResponses();
  });

  it("fetches events on mount", async () => {
    mockInvokeResponse("get_events_of_interest", [sampleEvent]);

    const { result } = renderHook(() => useEventsOfInterest());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].title).toBe("Test Event");
    expect(result.current.error).toBeNull();
  });

  it("createEvent triggers refresh", async () => {
    // First call: initial fetch returns empty
    mockInvokeResponse("get_events_of_interest", []);
    mockInvokeResponse("create_event_of_interest", sampleEvent);

    const { result } = renderHook(() => useEventsOfInterest());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.events).toHaveLength(0);

    // After create, the next fetch returns the event
    mockInvokeResponse("get_events_of_interest", [sampleEvent]);

    await act(async () => {
      await result.current.createEvent({
        title: "Test Event",
        description: "A test",
        timestamp_ms: 1000,
      });
    });

    expect(result.current.events).toHaveLength(1);
  });

  it("removeEvent triggers refresh", async () => {
    mockInvokeResponse("get_events_of_interest", [sampleEvent]);

    const { result } = renderHook(() => useEventsOfInterest());

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    // After delete, the next fetch returns empty
    mockInvokeResponse("delete_event_of_interest", undefined);
    mockInvokeResponse("get_events_of_interest", []);

    await act(async () => {
      await result.current.removeEvent("evt-1");
    });

    expect(result.current.events).toHaveLength(0);
  });

  it("handles storage not available gracefully", async () => {
    // Mock invoke to throw "Storage not available"
    mockInvokeResponse("get_events_of_interest", () => {
      throw new Error("Storage not available");
    });

    const { result } = renderHook(() => useEventsOfInterest());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.events).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });
});
