import { describe, it, expect } from "vitest";
import { heightAboveGroundFt, groundQueryKey, groundQueryPoint, describeHere, M_TO_FT } from "../terrain";

describe("heightAboveGroundFt", () => {
  it("subtracts the ground, in feet", () => {
    expect(heightAboveGroundFt(5000, 1000)).toBe(Math.round(5000 - 1000 * M_TO_FT));
  });
  it("measures from the sea surface at sea or below sea level", () => {
    expect(heightAboveGroundFt(1500, 0)).toBe(1500);
    expect(heightAboveGroundFt(1500, -4)).toBe(1500);
  });
});

describe("groundQueryKey", () => {
  it("is the same within ~200 m and changes beyond", () => {
    expect(groundQueryKey(47.2001, -1.5004)).toBe(groundQueryKey(47.2009, -1.5009));
    expect(groundQueryKey(47.2001, -1.5)).not.toBe(groundQueryKey(47.2041, -1.5));
  });
  it("maps back to the cell centre, within ~100 m of the point", () => {
    const p = groundQueryPoint(groundQueryKey(47.2009, -1.5009));
    expect(Math.abs(p.lat - 47.2009)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(p.lng - -1.5009)).toBeLessThanOrEqual(0.001);
  });
});

describe("describeHere", () => {
  it("gives the ground height in metres and feet", () => {
    expect(describeHere({ elevationM: 4780.4, elevationError: null, depth: null, depthError: null })).toEqual([
      "Ground 4,780 m (15,684 ft)",
    ]);
  });

  it("gives the depth with its range at sea", () => {
    expect(describeHere({
      elevationM: 0, elevationError: null,
      depth: { avgM: -22.68, minM: -23.24, maxM: -22.01 }, depthError: null,
    })).toEqual(["Sea depth 22.7 m (22.0–23.2 m)"]);
  });

  it("says sea level when there is neither height nor depth", () => {
    expect(describeHere({ elevationM: 0, elevationError: null, depth: null, depthError: null })).toEqual(["Sea level"]);
  });

  it("shows both on a coast, and each failure on its own", () => {
    expect(describeHere({
      elevationM: 3, elevationError: null, depth: { avgM: -1.5, minM: null, maxM: null }, depthError: null,
    })).toEqual(["Ground 3 m (10 ft)", "Sea depth 1.5 m"]);
    expect(describeHere({ elevationM: null, elevationError: "HTTP 503", depth: null, depthError: "EMODnet: timeout" })).toEqual([
      "Ground height unavailable: HTTP 503",
      "Sea depth unavailable: EMODnet: timeout",
    ]);
  });
});
