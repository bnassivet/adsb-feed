import { describe, it, expect } from "vitest";
import { isInspectorDisabled } from "../copilotkit-inspector";

describe("isInspectorDisabled (NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR)", () => {
  it("defaults to false when unset", () => {
    expect(isInspectorDisabled(undefined)).toBe(false);
    expect(isInspectorDisabled("")).toBe(false);
  });

  it.each(["true", "TRUE", "True", "1", "yes", " true "])("is disabled by %j", (raw) => {
    expect(isInspectorDisabled(raw)).toBe(true);
  });

  it.each(["false", "0", "no", "off", "maybe"])("stays enabled for %j", (raw) => {
    // Anything not clearly "on" keeps the default, so a typo never silently
    // changes behaviour in the other direction.
    expect(isInspectorDisabled(raw)).toBe(false);
  });
});
