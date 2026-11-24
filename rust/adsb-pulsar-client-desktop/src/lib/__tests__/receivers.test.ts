import { describe, it, expect } from "vitest";
import { pickReceiver, resolveReceiverLocation } from "@/lib/receivers";
import type { ReceiverSummary } from "@/lib/types";

function rx(source_id: string, lat: number | null): ReceiverSummary {
  return {
    source_id,
    name: null,
    first_seen_ms: 0,
    current:
      lat == null
        ? null
        : {
            valid_from_ms: 0,
            valid_to_ms: null,
            position: { latitude: lat, longitude: -2.3, altitude_ft: 20 },
            origin: "config",
            recorded_at_ms: 0,
            note: null,
          },
    period_count: lat == null ? 0 : 1,
  };
}

const SETTINGS = { lat: 10, lng: 20, alt: 5 };

describe("pickReceiver", () => {
  const all = [rx("pi-a", 46.7), rx("pi-b", 47.2), rx("quiet", null)];

  it("prefers the selection, then this app's own, then the only located one", () => {
    expect(pickReceiver(all, "pi-b", "pi-a")?.source_id).toBe("pi-b");
    expect(pickReceiver(all, null, "pi-a")?.source_id).toBe("pi-a");
    expect(pickReceiver([rx("quiet", null), rx("pi-b", 47.2)], null, "me")?.source_id).toBe("pi-b");
  });

  it("ignores a selection the database no longer has", () => {
    expect(pickReceiver(all, "gone", "pi-a")?.source_id).toBe("pi-a");
  });

  it("finds nothing in an empty database", () => {
    expect(pickReceiver([], "pi-a", "pi-a")).toBeNull();
  });
});

describe("resolveReceiverLocation", () => {
  it("takes the database location over Settings", () => {
    expect(resolveReceiverLocation([rx("pi-a", 46.7)], null, "pi-a", SETTINGS)).toEqual({
      sourceId: "pi-a",
      location: { lat: 46.7, lng: -2.3, alt: 20 },
      source: "database",
    });
  });

  it("falls back to Settings when the database has no location", () => {
    expect(resolveReceiverLocation([], null, "pi-a", SETTINGS)).toEqual({
      sourceId: "pi-a",
      location: SETTINGS,
      source: "settings",
    });
    expect(
      resolveReceiverLocation([rx("pi-a", null)], null, "pi-a", SETTINGS).source
    ).toBe("settings");
  });

  it("never lends this app's Settings location to another receiver", () => {
    const out = resolveReceiverLocation(
      [rx("pi-a", 46.7), rx("quiet", null)],
      "quiet",
      "pi-a",
      SETTINGS
    );
    expect(out).toEqual({ sourceId: "quiet", location: undefined, source: null });
  });

  it("knows nothing without a database location or Settings", () => {
    expect(resolveReceiverLocation([], null, null, undefined)).toEqual({
      sourceId: null,
      location: undefined,
      source: null,
    });
  });
});
