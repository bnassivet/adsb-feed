/**
 * Saved callsign/hex filters: a name, an optional description, and either
 * - a **regex** (`pattern`), tested against the callsign or the hex, or
 * - a **combination** (`combine`) of other saved filters by reference, with
 *   OR / AND / XOR (exactly one) and NOT per term. Being references, a fix to a
 *   source (a built-in included) reaches every combination using it.
 *
 * Built-ins live here in code, never in storage: they cannot be deleted or edited
 * by accident, a corrected default reaches every install, and their names are
 * reserved. User filters are stored in localStorage (`adsb-saved-filters`) and
 * read back through `sanitizeSavedFilters`.
 *
 * Which filter is "selected" is derived (`selectedSavedFilter`), not stored, so
 * editing the query text can never leave a stale selection on screen.
 */
import { compileCallsignQuery, compileRegex, type CallsignMatcher } from "./callsign-match";
import type { Filters } from "./types";

export type FilterOp = "or" | "and" | "xor";
export const FILTER_OPS: readonly FilterOp[] = ["or", "and", "xor"];

export interface FilterTerm {
  /** Id of another saved filter. */
  ref: string;
  not?: true;
}

export interface Combination {
  op: FilterOp;
  terms: FilterTerm[];
}

/** Exactly one of `pattern` (regex filter) or `combine` (combined filter) is set. */
export interface SavedFilter {
  id: string;
  name: string;
  /** Regex filter: case-insensitive, tested against the callsign and the hex. */
  pattern?: string;
  /** Combined filter: other saved filters, by id. */
  combine?: Combination;
  description?: string;
  builtin?: true;
}

export interface SavedFilterDraft {
  name: string;
  pattern?: string;
  combine?: Combination;
  description?: string;
}

/**
 * Military ICAO 24-bit address blocks (NATO / Europe / allies over France).
 * Each 3-char group is followed by `...` so every branch spans 6 hex digits.
 */
export const MILITARY_HEX_PATTERN =
  "^(3(A[A-F]|B.)...|43C...|4[4567]F...|480...|4B7...|3F....|501...|A(D[F8-F]|E.|F[0-3])...|C2....)$";

/** Frequent military callsign prefixes seen over France. */
export const MILITARY_CALLSIGN_PATTERN =
  "^(CTM|FAF|FNY|FMY|FGN|FDO|RCH|CNV|DUKE|NATO|RRR|ASCOT|GAF|BAF|NAF|SUI|AME|IAM|CFC|LAGR|NCHO|MMF)[0-9A-Z]*$";

export const BUILTIN_FILTERS: readonly SavedFilter[] = [
  {
    id: "builtin:military-hex",
    name: "Military — hex ranges (NATO/EU)",
    pattern: MILITARY_HEX_PATTERN,
    description:
      "Military ICAO address blocks: France 3AA000–3BFFFF, UK/RAF 43C, Germany 3F, Netherlands 480, " +
      "Belgium 44F (+45F–47F), Switzerland 4B7, 501, USA AD8000–AF3FFF, Canada C2. " +
      "The US block starts below the documented ADF7C8, so a few civil N-numbers may match. " +
      "Spain and Italy are not covered: their military codes are scattered in civil ranges.",
    builtin: true,
  },
  {
    id: "builtin:military-callsign",
    name: "Military — callsigns (NATO/EU)",
    pattern: MILITARY_CALLSIGN_PATTERN,
    description:
      "Frequent military callsign prefixes: CTM/FAF/FNY/FMY… (France), RCH Reach (USAF), " +
      "RRR/ASCOT (RAF), NATO (AWACS), GAF (Luftwaffe), BAF (Belgium), MMF (European MRTT tankers), and others.",
    builtin: true,
  },
  {
    id: "builtin:military",
    name: "Military — hex or callsign (NATO/EU)",
    combine: {
      op: "or",
      terms: [{ ref: "builtin:military-hex" }, { ref: "builtin:military-callsign" }],
    },
    description: "Either military default: a military hex block OR a military callsign prefix.",
    builtin: true,
  },
];

