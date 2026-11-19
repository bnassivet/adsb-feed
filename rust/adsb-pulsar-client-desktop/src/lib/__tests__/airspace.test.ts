import { describe, it, expect } from "vitest";
import {
  formatLimit,
  limitFeet,
  normalizeAirspace,
  prepareAirspaces,
  airspacesAt,
  verticalStatus,
  airspaceTypes,
  filterByType,
  airspaceStyle,
  airspaceStatus,
  AIRSPACE_ATTRIBUTION,
  DEFAULT_AIRSPACE_OPACITY,
  type CountryAirspaces,
  type OpenAipLimit,
} from "../airspace";

const ft = (value: number, datum = 1): OpenAipLimit => ({ value, unit: 1, referenceDatum: datum });
const fl = (value: number): OpenAipLimit => ({ value, unit: 6, referenceDatum: 2 });
const GND: OpenAipLimit = { value: 0, unit: 1, referenceDatum: 0 };

/** A square ring centred on (lng, lat), half-size `h` degrees, closed as OpenAIP sends it. */
function square(lng: number, lat: number, h: number): number[][][] {
  return [[[lng - h, lat - h], [lng + h, lat - h], [lng + h, lat + h], [lng - h, lat + h], [lng - h, lat - h]]];
}

function item(over: Record<string, unknown> = {}) {
  return {
    _id: "id1",
    name: "MONTREAL TMA",
    type: 7,
    icaoClass: 2,
    geometry: { type: "Polygon", coordinates: square(-73.6, 45.5, 0.5) },
    lowerLimit: ft(2500),
    upperLimit: fl(180),
    ...over,
  };
}

function country(items: unknown[], over: Partial<CountryAirspaces> = {}): CountryAirspaces {
  return {
    country: "CA",
    cycle: { ident: "2611", effective: "2026-10-29", expires: "2026-11-26" },
    expired: false,
    origin: "cache",
    items,
    error: null,
    ...over,
  };
}

describe("formatLimit", () => {
  it("reads ground, feet above sea level, flight levels and heights above ground", () => {
    expect(formatLimit(GND)).toBe("GND");
    expect(formatLimit(ft(2500))).toBe("2500 ft");
    expect(formatLimit(fl(180))).toBe("FL180");
    expect(formatLimit(ft(1500, 0))).toBe("1500 ft AGL");
    expect(formatLimit({ value: 300, unit: 0, referenceDatum: 1 })).toBe("300 m");
    expect(formatLimit({ value: 300, unit: 0, referenceDatum: 0 })).toBe("300 m AGL");
  });

  it("names the datum when feet are on the standard setting", () => {
    expect(formatLimit(ft(5000, 2))).toBe("5000 ft STD");
  });
});

describe("limitFeet", () => {
  it("converts to feet for ordering", () => {
    expect(limitFeet(GND)).toBe(0);
    expect(limitFeet(fl(180))).toBe(18000);
    expect(limitFeet(ft(2500))).toBe(2500);
    expect(limitFeet({ value: 300, unit: 0, referenceDatum: 1 })).toBeCloseTo(984, 0);
  });
});

describe("normalizeAirspace", () => {
  it("labels type, class and limits, and keeps the ring with its bbox", () => {
    const a = normalizeAirspace(item(), "CA")!;
    expect(a).toMatchObject({
      id: "CA:id1",
      name: "MONTREAL TMA",
      typeLabel: "TMA",
      classLabel: "C",
      lower: "2500 ft",
      upper: "FL180",
      lowerFt: 2500,
      country: "CA",
    });
    expect(a.ring).toHaveLength(5);
    expect(a.bbox).toEqual([-74.1, 45, -73.1, 46]);
  });

  it("gives special-use airspace no class letter", () => {
    expect(normalizeAirspace(item({ type: 1, icaoClass: 8 }), "CA")!.classLabel).toBeNull();
  });

  it("rejects items without a usable polygon", () => {
    expect(normalizeAirspace(item({ geometry: null }), "CA")).toBeNull();
    expect(normalizeAirspace(item({ geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 1]]] } }), "CA")).toBeNull();
    expect(normalizeAirspace(item({ geometry: { type: "Polygon", coordinates: [[[0, 0], ["x", 1], [1, 1], [0, 0]]] } }), "CA")).toBeNull();
    expect(normalizeAirspace("nope", "CA")).toBeNull();
  });

  it("survives missing limits and names", () => {
    const a = normalizeAirspace(item({ lowerLimit: undefined, upperLimit: undefined, name: undefined }), "CA")!;
    expect(a.lower).toBe("?");
    expect(a.upper).toBe("?");
    expect(a.name).toBe("(unnamed)");
    expect(a.lowerFt).toBe(0);
  });
});

