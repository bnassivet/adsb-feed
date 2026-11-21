import { describe, it, expect } from "vitest";
import {
  BUILTIN_FILTERS,
  MILITARY_CALLSIGN_PATTERN,
  MILITARY_HEX_PATTERN,
  allSavedFilters,
  findSavedFilter,
  removeSavedFilter,
  sanitizeSavedFilters,
  selectedSavedFilter,
  upsertSavedFilter,
  validateSavedFilter,
  combinedMatcher,
  describeFilter,
  referencedBy,
  resolveFilters,
  type SavedFilter,
} from "../saved-filters";
import { compileCallsignQuery } from "../callsign-match";
import { DEFAULT_FILTERS } from "../types";

const mine: SavedFilter = { id: "u1", name: "French majors", pattern: "^(AFR|TVF)\\d+$", description: "AF + Transavia" };

describe("built-in military filters", () => {
  it("regex built-ins compile", () => {
    for (const f of BUILTIN_FILTERS.filter((b) => b.pattern !== undefined)) {
      expect(compileCallsignQuery(f.pattern!, true).error).toBeNull();
      expect(f.builtin).toBe(true);
      expect(f.description).toBeTruthy();
    }
  });

  it("hex ranges match military blocks, not civil neighbours", () => {
    const re = new RegExp(MILITARY_HEX_PATTERN, "i");
    for (const hex of ["3AB123", "3B0001", "AE1234", "ADF800", "AF2000", "43C001", "3F5000", "C21234", "44F010", "480123", "4B7001"]) {
      expect(re.test(hex), hex).toBe(true);
    }
    for (const hex of ["3C6444", "A12345", "AF4000", "400ABC", "4CA001", "3AA"]) {
      expect(re.test(hex), hex).toBe(false);
    }
  });

  it("callsign prefixes match military callsigns, not airlines", () => {
    const re = new RegExp(MILITARY_CALLSIGN_PATTERN, "i");
    for (const cs of ["RCH123", "NATO01", "ASCOT4", "CTM2051", "FAF4321", "MMF12"]) expect(re.test(cs), cs).toBe(true);
    for (const cs of ["AFR123", "EZY45", "BAW9", "RYR1AB"]) expect(re.test(cs), cs).toBe(false);
  });
});

describe("allSavedFilters", () => {
  it("lists built-ins first, then the user's", () => {
    const all = allSavedFilters([mine]);
    expect(all.slice(0, BUILTIN_FILTERS.length)).toEqual(BUILTIN_FILTERS);
    expect(all[all.length - 1]).toBe(mine);
  });
});

describe("validateSavedFilter", () => {
  it("accepts a named, valid pattern without description", () => {
    expect(validateSavedFilter({ name: "x", pattern: "^A" })).toEqual({ ok: true });
  });
  it("requires a name", () => {
    expect(validateSavedFilter({ name: "  ", pattern: "^A" })).toHaveProperty("error");
  });
  it("requires a valid, non-empty pattern", () => {
    expect(validateSavedFilter({ name: "x", pattern: "AFR(" })).toHaveProperty("error");
    expect(validateSavedFilter({ name: "x", pattern: " " })).toHaveProperty("error");
  });
  it("refuses a built-in name, whatever the case", () => {
    const res = validateSavedFilter({ name: BUILTIN_FILTERS[0].name.toUpperCase(), pattern: "^A" });
    expect(res).toHaveProperty("error");
  });
});

describe("upsert / remove", () => {
  it("appends a new filter with a fresh id, trimmed, empty description dropped", () => {
    const out = upsertSavedFilter([mine], { name: "  Tankers ", pattern: "^MMF", description: "  " });
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ name: "Tankers", pattern: "^MMF" });
    expect(out[1].description).toBeUndefined();
    expect(out[1].id).not.toBe(mine.id);
  });

  it("replaces a filter with the same name (case-insensitive), keeping its id", () => {
    const out = upsertSavedFilter([mine], { name: "french MAJORS", pattern: "^AFR", description: "AF only" });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: "u1", name: "french MAJORS", pattern: "^AFR", description: "AF only" });
  });

  it("removes by id and never touches built-ins", () => {
    expect(removeSavedFilter([mine], "u1")).toEqual([]);
    expect(removeSavedFilter([mine], BUILTIN_FILTERS[0].id)).toEqual([mine]);
  });
});

describe("findSavedFilter", () => {
  it("finds by name, case-insensitive and trimmed", () => {
    const all = allSavedFilters([mine]);
    expect(findSavedFilter(all, " french majors ")).toBe(mine);
    expect(findSavedFilter(all, "nope")).toBeUndefined();
  });
});

