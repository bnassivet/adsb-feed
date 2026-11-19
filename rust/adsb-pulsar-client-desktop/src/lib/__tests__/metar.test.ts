import { describe, it, expect } from "vitest";
import {
  normalizeMetar,
  prepareMetars,
  formatWind,
  formatVisibility,
  formatClouds,
  formatAge,
  ageMinutes,
  isOld,
  metarColor,
  metarMarkerStyle,
  metarCategories,
  filterByCategory,
  nearestMetar,
  DEFAULT_METAR_OPACITY,
  METAR_ATTRIBUTION,
  type Metar,
} from "../metar";

/** Shaped like a real AviationWeather.gov item (CYUL, 2026-11-19). */
function raw(over: Record<string, unknown> = {}) {
  return {
    icaoId: "CYUL",
    obsTime: 1795053600,
    temp: 9,
    dewp: 4,
    wdir: 250,
    wspd: 9,
    wgst: 16,
    visib: 15,
    altim: 1027.2,
    metarType: "METAR",
    rawOb: "METAR CYUL 190200Z 25009G16KT 15SM SCT250 09/04 A3033 RMK CI3 SLP274",
    lat: 45.468,
    lon: -73.742,
    elev: 31,
    name: "Montreal/Trudeau Intl, QC, CA",
    cover: "SCT",
    clouds: [{ cover: "SCT", base: 25000 }],
    fltCat: "VFR",
    ...over,
  };
}

const m = (over: Record<string, unknown> = {}) => normalizeMetar(raw(over))!;

describe("normalizeMetar", () => {
  it("reads a full report", () => {
    expect(m()).toMatchObject({
      id: "CYUL",
      name: "Montreal/Trudeau Intl, QC, CA",
      lat: 45.468,
      lng: -73.742,
      category: "VFR",
      obsTimeMs: 1795053600_000,
      tempC: 9,
      dewpC: 4,
      qnhHpa: 1027.2,
      speci: false,
      raw: "METAR CYUL 190200Z 25009G16KT 15SM SCT250 09/04 A3033 RMK CI3 SLP274",
    });
  });

  it("accepts a missing flight category and flags SPECI", () => {
    expect(m({ fltCat: null }).category).toBeNull();
    expect(m({ fltCat: "XYZ" }).category).toBeNull();
    expect(m({ metarType: "SPECI" }).speci).toBe(true);
  });

  it("rejects items without an id or a position", () => {
    expect(normalizeMetar(raw({ lat: null }))).toBeNull();
    expect(normalizeMetar(raw({ icaoId: "" }))).toBeNull();
    expect(normalizeMetar("junk")).toBeNull();
  });

  it("tolerates missing numbers", () => {
    const x = m({ temp: null, dewp: undefined, altim: "n/a" });
    expect([x.tempC, x.dewpC, x.qnhHpa]).toEqual([null, null, null]);
  });

  it("prepareMetars skips bad items", () => {
    expect(prepareMetars([raw(), "junk", raw({ icaoId: "CYHU" })]).map((x) => x.id)).toEqual(["CYUL", "CYHU"]);
  });
});

describe("formatting", () => {
  it("formats wind: direction, speed, gust, variable and calm", () => {
    expect(formatWind(250, 9, 16)).toBe("250° 9G16 kt");
    expect(formatWind(70, 5, null)).toBe("070° 5 kt");
    expect(formatWind("VRB", 3, null)).toBe("VRB 3 kt");
    expect(formatWind(0, 0, null)).toBe("Calm");
    expect(formatWind(null, null, null)).toBeNull();
  });

  it("formats visibility in statute miles", () => {
    expect(formatVisibility("10+")).toBe("10+ SM");
    expect(formatVisibility(15)).toBe("15 SM");
    expect(formatVisibility(0.38)).toBe("0.38 SM");
    expect(formatVisibility(null)).toBeNull();
  });

  it("formats cloud layers, or the overall cover", () => {
    expect(formatClouds([{ cover: "FEW", base: 400 }, { cover: "OVC", base: 1000 }], "OVC")).toBe("FEW 400 ft, OVC 1000 ft");
    expect(formatClouds([], "CLR")).toBe("CLR");
    expect(formatClouds(undefined, null)).toBeNull();
  });

  it("gives the age of a report and flags old ones", () => {
    const obs = 1_000_000_000_000;
    expect(ageMinutes(obs, obs + 12 * 60_000)).toBe(12);
    expect(formatAge(12)).toBe("12 min ago");
    expect(formatAge(125)).toBe("2 h 5 min ago");
    expect(formatAge(0)).toBe("just now");
    expect(isOld(89)).toBe(false);
    expect(isOld(91)).toBe(true);
  });
});

