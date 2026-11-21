/**
 * Callsign / hex search, shared by the Filters panel and the chat tools.
 *
 * Two modes:
 * - **substring** (default): comma-separated tokens, any token found in the
 *   callsign or hex ident matches. Characters are literal.
 * - **regex**: the whole query is ONE case-insensitive JavaScript regular
 *   expression, tested against the callsign and the hex ident. Commas are part
 *   of the pattern (`\d{3,4}`); use `|` for alternatives.
 *
 * An invalid regex yields `matcher: null` plus an `error`, i.e. "no filter":
 * a half-typed pattern such as `AFR(` must not blank the map on every keystroke.
 */

export type CallsignMatcher = (callsign: string | null, hexIdent: string) => boolean;

export interface CompiledCallsignQuery {
  /** `null` means the query does not filter anything (empty or invalid). */
  matcher: CallsignMatcher | null;
  /** Regex syntax error message, regex mode only. */
  error: string | null;
}

const NO_FILTER: CompiledCallsignQuery = { matcher: null, error: null };

// One-entry cache: matchesFilters calls this once per track on every feed batch
// with the same query, so the pattern is compiled once, not thousands of times.
let cacheKey: string | null = null;
let cacheValue: CompiledCallsignQuery = NO_FILTER;

export function compileCallsignQuery(query: string, regex: boolean): CompiledCallsignQuery {
  const key = `${regex ? "r" : "s"}:${query}`;
  if (key === cacheKey) return cacheValue;
  const value = regex ? compileRegex(query) : compileSubstring(query);
  cacheKey = key;
  cacheValue = value;
  return value;
}

function compileSubstring(query: string): CompiledCallsignQuery {
  const tokens = query
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return NO_FILTER;
  return {
    matcher: (callsign, hexIdent) => {
      const cs = (callsign ?? "").toLowerCase();
      const id = hexIdent.toLowerCase();
      return tokens.some((tok) => cs.includes(tok) || id.includes(tok));
    },
    error: null,
  };
}

/** Uncached: combined filters compile each source regex once and keep the result. */
export function compileRegex(query: string): CompiledCallsignQuery {
  const pattern = query.trim();
  if (!pattern) return NO_FILTER;
  let re: RegExp;
  try {
    // No `g`/`y` flag: those make `test()` stateful through `lastIndex`.
    re = new RegExp(pattern, "i");
  } catch (e) {
    return { matcher: null, error: e instanceof Error ? e.message : String(e) };
  }
  return {
    // Callsigns arrive space-padded from some decoders; trim so `$` anchors work.
    matcher: (callsign, hexIdent) =>
      (callsign !== null && re.test(callsign.trim())) || re.test(hexIdent),
    error: null,
  };
}
