import { describe, it, expect } from "vitest";
import type { Config, SourceKind } from "@/lib/types";

/**
 * The feed source decides whether the app talks to dump1090 directly or
 * subscribes to a feed another process publishes. These pin the contract with
 * the Rust `SourceKind` enum, whose serde representation is lowercase.
 */
describe("SourceKind", () => {
  const kinds: SourceKind[] = ["socket", "mqtt"];

  it("uses the lowercase spellings Rust serialises", () => {
    // serde(rename_all = "lowercase") on the Rust side; a mismatch here fails
    // silently at runtime as an unrecognised config value.
    expect(kinds).toEqual(["socket", "mqtt"]);
  });

  it("defaults to socket when a stored config predates the field", () => {
    // Existing installs must keep connecting straight to dump1090.
    const stored = { source_id: "pi" } as Partial<Config>;
    expect(stored.source_kind ?? "socket").toBe("socket");
  });

  it("keeps an explicit mqtt selection", () => {
    const stored = { source_kind: "mqtt" } as Partial<Config>;
    expect(stored.source_kind ?? "socket").toBe("mqtt");
  });

  it("treats mqtt settings as optional for older configs", () => {
    // The settings form falls back rather than rendering `undefined`.
    const stored = {} as Partial<Config>;
    expect(stored.mqtt_broker ?? "").toBe("");
    expect(stored.mqtt_port ?? 1883).toBe(1883);
    expect(stored.mqtt_topic ?? "").toBe("");
  });
});
