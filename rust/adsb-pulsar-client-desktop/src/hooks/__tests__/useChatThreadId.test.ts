import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatThreadId } from "../useChatThreadId";

describe("useChatThreadId", () => {
  it("returns undefined threadId while closed", () => {
    const { result } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    expect(result.current.threadId).toBeUndefined();
  });

  it("mints a value on false→true transition", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    expect(result.current.threadId).toBeUndefined();

    rerender({ open: true });
    expect(typeof result.current.threadId).toBe("string");
    expect(result.current.threadId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the same id across rerenders while open", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    rerender({ open: true });
    const first = result.current.threadId;

    rerender({ open: true });
    expect(result.current.threadId).toBe(first);
  });

  it("mints a new id on the next false→true transition", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    rerender({ open: true });
    const first = result.current.threadId;

    rerender({ open: false });
    expect(result.current.threadId).toBeUndefined();

    rerender({ open: true });
    expect(result.current.threadId).toBeDefined();
    expect(result.current.threadId).not.toBe(first);
  });

  it("produces UUID v7 (version nibble = 7)", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    rerender({ open: true });
    expect(result.current.threadId?.charAt(14)).toBe("7");
  });

  it("resetThread mints a new id while the panel stays open", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    rerender({ open: true });
    const first = result.current.threadId;
    expect(first).toBeDefined();

    act(() => {
      result.current.resetThread();
    });

    expect(result.current.threadId).toBeDefined();
    expect(result.current.threadId).not.toBe(first);
    expect(result.current.threadId?.charAt(14)).toBe("7");
  });

  it("resetThread is a no-op when the panel is closed", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    expect(result.current.threadId).toBeUndefined();

    act(() => {
      result.current.resetThread();
    });

    // Stays undefined — no thread when closed
    expect(result.current.threadId).toBeUndefined();

    rerender({ open: true });
    expect(result.current.threadId).toBeDefined();
  });
});
