import { vi } from "vitest";

/** Mock responses keyed by command name. */
const mockResponses = new Map<string, unknown>();

/** Configure a mock response for a specific Tauri invoke command. */
export function mockInvokeResponse(command: string, response: unknown): void {
  mockResponses.set(command, response);
}

/** Clear all mock invoke responses. */
export function clearMockResponses(): void {
  mockResponses.clear();
}

/** Event listeners registered via listen(). */
type UnlistenFn = () => void;
type EventCallback = (event: { payload: unknown }) => void;
const eventListeners = new Map<string, EventCallback[]>();

/** Simulate a Tauri event from the backend. */
export function emitMockEvent(event: string, payload: unknown): void {
  const listeners = eventListeners.get(event) ?? [];
  for (const cb of listeners) {
    cb({ payload });
  }
}

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (mockResponses.has(command)) {
      const response = mockResponses.get(command);
      return typeof response === "function" ? response(args) : response;
    }
    throw new Error(`No mock response for invoke("${command}")`);
  }),
}));

// Mock @tauri-apps/api/event
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: EventCallback): Promise<UnlistenFn> => {
    if (!eventListeners.has(event)) {
      eventListeners.set(event, []);
    }
    eventListeners.get(event)!.push(handler);

    return () => {
      const listeners = eventListeners.get(event);
      if (listeners) {
        const idx = listeners.indexOf(handler);
        if (idx >= 0) listeners.splice(idx, 1);
      }
    };
  }),
}));
