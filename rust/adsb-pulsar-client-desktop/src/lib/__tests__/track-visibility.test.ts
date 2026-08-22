import { describe, it, expect } from "vitest";
import { toggleScopedVisibility } from "@/lib/track-visibility";

describe("toggleScopedVisibility", () => {
  it("hides all given hexes when none are hidden", () => {
    expect(toggleScopedVisibility(undefined, ["A", "B"])).toEqual(new Set(["A", "B"]));
  });

  it("hides the rest when only some are hidden", () => {
    expect(toggleScopedVisibility(new Set(["A"]), ["A", "B"])).toEqual(new Set(["A", "B"]));
  });

  it("reveals them all when every one is already hidden", () => {
    expect(toggleScopedVisibility(new Set(["A", "B"]), ["A", "B"])).toBeUndefined();
  });

  /*
   * The reason this function exists. The Simulation panel's trajectories are a
   * subset of the live section, so toggling them must not disturb an aircraft
   * hidden from the aircraft table.
   */
  it("leaves hexes outside its scope alone when hiding", () => {
    const out = toggleScopedVisibility(new Set(["OTHER"]), ["A", "B"]);
    expect(out).toEqual(new Set(["OTHER", "A", "B"]));
  });

  it("leaves hexes outside its scope alone when revealing", () => {
    const out = toggleScopedVisibility(new Set(["OTHER", "A", "B"]), ["A", "B"]);
    expect(out).toEqual(new Set(["OTHER"]));
  });

  it("returns undefined rather than an empty set, so the key can be dropped", () => {
    expect(toggleScopedVisibility(new Set(["A"]), ["A"])).toBeUndefined();
  });

  it("does not mutate the set it is given", () => {
    const before = new Set(["A"]);
    toggleScopedVisibility(before, ["B"]);
    expect(before).toEqual(new Set(["A"]));
  });

  it("is a no-op for an empty scope", () => {
    expect(toggleScopedVisibility(new Set(["A"]), [])).toEqual(new Set(["A"]));
  });
});
