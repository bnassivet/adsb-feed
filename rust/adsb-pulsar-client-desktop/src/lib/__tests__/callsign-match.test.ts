import { describe, it, expect } from "vitest";
import { compileCallsignQuery } from "../callsign-match";

describe("compileCallsignQuery — substring mode", () => {
  it("returns no matcher for an empty or blank query", () => {
    expect(compileCallsignQuery("", false).matcher).toBeNull();
    expect(compileCallsignQuery(" , ,", false).matcher).toBeNull();
  });

  it("matches comma-separated tokens against callsign or hex, case-insensitively", () => {
    const { matcher, error } = compileCallsignQuery("afr, 3c6", false);
    expect(error).toBeNull();
    expect(matcher!("AFR123", "4CA001")).toBe(true);
    expect(matcher!(null, "3C6ABC")).toBe(true);
    expect(matcher!("BAW42", "400000")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    const { matcher } = compileCallsignQuery("A.R", false);
    expect(matcher!("AFR123", "000000")).toBe(false);
    expect(matcher!("A.R1", "000000")).toBe(true);
  });
});

describe("compileCallsignQuery — regex mode", () => {
  it("returns no matcher for an empty pattern", () => {
    expect(compileCallsignQuery("   ", true)).toEqual({ matcher: null, error: null });
  });

  it("matches the pattern against callsign or hex, case-insensitively", () => {
    const { matcher, error } = compileCallsignQuery("^(afr|baw)\\d+$", true);
    expect(error).toBeNull();
    expect(matcher!("AFR123", "4CA001")).toBe(true);
    expect(matcher!("BAW42", "400000")).toBe(true);
    expect(matcher!("AFR12X", "4CA001")).toBe(false);
    expect(matcher!(null, "4CA001")).toBe(false);
  });

  it("tests the hex ident too", () => {
    const { matcher } = compileCallsignQuery("^3c", true);
    expect(matcher!(null, "3C6ABC")).toBe(true);
  });

  it("keeps commas as part of the pattern", () => {
    const { matcher } = compileCallsignQuery("^[A-Z]{3}\\d{3,4}$", true);
    expect(matcher!("AFR1234", "000000")).toBe(true);
    expect(matcher!("AFR12", "000000")).toBe(false);
  });

  it("reports an invalid pattern and does not filter", () => {
    const { matcher, error } = compileCallsignQuery("AFR(", true);
    expect(matcher).toBeNull();
    expect(error).toMatch(/./);
  });

  it("is stateless across calls (no lastIndex drift from a global flag)", () => {
    const { matcher } = compileCallsignQuery("AFR", true);
    expect(matcher!("AFR1", "000000")).toBe(true);
    expect(matcher!("AFR1", "000000")).toBe(true);
  });

  it("returns the cached result for the same query", () => {
    expect(compileCallsignQuery("^AF", true)).toBe(compileCallsignQuery("^AF", true));
  });
});