const norm = (name: string) => name.trim().toLowerCase();

export function allSavedFilters(user: readonly SavedFilter[]): SavedFilter[] {
  return [...BUILTIN_FILTERS, ...user];
}

export function validateSavedFilter(
  draft: SavedFilterDraft,
  all: readonly SavedFilter[] = BUILTIN_FILTERS,
): { ok: true } | { error: string } {
  if (!draft.name.trim()) return { error: "A name is required" };
  if (BUILTIN_FILTERS.some((b) => norm(b.name) === norm(draft.name))) {
    return { error: "This name is reserved for a default filter" };
  }
  if (draft.combine) {
    if (draft.combine.terms.length === 0) return { error: "Add at least one filter to combine" };
    const missing = draft.combine.terms.find((t) => !all.some((f) => f.id === t.ref));
    if (missing) return { error: `Unknown filter in the combination: ${missing.ref}` };
    // Check the combination as it would be stored: replacing a same-name filter keeps its id.
    const same = all.find((f) => !f.builtin && norm(f.name) === norm(draft.name));
    const id = same?.id ?? "__draft__";
    const candidate: SavedFilter = { id, name: draft.name, combine: draft.combine };
    const res = combinedMatcher([...all.filter((f) => f.id !== id), candidate], id);
    if ("error" in res) return { error: res.error };
    return { ok: true };
  }
  const pattern = draft.pattern ?? "";
  if (!pattern.trim()) return { error: "The regex is empty" };
  const { error } = compileCallsignQuery(pattern, true);
  if (error) return { error: `Invalid regex: ${error}` };
  return { ok: true };
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Same name (case-insensitive) replaces that filter, keeping its id; otherwise appends. */
export function upsertSavedFilter(user: readonly SavedFilter[], draft: SavedFilterDraft): SavedFilter[] {
  const name = draft.name.trim();
  const description = draft.description?.trim() || undefined;
  const at = user.findIndex((f) => norm(f.name) === norm(name));
  const entry: SavedFilter = {
    id: at >= 0 ? user[at].id : newId(),
    name,
    ...(draft.combine
      ? { combine: { op: draft.combine.op, terms: draft.combine.terms.map((t) => ({ ...t })) } }
      : { pattern: (draft.pattern ?? "").trim() }),
    ...(description && { description }),
  };
  return at >= 0 ? user.map((f, i) => (i === at ? entry : f)) : [...user, entry];
}

export function removeSavedFilter(user: readonly SavedFilter[], id: string): SavedFilter[] {
  return user.filter((f) => f.id !== id);
}

export function findSavedFilter(all: readonly SavedFilter[], name: string): SavedFilter | undefined {
  return all.find((f) => norm(f.name) === norm(name));
}

/**
 * The selected filter: the stored `savedFilterId` (a combination cannot live in
 * the query text), else the regex filter whose pattern is the current query.
 */
export function selectedSavedFilter(
  all: readonly SavedFilter[],
  filters: Pick<Filters, "callsign" | "callsignRegex" | "savedFilterId">,
): SavedFilter | undefined {
  if (filters.savedFilterId) return all.find((f) => f.id === filters.savedFilterId);
  if (!filters.callsignRegex) return undefined;
  return all.find((f) => f.pattern !== undefined && f.pattern === filters.callsign);
}

/**
 * Filters with `f` applied (the other fields untouched):
 * - regex filter → its pattern in the query, regex mode on;
 * - combined filter → held by id, query emptied;
 * - nothing → query and selection cleared.
 */
export function applySavedFilter(filters: Filters, f: SavedFilter | undefined): Filters {
  if (!f) return { ...filters, callsign: "", savedFilterId: null };
  if (f.combine) return { ...filters, callsign: "", savedFilterId: f.id };
  return { ...filters, callsign: f.pattern ?? "", callsignRegex: true, savedFilterId: null };
}

/** Filters whose combination refers to `id` directly. */
export function referencedBy(all: readonly SavedFilter[], id: string): SavedFilter[] {
  return all.filter((f) => f.combine?.terms.some((t) => t.ref === id));
}

/**
 * One matcher for a saved filter, regex or combined (recursively). Each source
 * regex is compiled once per call. Errors: unknown id, missing source, cycle,
 * invalid regex.
 */
export function combinedMatcher(
  all: readonly SavedFilter[],
  id: string,
): { matcher: CallsignMatcher } | { error: string } {
  const byId = new Map(all.map((f) => [f.id, f]));
  const build = (fid: string, path: string[]): CallsignMatcher | string => {
    const f = byId.get(fid);
    if (!f) return path.length ? `A combined source is missing (${fid})` : `Unknown filter: ${fid}`;
    if (path.includes(fid)) return `Combination cycle: ${[...path, fid].map((p) => byId.get(p)?.name ?? p).join(" → ")}`;
    if (f.pattern !== undefined) {
      const { matcher, error } = compileRegex(f.pattern);
      if (error) return `Invalid regex in '${f.name}': ${error}`;
      return matcher ?? (() => true);
    }
    if (!f.combine) return `Filter '${f.name}' has neither a regex nor a combination`;
    const terms: { m: CallsignMatcher; not: boolean }[] = [];
    for (const t of f.combine.terms) {
      const m = build(t.ref, [...path, fid]);
      if (typeof m === "string") return m;
      terms.push({ m, not: t.not === true });
    }
    const op = f.combine.op;
    return (callsign, hex) => {
      let hits = 0;
      for (const { m, not } of terms) {
        const hit = m(callsign, hex) !== not;
        if (hit) {
          if (op === "or") return true;
          hits++;
        } else if (op === "and") {
          return false;
        }
      }
      return op === "and" ? true : op === "xor" ? hits === 1 : false;
    };
  };
  const m = build(id, []);
  return typeof m === "string" ? { error: m } : { matcher: m };
}

/**
 * The filters used for matching: with a combined filter selected, its resolved
 * matcher is attached (`null` if it cannot be resolved, i.e. no callsign
 * filtering). Unchanged object otherwise, so memoised consumers do not re-run.
 */
export function resolveFilters(filters: Filters, all: readonly SavedFilter[]): Filters {
  if (!filters.savedFilterId) return filters;
  const res = combinedMatcher(all, filters.savedFilterId);
  return { ...filters, combinedMatcher: "matcher" in res ? res.matcher : null };
}

/** Human-readable form: the pattern, or "A AND NOT B" with the sources' names. */
export function describeFilter(all: readonly SavedFilter[], f: SavedFilter): string {
  if (f.pattern !== undefined) return f.pattern;
  if (!f.combine) return "";
  const op = ` ${f.combine.op.toUpperCase()} `;
  return f.combine.terms
    .map((t) => {
      const src = all.find((s) => s.id === t.ref);
      return `${t.not ? "NOT " : ""}${src ? src.name : "(missing)"}`;
    })
    .join(op);
}

function sanitizeCombination(raw: unknown): Combination | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { op, terms } = raw as Record<string, unknown>;
  if (!FILTER_OPS.includes(op as FilterOp) || !Array.isArray(terms)) return undefined;
  const out: FilterTerm[] = [];
  for (const t of terms) {
    if (typeof t !== "object" || t === null) return undefined;
    const { ref, not } = t as Record<string, unknown>;
    if (typeof ref !== "string") return undefined;
    out.push({ ref, ...(not === true && { not: true as const }) });
  }
  return { op: op as FilterOp, terms: out };
}

/** User filters read back from storage: malformed entries and fake built-ins are dropped. */
export function sanitizeSavedFilters(raw: unknown): SavedFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedFilter[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const { id, name, pattern, combine, description, builtin } = r as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") continue;
    if (builtin || id.startsWith("builtin:")) continue;
    const desc = typeof description === "string" && description ? { description } : {};
    if (typeof pattern === "string" && combine === undefined) {
      out.push({ id, name, pattern, ...desc });
    } else if (pattern === undefined) {
      const c = sanitizeCombination(combine);
      if (c) out.push({ id, name, combine: c, ...desc });
    }
  }
  return out;
}