describe("prepareAirspaces", () => {
  const near = item({ _id: "near" });
  const far = item({ _id: "far", geometry: { type: "Polygon", coordinates: square(-120, 50, 0.5) } });
  const fir = item({ _id: "fir", type: 10, icaoClass: 6 });
  const airway = item({ _id: "awy", type: 15 });

  it("drops the large administrative areas and airways", () => {
    const ids = prepareAirspaces([country([near, fir, airway])]).map((a) => a.id);
    expect(ids).toEqual(["CA:near"]);
  });

  it("keeps only airspaces within the radius of the centre when one is given", () => {
    const ids = prepareAirspaces([country([near, far])], { lat: 45.5, lng: -73.6 }, 300).map((a) => a.id);
    expect(ids).toEqual(["CA:near"]);
    expect(prepareAirspaces([country([near, far])])).toHaveLength(2);
  });

  it("merges countries and skips bad items", () => {
    const us = country([item({ _id: "x" })], { country: "US" });
    const ids = prepareAirspaces([country([near, "junk"]), us]).map((a) => a.id);
    expect(ids).toEqual(["CA:near", "US:x"]);
  });
});

describe("airspacesAt", () => {
  const tma = normalizeAirspace(item({ _id: "tma", lowerLimit: ft(2500) }), "CA")!;
  const ctr = normalizeAirspace(
    item({ _id: "ctr", name: "MONTREAL CTR", type: 4, icaoClass: 2, lowerLimit: GND, upperLimit: ft(3000), geometry: { type: "Polygon", coordinates: square(-73.6, 45.5, 0.1) } }),
    "CA",
  )!;
  const list = [tma, ctr];

  it("lists every airspace stacked over the point, lowest first", () => {
    expect(airspacesAt(list, 45.5, -73.6).map((a) => a.id)).toEqual(["CA:ctr", "CA:tma"]);
  });

  it("finds only the outer one outside the inner polygon", () => {
    expect(airspacesAt(list, 45.8, -73.6).map((a) => a.id)).toEqual(["CA:tma"]);
    expect(airspacesAt(list, 47, -73.6)).toEqual([]);
  });

  it("handles a concave ring", () => {
    // An L shape: the notch at the top right is outside.
    const l = normalizeAirspace(
      item({ _id: "L", geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]]] } }),
      "CA",
    )!;
    expect(airspacesAt([l], 0.5, 0.5)).toHaveLength(1);
    expect(airspacesAt([l], 1.5, 1.5)).toHaveLength(0);
  });
});

describe("airspaceStyle", () => {
  const style = (type: number, icaoClass: number) => airspaceStyle(normalizeAirspace(item({ type, icaoClass }), "CA")!);

  it("draws prohibited and restricted areas in red, danger in orange", () => {
    expect(style(3, 8).color).toBe(style(1, 8).color);
    expect(style(2, 8).color).not.toBe(style(1, 8).color);
  });

  it("colours controlled airspace by class and dashes the uncontrolled classes", () => {
    expect(style(7, 2).color).not.toBe(style(7, 3).color);
    expect(style(7, 2).dashArray).toBeUndefined();
    expect(style(7, 6).dashArray).toBeDefined();
  });

  it("keeps fills faint so stacked airspaces stay readable", () => {
    for (const [t, c] of [[3, 8], [7, 2], [4, 3], [0, 6]]) expect(style(t, c).fillOpacity).toBeLessThanOrEqual(0.08);
  });

  const tma = normalizeAirspace(item(), "CA")!;

  it("scales outline and fill with the opacity setting", () => {
    const full = airspaceStyle(tma, { opacity: 1 });
    const half = airspaceStyle(tma, { opacity: 0.5 });
    expect(half.fillOpacity).toBeCloseTo(full.fillOpacity / 2);
    expect(half.opacity).toBeLessThan(full.opacity);
    expect(full.opacity).toBe(1);
  });

  it("at zero opacity drops the fill but keeps a hairline outline", () => {
    const zero = airspaceStyle(tma, { opacity: 0 });
    expect(zero.fillOpacity).toBe(0);
    expect(zero.opacity).toBeGreaterThan(0);
  });

  it("clamps out-of-range settings", () => {
    expect(airspaceStyle(tma, { opacity: 3 })).toEqual(airspaceStyle(tma, { opacity: 1 }));
    expect(airspaceStyle(tma, { opacity: -1 })).toEqual(airspaceStyle(tma, { opacity: 0 }));
  });

  it("is fainter at night: the same fill reads much stronger over a dark basemap", () => {
    const day = airspaceStyle(tma, { opacity: 0.6, theme: "light" });
    const night = airspaceStyle(tma, { opacity: 0.6, theme: "dark" });
    expect(night.fillOpacity).toBeLessThan(day.fillOpacity);
    expect(night.opacity).toBeLessThan(day.opacity);
  });

  it("defaults to the shipped setting", () => {
    expect(airspaceStyle(tma)).toEqual(airspaceStyle(tma, { opacity: DEFAULT_AIRSPACE_OPACITY, theme: "light" }));
  });
});

