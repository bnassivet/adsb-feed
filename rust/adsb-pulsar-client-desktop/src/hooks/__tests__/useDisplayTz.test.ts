import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDisplayTz } from "@/hooks/useDisplayTz";

vi.mock("@/lib/commands", () => ({
  getConfig: vi.fn().mockResolvedValue({ dump1090_tz: "Europe/Paris" }),
}));

// Clear localStorage between tests
beforeEach(() => {
  localStorage.clear();
});

describe("useDisplayTz", () => {
  it("defaults to local mode", () => {
    const { result } = renderHook(() => useDisplayTz());
    expect(result.current.tzMode).toBe("local");
  });

  it("setTzMode persists to localStorage", () => {
    const { result } = renderHook(() => useDisplayTz());
    act(() => result.current.setTzMode("utc"));
    expect(result.current.tzMode).toBe("utc");
    expect(localStorage.getItem("adsb-display-tz")).toContain("utc");
  });

  it("formatTime returns a non-empty string for local mode", () => {
    const { result } = renderHook(() => useDisplayTz());
    const str = result.current.formatTime(Date.now());
    expect(typeof str).toBe("string");
    expect(str.length).toBeGreaterThan(0);
  });

  it("resolvedTzName is undefined in local mode", () => {
    const { result } = renderHook(() => useDisplayTz());
    expect(result.current.resolvedTzName).toBeUndefined();
  });

  it("resolvedTzName is 'UTC' in utc mode", () => {
    const { result } = renderHook(() => useDisplayTz());
    act(() => result.current.setTzMode("utc"));
    expect(result.current.resolvedTzName).toBe("UTC");
  });
});
