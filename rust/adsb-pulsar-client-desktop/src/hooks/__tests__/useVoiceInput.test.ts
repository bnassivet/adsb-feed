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

  it("SSE onerror shows error but does not turn off listening", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening", backend: "voxtral" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());

    await act(async () => {
      await result.current.startListening();
    });
    expect(result.current.isListening).toBe(true);

    // Simulate SSE connection drop
    // Factory returns new MockEventSource() explicitly, so value is in results not instances
    const es = (EventSource as unknown as ReturnType<typeof vi.fn>).mock.results[0].value as MockEventSource;
    act(() => { es.onerror?.(); });

    expect(result.current.isListening).toBe(true);   // button stays on
    expect(result.current.error).toBeTruthy();        // error message shown
  });

  it("forwards threadId as session_id in /voice/start body", async () => {
    const startCalls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        startCalls.push({ url, init });
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput("thread-7"));
    await act(async () => {
      await result.current.startListening();
    });

    expect(startCalls).toHaveLength(1);
    const body = JSON.parse(startCalls[0].init!.body as string);
    expect(body.session_id).toBe("thread-7");
    expect(body.backend).toBe("voxtral");
  });

  it("sends session_id=null when no threadId provided", async () => {
    const startCalls: Array<{ url: string; init?: RequestInit }> = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        startCalls.push({ url, init });
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());
    await act(async () => {
      await result.current.startListening();
    });

    const body = JSON.parse(startCalls[0].init!.body as string);
    expect(body.session_id).toBeNull();
  });

  it("clears the previous finalTranscript when a new recording starts", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      if (typeof url === "string" && url.includes("/voice/stop")) {
        return Promise.resolve({ json: () => Promise.resolve({ transcript: "first" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());

    // First recording: start → stop → final transcript "first" persists.
    await act(async () => {
      await result.current.startListening();
    });
    await act(async () => {
      await result.current.stopListening();
    });
    expect(result.current.finalTranscript).toBe("first");

    // Second recording starts WITHOUT the user dismissing the banner.
    // The stale "first" must clear immediately so the banner disappears.
    await act(async () => {
      await result.current.startListening();
    });
    expect(result.current.isListening).toBe(true);
    expect(result.current.finalTranscript).toBeNull();
  });

  it("clears finalTranscript at the top of stopListening (before the await)", async () => {
    // Real bug: voxtral's /voice/stop drain takes up to ~15s. During that
    // window, the banner kept showing the PREVIOUS recording's transcript.
    // stopListening must clear it the instant it is called, before awaiting.
    let resolveSecondStop!: (v: { json: () => Promise<unknown> }) => void;
    const secondStopPromise = new Promise<{ json: () => Promise<unknown> }>((r) => {
      resolveSecondStop = r;
    });

    let stopCallCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      if (typeof url === "string" && url.includes("/voice/stop")) {
        stopCallCount += 1;
        if (stopCallCount === 1) {
          return Promise.resolve({ json: () => Promise.resolve({ transcript: "previous" }) });
        }
        return secondStopPromise;
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());

    // Seed finalTranscript = "previous" via a normal start/stop round-trip.
    await act(async () => { await result.current.startListening(); });
    await act(async () => { await result.current.stopListening(); });
    expect(result.current.finalTranscript).toBe("previous");

    // Now call stopListening DIRECTLY (without startListening in between)
    // to isolate the stop path. The /voice/stop response is held — but the
    // banner must already be clear from the click itself.
    let stoppingPromise!: Promise<void>;
    act(() => {
      stoppingPromise = result.current.stopListening();
    });
    // Flush microtasks so the synchronous setState at the top of
    // stopListening runs — but do NOT resolve /voice/stop.
    await act(async () => { await Promise.resolve(); });

    // THIS IS THE BUG: today, finalTranscript stays "previous" during the
    // 15-second drain because the only setFinalTranscript call is AFTER
    // the await. It must be null here.
    expect(result.current.finalTranscript).toBeNull();

    // Resolve the response and confirm the new transcript lands.
    await act(async () => {
      resolveSecondStop({ json: () => Promise.resolve({ transcript: "current" }) });
      await stoppingPromise;
    });
    expect(result.current.finalTranscript).toBe("current");
  });

  it("clears finalTranscript synchronously on stop click — before /voice/stop responds", async () => {
    // The user-observed bug: voxtral's /voice/stop drain can take up to ~15s.
    // During that window, the banner must NOT keep showing the previous
    // recording's transcript. It should clear the instant the user clicks
    // stop, then re-populate when the response arrives.
    let resolveStop!: (value: { json: () => Promise<unknown> }) => void;
    const stopResponsePromise = new Promise<{ json: () => Promise<unknown> }>((resolve) => {
      resolveStop = resolve;
    });

    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      if (typeof url === "string" && url.includes("/voice/stop")) {
        return stopResponsePromise;
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());

    // Seed a previous transcript via a normal start/stop round-trip.
    let resolvePrev!: (value: { json: () => Promise<unknown> }) => void;
    const prevStop = new Promise<{ json: () => Promise<unknown> }>((resolve) => {
      resolvePrev = resolve;
    });
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) }),
    );
    mockFetch.mockImplementationOnce(() => prevStop);

    await act(async () => { await result.current.startListening(); });
    const firstStop = act(async () => { await result.current.stopListening(); });
    resolvePrev({ json: () => Promise.resolve({ status: "stopped", transcript: "previous" }) });
    await firstStop;
    expect(result.current.finalTranscript).toBe("previous");

    // Now: user records again, hits stop. Don't resolve /voice/stop yet —
    // simulate the long drain. The banner must clear immediately.
    await act(async () => { await result.current.startListening(); });
    // startListening also clears, so reset finalTranscript via a re-seed
    // to prove stopListening alone can clear it. We use clearFinalTranscript
    // is not what we want — we want to show that even mid-flight, FT clears.
    // Manually invoke stopListening WITHOUT awaiting so we can observe state
    // between the click and the response.
    let stopPromise!: Promise<void>;
    act(() => {
      stopPromise = result.current.stopListening();
    });

    // Drive one microtask flush so React processes the synchronous setState
    // that happens at the top of stopListening — but do NOT resolve the
    // /voice/stop fetch yet.
    await act(async () => { await Promise.resolve(); });

    // The banner must be cleared NOW, before /voice/stop responds.
    expect(result.current.finalTranscript).toBeNull();

    // Now let /voice/stop respond with the new transcript and confirm it lands.
    await act(async () => {
      resolveStop({ json: () => Promise.resolve({ status: "stopped", transcript: "current" }) });
      await stopPromise;
    });
    expect(result.current.finalTranscript).toBe("current");
  });

  it("stopListening clears finalTranscript when backend returns no transcript (independent of start)", async () => {
    // Reproduces the user-observed bug: after a previous successful recording,
    // a new stopListening that returns no transcript must NOT leave the
    // previous transcript on screen.
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/stop")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "stopped" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result, rerender } = renderHook(() => useVoiceInput());

    // Simulate the panel already having a stale final transcript from a
    // previous recording (this is the scenario the user reports).
    await act(async () => {
      // Forcibly populate finalTranscript by calling startListening + stopListening
      // with a mocked transcript would couple to startListening; instead, drive
      // the hook through its public API.
    });

    // Pretend a previous recording left "stale" in finalTranscript by
    // re-mocking the next stop to return it once.
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) }),
    );
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({ json: () => Promise.resolve({ status: "stopped", transcript: "stale" }) }),
    );
    await act(async () => { await result.current.startListening(); });
    await act(async () => { await result.current.stopListening(); });
    expect(result.current.finalTranscript).toBe("stale");

    // Now the user re-records — but this time we ONLY call stopListening,
    // without going through startListening, to isolate the stop path.
    rerender();
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({ json: () => Promise.resolve({ status: "stopped" }) }),
    );
    await act(async () => { await result.current.stopListening(); });
    expect(result.current.finalTranscript).toBeNull();
  });

  it("overwrites a stale finalTranscript when a new recording stops, even if backend returns no transcript", async () => {
    // Sequence the /voice/stop responses: first call returns "first",
    // second call (after a fresh start) returns no transcript at all
    // (e.g. drain skipped, mic silent). The stale "first" must NOT linger.
    let stopCallCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      if (typeof url === "string" && url.includes("/voice/stop")) {
        stopCallCount += 1;
        if (stopCallCount === 1) {
          return Promise.resolve({ json: () => Promise.resolve({ status: "stopped", transcript: "first" }) });
        }
        // Second stop: backend produced nothing.
        return Promise.resolve({ json: () => Promise.resolve({ status: "stopped" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result } = renderHook(() => useVoiceInput());

    // Recording 1: capture "first".
    await act(async () => { await result.current.startListening(); });
    await act(async () => { await result.current.stopListening(); });
    expect(result.current.finalTranscript).toBe("first");

    // Recording 2: backend returns no transcript. The banner must clear,
    // NOT keep showing "first" from the previous recording.
    await act(async () => { await result.current.startListening(); });
    await act(async () => { await result.current.stopListening(); });
    expect(result.current.finalTranscript).toBeNull();
  });

  it("auto-stops listening and clears finalTranscript when threadId changes", async () => {
    const calls: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      calls.push(typeof url === "string" ? url : "");
      if (typeof url === "string" && url.includes("/voice/start")) {
        return Promise.resolve({ json: () => Promise.resolve({ status: "listening" }) });
      }
      if (typeof url === "string" && url.includes("/voice/stop")) {
        return Promise.resolve({ json: () => Promise.resolve({ transcript: "hello" }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { result, rerender } = renderHook(({ tid }) => useVoiceInput(tid), {
      initialProps: { tid: "thread-1" as string | undefined },
    });

    // Start listening on thread-1
    await act(async () => {
      await result.current.startListening();
    });
    expect(result.current.isListening).toBe(true);

    // Stash a final transcript by stopping once (sets finalTranscript = "hello"),
    // then restart so we're listening again with a stale transcript pending.
    await act(async () => {
      await result.current.stopListening();
    });
    expect(result.current.finalTranscript).toBe("hello");
    await act(async () => {
      await result.current.startListening();
    });
    expect(result.current.isListening).toBe(true);

    // Change threadId — should auto-stop and clear pending finalTranscript
    await act(async () => {
      rerender({ tid: "thread-2" });
    });

    await waitFor(() => {
      expect(result.current.isListening).toBe(false);
    });
    expect(result.current.finalTranscript).toBeNull();
    expect(calls.some((u) => u.includes("/voice/stop"))).toBe(true);
  });

  it("does not call /voice/stop when threadId changes while not listening", async () => {
    const stopCalls: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/voice/stop")) {
        stopCalls.push(url);
      }
      return Promise.resolve({ json: () => Promise.resolve({ backends: {} }) });
    });

    const { rerender } = renderHook(({ tid }) => useVoiceInput(tid), {
      initialProps: { tid: "thread-1" as string | undefined },
    });

    await act(async () => {
      rerender({ tid: "thread-2" });
    });

    expect(stopCalls).toHaveLength(0);
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
