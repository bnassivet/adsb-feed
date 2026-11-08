import { afterEach, describe, expect, it, vi } from "vitest";
import { recordStoreFailure, resetStoreHealth, storeHealth, subscribeStoreHealth } from "../health";

afterEach(() => resetStoreHealth());

describe("tile store health", () => {
  it("starts clean", () => {
    expect(storeHealth()).toEqual({ failures: 0, last: null });
  });

  it("counts write failures and keeps the last one, by name", () => {
    recordStoreFailure(new Error("boom"));
    recordStoreFailure(new DOMException("disk full", "QuotaExceededError"));
    const h = storeHealth();
    expect(h.failures).toBe(2);
    expect(h.last).toMatchObject({ name: "QuotaExceededError", message: "disk full" });
    expect(h.last?.at).toBeTypeOf("number");
  });

  it("returns the same snapshot until something changes (useSyncExternalStore)", () => {
    const a = storeHealth();
    expect(storeHealth()).toBe(a);
    recordStoreFailure("x");
    expect(storeHealth()).not.toBe(a);
  });

  it("notifies subscribers, until they unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStoreHealth(listener);
    recordStoreFailure("x");
    unsubscribe();
    recordStoreFailure("y");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