describe("selectedSavedFilter", () => {
  const all = allSavedFilters([mine]);
  it("is the entry whose pattern is the current regex query", () => {
    expect(selectedSavedFilter(all, { ...DEFAULT_FILTERS, callsign: mine.pattern!, callsignRegex: true })).toBe(mine);
  });
  it("is nothing in substring mode or once the text is edited", () => {
    expect(selectedSavedFilter(all, { ...DEFAULT_FILTERS, callsign: mine.pattern!, callsignRegex: false })).toBeUndefined();
    expect(selectedSavedFilter(all, { ...DEFAULT_FILTERS, callsign: mine.pattern! + "x", callsignRegex: true })).toBeUndefined();
  });
});

describe("sanitizeSavedFilters", () => {
  it("keeps well-formed entries and drops the rest", () => {
    const raw: unknown = [mine, null, 3, { id: "x" }, { id: "y", name: "n", pattern: 4 }, { id: "z", name: "n", pattern: "p", description: 5 }];
    expect(sanitizeSavedFilters(raw)).toEqual([mine, { id: "z", name: "n", pattern: "p" }]);
  });
  it("drops anything pretending to be a built-in", () => {
    expect(sanitizeSavedFilters([{ ...BUILTIN_FILTERS[0] }])).toEqual([]);
  });
  it("returns [] for a non-array", () => {
    expect(sanitizeSavedFilters({ a: 1 })).toEqual([]);
  });
});

// ── Combined filters ───────────────────────────────────────────────────────────

const afr: SavedFilter = { id: "afr", name: "Air France", pattern: "^AFR" };
const heavy3c: SavedFilter = { id: "3c", name: "German hex", pattern: "^3C" };
const combo = (id: string, op: "or" | "and" | "xor", terms: { ref: string; not?: true }[], name = id): SavedFilter => ({
  id,
  name,
  combine: { op, terms },
});

/** Runs the combined matcher of `id` against (callsign, hex). */
function run(all: SavedFilter[], id: string, callsign: string | null, hex: string): boolean {
  const res = combinedMatcher(all, id);
  if ("error" in res) throw new Error(res.error);
  return res.matcher(callsign, hex);
}

describe("combinedMatcher", () => {
  const base = [afr, heavy3c];

  it("OR: any term", () => {
    const all = [...base, combo("c", "or", [{ ref: "afr" }, { ref: "3c" }])];
    expect(run(all, "c", "AFR12", "4CA001")).toBe(true);
    expect(run(all, "c", "DLH4", "3C6444")).toBe(true);
    expect(run(all, "c", "DLH4", "4CA001")).toBe(false);
  });

  it("AND: every term, across callsign and hex", () => {
    const all = [...base, combo("c", "and", [{ ref: "afr" }, { ref: "3c" }])];
    expect(run(all, "c", "AFR12", "3C0001")).toBe(true);
    expect(run(all, "c", "AFR12", "4CA001")).toBe(false);
  });

  it("XOR: exactly one term", () => {
    const all = [...base, combo("c", "xor", [{ ref: "afr" }, { ref: "3c" }])];
    expect(run(all, "c", "AFR12", "4CA001")).toBe(true);
    expect(run(all, "c", "DLH4", "3C6444")).toBe(true);
    expect(run(all, "c", "AFR12", "3C0001")).toBe(false);
    expect(run(all, "c", "DLH4", "4CA001")).toBe(false);
  });

  it("NOT on a term, including a single-term negation", () => {
    const andNot = [...base, combo("c", "and", [{ ref: "3c" }, { ref: "afr", not: true }])];
    expect(run(andNot, "c", "DLH4", "3C6444")).toBe(true);
    expect(run(andNot, "c", "AFR12", "3C6444")).toBe(false);
    const not = [...base, combo("n", "or", [{ ref: "afr", not: true }])];
    expect(run(not, "n", "AFR12", "4CA001")).toBe(false);
    expect(run(not, "n", "BAW1", "400001")).toBe(true);
  });

  it("nests combined filters and follows the current version of a source", () => {
    const inner = combo("inner", "or", [{ ref: "afr" }]);
    const outer = combo("outer", "and", [{ ref: "inner" }, { ref: "3c", not: true }]);
    expect(run([afr, heavy3c, inner, outer], "outer", "AFR1", "4CA001")).toBe(true);
    const edited = { ...afr, pattern: "^TVF" };
    expect(run([edited, heavy3c, inner, outer], "outer", "AFR1", "4CA001")).toBe(false);
  });

  it("a regex filter on its own works too", () => {
    expect(run(base, "afr", "AFR1", "000000")).toBe(true);
  });

  it("reports a missing source, a cycle and an unknown id", () => {
    expect(combinedMatcher([combo("c", "or", [{ ref: "gone" }])], "c")).toHaveProperty("error");
    const a = combo("a", "or", [{ ref: "b" }]);
    const b = combo("b", "or", [{ ref: "a" }]);
    expect((combinedMatcher([a, b], "a") as { error: string }).error).toMatch(/cycle/i);
    expect(combinedMatcher(base, "nope")).toHaveProperty("error");
  });

  it("the military built-in matches by hex or by callsign", () => {
    const all = allSavedFilters([]);
    expect(run(all, "builtin:military", "AFR123", "3AB123")).toBe(true);
    expect(run(all, "builtin:military", "RCH123", "A12345")).toBe(true);
    expect(run(all, "builtin:military", "AFR123", "3C6444")).toBe(false);
  });
});

