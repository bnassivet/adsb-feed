import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLocalStorage } from "../useLocalStorage";

describe("useLocalStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns default when localStorage is empty", () => {
    const { result } = renderHook(() => useLocalStorage("test-key", "default"));
    expect(result.current[0]).toBe("default");
  });

  it("reads existing value from localStorage", () => {
    localStorage.setItem("existing-key", JSON.stringify("stored-value"));
    const { result } = renderHook(() => useLocalStorage("existing-key", "default"));
    expect(result.current[0]).toBe("stored-value");
  });

  it("updates localStorage on set", () => {
    const { result } = renderHook(() => useLocalStorage("update-key", "initial"));
    act(() => {
      result.current[1]("updated");
    });
    expect(result.current[0]).toBe("updated");
    expect(JSON.parse(localStorage.getItem("update-key")!)).toBe("updated");
  });

  it("handles JSON parse errors gracefully", () => {
    localStorage.setItem("bad-key", "not-valid-json");
    const { result } = renderHook(() => useLocalStorage("bad-key", "fallback"));
    expect(result.current[0]).toBe("fallback");
  });

  it("works with object values", () => {
    const defaultObj = { a: 1, b: "two" };
    const { result } = renderHook(() => useLocalStorage("obj-key", defaultObj));
    expect(result.current[0]).toEqual(defaultObj);
    act(() => {
      result.current[1]({ a: 2, b: "three" });
    });
    expect(result.current[0]).toEqual({ a: 2, b: "three" });
  });

  it("uses independent storage for different keys", () => {
    const { result: hook1 } = renderHook(() => useLocalStorage("key-1", "val-1"));
    const { result: hook2 } = renderHook(() => useLocalStorage("key-2", "val-2"));
    expect(hook1.current[0]).toBe("val-1");
    expect(hook2.current[0]).toBe("val-2");
  });

  it("keeps every hook on the same key in step (a setting changed in one panel shows in all)", async () => {
    const { result: a } = renderHook(() => useLocalStorage("shared-key", "local"));
    const { result: b } = renderHook(() => useLocalStorage("shared-key", "local"));
    // The others hear of it one microtask later, after the writer's own update.
    await act(async () => a.current[1]("utc"));
    expect(b.current[0]).toBe("utc");
    const { result: other } = renderHook(() => useLocalStorage("other-key", "x"));
    expect(other.current[0]).toBe("x");
  });

  it("follows a change made in another window", () => {
    const { result } = renderHook(() => useLocalStorage("win-key", "local"));
    act(() => {
      localStorage.setItem("win-key", JSON.stringify("utc"));
      window.dispatchEvent(new StorageEvent("storage", { key: "win-key", newValue: JSON.stringify("utc") }));
    });
    expect(result.current[0]).toBe("utc");
  });
});
