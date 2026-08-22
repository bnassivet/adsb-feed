import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ScenarioDescription,
  type ScenarioDescriptionProps,
} from "../ScenarioDescription";
import type { ScenarioTrack } from "@/lib/types";

const describeScenario = vi.fn();
vi.mock("@/lib/scenario-describe-api", () => ({
  describeScenario: (...args: unknown[]) => describeScenario(...args),
}));

function track(overrides: Partial<ScenarioTrack> = {}): ScenarioTrack {
  return {
    id: "t1",
    scenario_id: "s1",
    ordinal: 0,
    hex_ident: "AAA111",
    callsign: "HELI01",
    category: "helicopter",
    start_offset_s: 0,
    waypoints_json: JSON.stringify([
      {
        lat: 45.5,
        lng: -73.6,
        alt_ft: 1000,
        speed_kts: 80,
        heading_deg: 90,
        phase: "cruise",
        t_offset_s: 0,
      },
    ]),
    request_json: null,
    created_at_ms: 1000,
    updated_at_ms: 1000,
    ...overrides,
  };
}

function setup(overrides: Partial<ScenarioDescriptionProps> = {}) {
  const props: ScenarioDescriptionProps = {
    scenarioId: "s1",
    scenarioName: "Approach Rush",
    description: "",
    tracks: [track()],
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const view = render(<ScenarioDescription {...props} />);
  return { props, view };
}

beforeEach(() => {
  describeScenario.mockReset();
  describeScenario.mockResolvedValue("Two aircraft converge on the field.");
});

const editor = () => screen.getByRole("textbox", { name: /description/i });
const aiButton = () => screen.getByRole("button", { name: /generate/i });

describe("ScenarioDescription — manual editing", () => {
  it("shows the saved description", () => {
    setup({ description: "Busy evening arrivals." });
    expect(editor()).toHaveValue("Busy evening arrivals.");
  });

  it("saves what the user typed", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.type(editor(), "Hand written.");
    await user.click(screen.getByRole("button", { name: "Save description" }));

    expect(props.onSave).toHaveBeenCalledWith("s1", "Hand written.");
  });

  it("saves an empty description as a deliberate clear", async () => {
    const user = userEvent.setup();
    const { props } = setup({ description: "old text" });

    await user.clear(editor());
    await user.click(screen.getByRole("button", { name: "Save description" }));

    expect(props.onSave).toHaveBeenCalledWith("s1", "");
  });

  it("discards the draft on cancel", async () => {
    const user = userEvent.setup();
    const { props } = setup({ description: "original" });

    await user.clear(editor());
    await user.type(editor(), "scratch");
    await user.click(screen.getByRole("button", { name: "Discard description changes" }));

    expect(props.onSave).not.toHaveBeenCalled();
    expect(editor()).toHaveValue("original");
  });

  it("disables Save until the draft actually differs", async () => {
    const user = userEvent.setup();
    setup({ description: "original" });

    expect(screen.getByRole("button", { name: "Save description" })).toBeDisabled();

    await user.type(editor(), "!");
    expect(screen.getByRole("button", { name: "Save description" })).toBeEnabled();
  });

  // A description arriving from chat while the panel is open must not be
  // clobbered by a stale draft, but must also not wipe what the user is typing.
  it("adopts a new saved description when the user has no draft", () => {
    const { view, props } = setup({ description: "first" });
    view.rerender(<ScenarioDescription {...props} description="second" />);
    expect(editor()).toHaveValue("second");
  });

  it("resets the draft when the scenario changes", async () => {
    const user = userEvent.setup();
    const { view, props } = setup({ description: "first" });

    await user.type(editor(), " edited");
    view.rerender(
      <ScenarioDescription
        {...props}
        scenarioId="s2"
        scenarioName="Other"
        description="second"
      />,
    );

    expect(editor()).toHaveValue("second");
  });
});

describe("ScenarioDescription — LLM generation", () => {
  it("labels the AI action explicitly rather than hiding it behind an icon", () => {
    setup();
    const button = aiButton();
    expect(button).toHaveAccessibleName(/generate from trajectories/i);
    expect(button).toHaveAttribute("title", expect.stringMatching(/ai|agent/i));
  });

  it("sends the scenario name and a digest of every track", async () => {
    const user = userEvent.setup();
    setup({ tracks: [track(), track({ id: "t2", callsign: "ACA825" })] });

    await user.click(aiButton());

    await waitFor(() => expect(describeScenario).toHaveBeenCalled());
    const [name, digests] = describeScenario.mock.calls[0];
    expect(name).toBe("Approach Rush");
    expect(digests).toHaveLength(2);
    expect(digests[1].callsign).toBe("ACA825");
  });

  // The whole point of the draft: model output is reviewed, never auto-saved.
  it("puts the result in the editor without saving it", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(aiButton());

    await waitFor(() =>
      expect(editor()).toHaveValue("Two aircraft converge on the field."),
    );
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("lets the user edit the generated text before saving", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(aiButton());
    await waitFor(() =>
      expect(editor()).toHaveValue("Two aircraft converge on the field."),
    );

    await user.type(editor(), " Edited.");
    await user.click(screen.getByRole("button", { name: "Save description" }));

    expect(props.onSave).toHaveBeenCalledWith(
      "s1",
      "Two aircraft converge on the field. Edited.",
    );
  });

  it("shows progress and disables the button while generating", async () => {
    const user = userEvent.setup();
    let resolve!: (v: string) => void;
    describeScenario.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    setup();

    await user.click(aiButton());

    await waitFor(() => expect(aiButton()).toBeDisabled());
    expect(aiButton()).toHaveTextContent(/generating/i);

    resolve("done");
    await waitFor(() => expect(aiButton()).toBeEnabled());
  });

  it("is disabled with an explanation when the scenario has no tracks", () => {
    setup({ tracks: [] });
    const button = aiButton();

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/no tracks|add/i));
  });

  it("shows the failure inline and keeps the existing description", async () => {
    const user = userEvent.setup();
    describeScenario.mockRejectedValue(
      new Error("Could not reach the agent at http://localhost:8000."),
    );
    setup({ description: "existing text" });

    await user.click(aiButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/could not reach/i),
    );
    expect(editor()).toHaveValue("existing text");
  });

  it("clears a previous error on the next attempt", async () => {
    const user = userEvent.setup();
    describeScenario.mockRejectedValueOnce(new Error("boom"));
    setup();

    await user.click(aiButton());
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    await user.click(aiButton());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  // A generate started against one scenario must never land on another.
  it("aborts an in-flight generation when the scenario changes", async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    describeScenario.mockImplementation(
      (_n: string, _d: unknown, s: AbortSignal) => {
        signal = s;
        return new Promise<string>(() => {});
      },
    );
    const { view, props } = setup();

    await user.click(aiButton());
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);

    view.rerender(
      <ScenarioDescription {...props} scenarioId="s2" description="other" />,
    );

    expect(signal!.aborted).toBe(true);
  });

  it("aborts an in-flight generation on unmount", async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    describeScenario.mockImplementation(
      (_n: string, _d: unknown, s: AbortSignal) => {
        signal = s;
        return new Promise<string>(() => {});
      },
    );
    const { view } = setup();

    await user.click(aiButton());
    await waitFor(() => expect(signal).toBeDefined());

    view.unmount();
    expect(signal!.aborted).toBe(true);
  });

  it("does not report an abort as an error", async () => {
    const user = userEvent.setup();
    describeScenario.mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );
    setup();

    await user.click(aiButton());

    await waitFor(() => expect(aiButton()).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
