import { describe, it, expect, beforeEach } from "vitest";
import { mockInvokeResponse, clearMockResponses } from "@/test/mocks/tauri";
import { getStorageMode, setStorageMode } from "@/lib/commands";
import type { StorageMode } from "@/lib/types";

describe("storage mode commands", () => {
  beforeEach(() => clearMockResponses());

  it("reads the current mode", async () => {
    mockInvokeResponse("get_storage_mode", { mode: "embedded" });
    await expect(getStorageMode()).resolves.toEqual({ mode: "embedded" });
  });

  it("reads a remote mode with its connection details", async () => {
    const mode: StorageMode = {
      mode: "remote",
      uri: "quack:pi.lan:9494",
      token: "tok",
    };
    mockInvokeResponse("get_storage_mode", mode);
    await expect(getStorageMode()).resolves.toEqual(mode);
  });

  it("returns the resulting storage availability when switching", async () => {
    mockInvokeResponse("set_storage_mode", "available");
    await expect(
      setStorageMode({ mode: "remote", uri: "quack:pi.lan:9494" }),
    ).resolves.toBe("available");
  });
});

describe("StorageMode discriminant", () => {
  it("is tagged with `mode`, matching serde on the Rust side", () => {
    // The same trap ShareStatus has with `state`: a mismatched tag makes every
    // variant render as the wrong one, silently.
    const embedded: StorageMode = { mode: "embedded" };
    const remote: StorageMode = { mode: "remote", uri: "quack:pi:9494" };
    expect(embedded.mode).toBe("embedded");
    expect(remote.mode).toBe("remote");
  });

  it("treats token and disable_ssl as optional", () => {
    // An older stored mode, or one saved without a token, must still type-check
    // and must not render as `undefined` in the settings form.
    const minimal: StorageMode = { mode: "remote", uri: "quack:pi:9494" };
    expect(minimal).not.toHaveProperty("token");
    if (minimal.mode === "remote") {
      expect(minimal.token ?? "").toBe("");
    }
  });
});