describe("style", () => {
  it("uses the standard flight category colours", () => {
    const colours = ["VFR", "MVFR", "IFR", "LIFR", null].map((c) => metarColor(c as never));
    expect(new Set(colours).size).toBe(5);
  });

  it("scales with the opacity setting and keeps an outline at zero", () => {
    const full = metarMarkerStyle(m(), { opacity: 1, nowMs: m().obsTimeMs });
    const zero = metarMarkerStyle(m(), { opacity: 0, nowMs: m().obsTimeMs });
    expect(full.fillOpacity).toBeGreaterThan(zero.fillOpacity);
    expect(zero.opacity).toBeGreaterThan(0);
  });

  it("draws old reports hollow", () => {
    const fresh = metarMarkerStyle(m(), { nowMs: m().obsTimeMs });
    const old = metarMarkerStyle(m(), { nowMs: m().obsTimeMs + 3 * 3_600_000 });
    expect(old.fillOpacity).toBeLessThan(fresh.fillOpacity);
    expect(old.color).toBe(fresh.fillColor);
  });

  it("is dimmer at night and defaults sensibly", () => {
    const day = metarMarkerStyle(m(), { theme: "light", nowMs: 0 });
    const night = metarMarkerStyle(m(), { theme: "dark", nowMs: 0 });
    expect(night.fillOpacity).toBeLessThan(day.fillOpacity);
    expect(metarMarkerStyle(m(), { nowMs: 0 })).toEqual(metarMarkerStyle(m(), { opacity: DEFAULT_METAR_OPACITY, theme: "light", nowMs: 0 }));
  });

  it("credits the source", () => {
    expect(METAR_ATTRIBUTION).toMatch(/AviationWeather\.gov/);
  });
});

describe("categories", () => {
  const list: Metar[] = [m({ icaoId: "A", fltCat: "IFR" }), m({ icaoId: "B" }), m({ icaoId: "C" }), m({ icaoId: "D", fltCat: null })];

  it("counts the categories present, in severity order", () => {
    expect(metarCategories(list)).toEqual([
      { value: "VFR", label: "VFR", count: 2 },
      { value: "IFR", label: "IFR", count: 1 },
      { value: "unknown", label: "Unknown", count: 1 },
    ]);
  });

  it("drops hidden categories, unknown included", () => {
    expect(filterByCategory(list, ["VFR", "unknown"]).map((x) => x.id)).toEqual(["A"]);
    expect(filterByCategory(list, [])).toBe(list);
  });
});

describe("nearestMetar", () => {
  // Identity projection: lng → x, lat → y, in "pixels".
  const project = (x: Metar) => ({ x: x.lng, y: x.lat });
  const list = [m({ icaoId: "A", lat: 0, lon: 0 }), m({ icaoId: "B", lat: 0, lon: 10 })];

  it("returns the nearest station within the pick radius", () => {
    expect(nearestMetar(list, { x: 7, y: 1 }, project, 8)?.id).toBe("B");
    expect(nearestMetar(list, { x: 2, y: 0 }, project, 8)?.id).toBe("A");
  });

  it("returns null when nothing is close enough", () => {
    expect(nearestMetar(list, { x: 5, y: 9 }, project, 8)).toBeNull();
    expect(nearestMetar([], { x: 0, y: 0 }, project, 8)).toBeNull();
  });
});