describe("describeFilter", () => {
  it("writes a combination with the source names, NOT and the operator", () => {
    const all = [afr, heavy3c, combo("c", "and", [{ ref: "3c" }, { ref: "afr", not: true }])];
    expect(describeFilter(all, all[2])).toBe("German hex AND NOT Air France");
  });
  it("is the pattern for a regex filter, and marks a missing source", () => {
    expect(describeFilter([afr], afr)).toBe("^AFR");
    expect(describeFilter([], combo("c", "or", [{ ref: "gone" }]))).toBe("(missing)");
  });
});

describe("referencedBy", () => {
  it("lists the filters that use a given one", () => {
    const all = [afr, combo("c", "or", [{ ref: "afr" }], "Combo")];
    expect(referencedBy(all, "afr").map((f) => f.name)).toEqual(["Combo"]);
    expect(referencedBy(all, "c")).toEqual([]);
  });
});

describe("validateSavedFilter — combinations", () => {
  const all = allSavedFilters([afr, heavy3c]);
  it("accepts a valid combination", () => {
    expect(validateSavedFilter({ name: "x", combine: { op: "or", terms: [{ ref: "afr" }] } }, all)).toEqual({ ok: true });
  });
  it("needs at least one term, existing sources", () => {
    expect(validateSavedFilter({ name: "x", combine: { op: "or", terms: [] } }, all)).toHaveProperty("error");
    expect(validateSavedFilter({ name: "x", combine: { op: "or", terms: [{ ref: "gone" }] } }, all)).toHaveProperty("error");
  });
  it("refuses a combination that would refer to itself", () => {
    const user = [afr, combo("c", "or", [{ ref: "afr" }], "Combo")];
    const res = validateSavedFilter({ name: "combo", combine: { op: "or", terms: [{ ref: "c" }] } }, allSavedFilters(user));
    expect((res as { error: string }).error).toMatch(/cycle|itself/i);
  });
});

describe("upsert / sanitize — combinations", () => {
  it("stores a combination draft", () => {
    const out = upsertSavedFilter([afr], { name: "Combo", combine: { op: "xor", terms: [{ ref: "afr", not: true }] } });
    expect(out[1]).toMatchObject({ name: "Combo", combine: { op: "xor", terms: [{ ref: "afr", not: true }] } });
    expect(out[1].pattern).toBeUndefined();
  });

  it("keeps valid combinations from storage and drops malformed ones", () => {
    const good = combo("c", "and", [{ ref: "afr" }, { ref: "3c", not: true }]);
    const raw: unknown = [
      good,
      { id: "d", name: "bad op", combine: { op: "nand", terms: [{ ref: "afr" }] } },
      { id: "e", name: "bad terms", combine: { op: "or", terms: [{ nope: 1 }] } },
      { id: "f", name: "both", pattern: "^A", combine: { op: "or", terms: [{ ref: "afr" }] } },
    ];
    expect(sanitizeSavedFilters(raw)).toEqual([good]);
  });

  it("selection follows savedFilterId for a combination", () => {
    const all = allSavedFilters([]);
    expect(selectedSavedFilter(all, { ...DEFAULT_FILTERS, savedFilterId: "builtin:military" })?.id).toBe("builtin:military");
  });
});

describe("resolveFilters", () => {
  it("is the same object when no combined filter is selected", () => {
    const f = { ...DEFAULT_FILTERS, callsign: "AFR" };
    expect(resolveFilters(f, allSavedFilters([]))).toBe(f);
  });

  it("attaches the combined matcher for the selected id", () => {
    const r = resolveFilters({ ...DEFAULT_FILTERS, savedFilterId: "builtin:military" }, allSavedFilters([]));
    expect(r.combinedMatcher!("RCH1", "A12345")).toBe(true);
    expect(r.combinedMatcher!("AFR1", "3C6444")).toBe(false);
  });

  it("attaches no matcher (no callsign filtering) when the selection cannot be resolved", () => {
    const r = resolveFilters({ ...DEFAULT_FILTERS, savedFilterId: "gone" }, allSavedFilters([]));
    expect(r.combinedMatcher).toBeNull();
  });
});
