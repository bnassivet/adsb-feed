import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useVoiceInput } from "../useVoiceInput";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock EventSource
class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
}
vi.stubGlobal("EventSource", vi.fn(() => new MockEventSource()));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: backends endpoint returns empty
  mockFetch.mockResolvedValue({
    json: () => Promise.resolve({ backends: {} }),
  });
});

describe("useVoiceInput", () => {
  it("initializes with default state", () => {
    const { result } = renderHook(() => useVoiceInput());
    expect(result.current.backend).toBe("voxtral");
    expect(result.current.isListening).toBe(false);
    expect(result.current.transcript).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("fetches backends on mount", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          backends: {
            voxtral: { name: "voxtral", status: "ready", description: "STT", supports_end_to_end: false, model_size: "8.9 GB" },
          },
        }),
    });

    const { result } = renderHook(() => useVoiceInput());

    await waitFor(() => {
      expect(result.current.backends).toHaveProperty("voxtral");
    });
    expect(result.current.backends.voxtral.status).toBe("ready");
  });

  it("starts listening and opens EventSource", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/backends")) {
        return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
      }
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening", backend: "voxtral" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(() => useVoiceInput());

    await act(async () => {
      await result.current.startListening();
    });

    expect(result.current.isListening).toBe(true);
    expect(EventSource).toHaveBeenCalledWith("http://localhost:8000/voice/transcript");
  });

  it("stops listening and closes EventSource", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      if (typeof url === "string" && url.includes("/voice/stop")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "stopped" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());

    await act(async () => {
      await result.current.startListening();
    });
    expect(result.current.isListening).toBe(true);

    await act(async () => {
      await result.current.stopListening();
    });
    expect(result.current.isListening).toBe(false);
  });

  it("sets error when start fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({
          json: () => Promise.resolve({ error: "Voxtral not ready" }),
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());

    await act(async () => {
      await result.current.startListening();
    });

    expect(result.current.isListening).toBe(false);
    expect(result.current.error).toBe("Voxtral not ready");
  });

  it("toggleListening toggles between start and stop", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      if (typeof url === "string" && url.includes("/voice/stop")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "stopped" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());

    // Toggle on
    await act(async () => {
      await result.current.toggleListening();
    });
    expect(result.current.isListening).toBe(true);

    // Toggle off
    await act(async () => {
      await result.current.toggleListening();
    });
    expect(result.current.isListening).toBe(false);
  });

  it("can switch backend", () => {
    const { result } = renderHook(() => useVoiceInput());
    expect(result.current.backend).toBe("voxtral");

    act(() => {
      result.current.setBackend("lfm2-audio");
    });
    expect(result.current.backend).toBe("lfm2-audio");
  });
});