describe("airspaceStatus", () => {
  it("summarises cycle, expiry and errors per country", () => {
    const s = airspaceStatus([
      country([]),
      country([], { country: "US", origin: "stale-cache", expired: true, error: "HTTP 500", cycle: { ident: "2610", effective: "2026-10-01", expires: "2026-10-29" } }),
      country([], { country: "FR", origin: "none", cycle: null, error: "No OpenAIP API key" }),
    ]);
    expect(s.cycles).toEqual(["2610", "2611"]);
    expect(s.expired).toBe(true);
    expect(s.errors).toEqual(["US: HTTP 500", "FR: No OpenAIP API key"]);
  });

  it("is clean when everything is current", () => {
    expect(airspaceStatus([country([])])).toEqual({ cycles: ["2611"], expired: false, errors: [] });
  });

  it("carries the licence attribution", () => {
    expect(AIRSPACE_ATTRIBUTION).toMatch(/openAIP/);
    expect(AIRSPACE_ATTRIBUTION).toMatch(/CC BY-NC-SA/);
  });
});

describe("airspaceTypes / filterByType", () => {
  const list = [
    normalizeAirspace(item({ _id: "1", type: 7 }), "CA")!,
    normalizeAirspace(item({ _id: "2", type: 7 }), "CA")!,
    normalizeAirspace(item({ _id: "3", type: 4 }), "CA")!,
    normalizeAirspace(item({ _id: "4", type: 1, icaoClass: 8 }), "CA")!,
  ];

  it("lists the types present with their counts, by label", () => {
    expect(airspaceTypes(list)).toEqual([
      { type: 4, label: "CTR", count: 1 },
      { type: 1, label: "Restricted", count: 1 },
      { type: 7, label: "TMA", count: 2 },
    ]);
  });

  it("drops the hidden types", () => {
    expect(filterByType(list, [7]).map((a) => a.id)).toEqual(["CA:3", "CA:4"]);
    expect(filterByType(list, [])).toBe(list);
  });
});

describe("verticalStatus", () => {
  // TMA 1500 ft MSL – FL065, like many French TMAs.
  const tma = normalizeAirspace(item({ lowerLimit: ft(1500), upperLimit: fl(65) }), "FR")!;
  const ctr = normalizeAirspace(item({ type: 4, lowerLimit: GND, upperLimit: ft(1500) }), "FR")!;
  const agl = normalizeAirspace(item({ lowerLimit: ft(1000, 0), upperLimit: fl(65) }), "FR")!;

  it("keeps the raw limits on the normalised airspace", () => {
    expect(tma.lowerLimit).toEqual(ft(1500));
    expect(tma.upperLimit).toEqual(fl(65));
  });

  it("compares MSL limits with the QNH altitude and flight levels with pressure altitude", () => {
    expect(verticalStatus(tma, { pressureFt: 3000, mslFt: 3370 })).toEqual({ status: "inside", approximate: false });
    // Pressure altitude 6600 is above FL065 even though MSL would be 6970.
    expect(verticalStatus(tma, { pressureFt: 6600, mslFt: 6970 }).status).toBe("above");
    // 1300 ft STD is 1670 ft MSL at QNH 1027: inside the TMA, which a raw comparison would miss.
    expect(verticalStatus(tma, { pressureFt: 1300, mslFt: 1670 }).status).toBe("inside");
    expect(verticalStatus(tma, { pressureFt: 1100, mslFt: 1470 }).status).toBe("below");
  });

  it("falls back to pressure altitude for MSL limits without QNH, flagged approximate", () => {
    expect(verticalStatus(tma, { pressureFt: 3000, mslFt: null })).toEqual({ status: "inside", approximate: true });
    // Flight levels never need QNH.
    expect(verticalStatus(tma, { pressureFt: 7000, mslFt: null })).toEqual({ status: "above", approximate: false });
  });

  it("treats GND as satisfied, and AGL limits as unknown unless the other limit decides", () => {
    expect(verticalStatus(ctr, { pressureFt: 800, mslFt: 1170 }).status).toBe("inside");
    expect(verticalStatus(agl, { pressureFt: 3000, mslFt: 3370 }).status).toBe("unknown");
    expect(verticalStatus(agl, { pressureFt: 7000, mslFt: 7370 }).status).toBe("above");
  });

  it("is unknown without an altitude", () => {
    expect(verticalStatus(tma, { pressureFt: null, mslFt: null }).status).toBe("unknown");
  });

  it("handles limits in metres", () => {
    const m = normalizeAirspace(item({ lowerLimit: { value: 300, unit: 0, referenceDatum: 1 }, upperLimit: fl(65) }), "FR")!;
    expect(verticalStatus(m, { pressureFt: 900, mslFt: 1000 }).status).toBe("inside"); // 300 m ≈ 984 ft
    expect(verticalStatus(m, { pressureFt: 900, mslFt: 950 }).status).toBe("below");
  });
});
