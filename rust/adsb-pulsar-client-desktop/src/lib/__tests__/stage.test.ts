import { describe, expect, it } from "vitest";
import { STAGES, resolveStage, stageOf } from "../stage";

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

describe("resolveStage", () => {
  it("prefers the stack name the backend reports", () => {
    // ADSB_STACK is what `make up-desktop STACK=dev` actually sets, and it is
    // the only source the stack config controls. source_id comes from the
    // app's OWN store, which a fresh stack starts empty -- that was the bug:
    // the badge silently fell back to the default id "kraspberryPi".
    expect(resolveStage("dev", "kraspberryPi")).toBe("dev");
    expect(resolveStage("prod", "anything")).toBe("prod");
  });

  it("falls back to the source_id suffix when there is no named stack", () => {
    // The unnamed stack reports no name, but a `-dev` id still says the stage.
    expect(resolveStage(null, "dev-laptop-dev")).toBe("dev");
  });

  it("is null when neither says anything", () => {
    expect(resolveStage(null, "kraspberryPi")).toBeNull();
    expect(resolveStage(null, undefined)).toBeNull();
  });

  it("shows an unknown stack name verbatim", () => {
    // A stack called "lab" is not one of STAGES, but the window still belongs
    // to it and saying so is the entire point of the badge.
    expect(resolveStage("lab", "kraspberryPi")).toBe("lab");
  });

  it("ignores the reserved name for the unnamed stack", () => {
    // stack.sh sends "" for the default stack, but be defensive: "default" is
    // its internal label and must never appear as a badge.
    expect(resolveStage("default", "dev-laptop-dev")).toBe("dev");
    expect(resolveStage("", "dev-laptop-dev")).toBe("dev");
  });
});
