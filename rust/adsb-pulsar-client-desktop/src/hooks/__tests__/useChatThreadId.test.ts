import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useChatThreadId } from "../useChatThreadId";

describe("useChatThreadId", () => {
  it("returns undefined while closed", () => {
    const { result } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    expect(result.current).toBeUndefined();
  });

  it("mints a value on false→true transition", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    expect(result.current).toBeUndefined();

    rerender({ open: true });
    expect(typeof result.current).toBe("string");
    expect(result.current).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the same id across rerenders while open", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    rerender({ open: true });
    const first = result.current;

    rerender({ open: true });
    expect(result.current).toBe(first);
  });

  it("mints a new id on the next false→true transition", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    rerender({ open: true });
    const first = result.current;

    rerender({ open: false });
    expect(result.current).toBeUndefined();

    rerender({ open: true });
    expect(result.current).toBeDefined();
    expect(result.current).not.toBe(first);
  });

  it("produces UUID v7 (version nibble = 7)", () => {
    const { result, rerender } = renderHook(({ open }) => useChatThreadId(open), {
      initialProps: { open: false },
    });
    rerender({ open: true });
    // UUID v7 format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx (14th hex char = '7')
    expect(result.current?.charAt(14)).toBe("7");
  });
});
