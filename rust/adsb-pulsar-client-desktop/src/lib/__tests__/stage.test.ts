import { describe, expect, it } from "vitest";
import { STAGES, stageOf, titleWithStage } from "../stage";

describe("stageOf", () => {
  it("reads the stage from the source_id suffix", () => {
    // The convention scripts/stack.sh and deploy/README.md establish:
    // source_id = "<host-or-site>-<stage>".
    expect(stageOf("dev-laptop-dev")).toBe("dev");
    expect(stageOf("mac-desktop-prod")).toBe("prod");
    expect(stageOf("pi-roof-prod")).toBe("prod");
  });

  it("knows the same stages `make doctor` accepts", () => {
    // Drifting from stack.sh's list would mean doctor blesses an id the UI
    // then refuses to label.
    for (const s of STAGES) {
      expect(stageOf(`host-${s}`)).toBe(s);
    }
  });

  it("returns null when there is no recognised stage", () => {
    // Not an error: a one-node experiment has no reason to carry a stage, and
    // `doctor` already warns. The UI simply shows no badge.
    for (const id of ["dev-laptop", "kraspberryPi", "", "prod-machine", "x"]) {
      expect(stageOf(id)).toBeNull();
    }
  });

  it("ignores case and surrounding whitespace", () => {
    expect(stageOf("  Host-PROD  ")).toBe("prod");
  });

  it("takes the LAST segment, not any occurrence", () => {
    // "prod-box-dev" is a dev machine whose name happens to contain "prod".
    expect(stageOf("prod-box-dev")).toBe("dev");
  });

  it("handles an underscore-separated name", () => {
    // The id charset allows '_' too, so a name may not contain '-' at all.
    expect(stageOf("my_stack_prod")).toBe("prod");
    expect(stageOf("my_stack-prod")).toBe("prod");
  });

  it("is null for a missing id rather than throwing", () => {
    expect(stageOf(undefined)).toBeNull();
    expect(stageOf(null)).toBeNull();
  });
});

describe("titleWithStage", () => {
  it("appends the stage in brackets", () => {
    expect(titleWithStage("ADS-B Aircraft Tracker", "dev")).toBe(
      "ADS-B Aircraft Tracker [dev]",
    );
  });

  it("leaves the title alone when there is no stage", () => {
    // A single-stack user must not see an empty "[]".
    expect(titleWithStage("ADS-B Aircraft Tracker", null)).toBe(
      "ADS-B Aircraft Tracker",
    );
  });
});
