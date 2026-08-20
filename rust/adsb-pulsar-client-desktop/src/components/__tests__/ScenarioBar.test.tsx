import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScenarioBar, type ScenarioBarProps } from "../ScenarioBar";
import type { Scenario } from "@/lib/types";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "s1",
    name: "Approach Rush",
    description: "",
    origin_lat: null,
    origin_lng: null,
    tags: null,
    created_at_ms: 1000,
    updated_at_ms: 1000,
    track_count: 2,
    ...overrides,
  };
}

function setup(overrides: Partial<ScenarioBarProps> = {}) {
  const props: ScenarioBarProps = {
    scenarios: [scenario()],
    activeScenarioId: "s1",
    storageUnavailable: false,
    tracks: [],
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onSaveDescription: vi.fn(),
    onDelete: vi.fn(),
    clock: { state: "stopped", elapsedS: 0 },
    durationS: 120,
    onStart: vi.fn(),
    onPause: vi.fn(),
    onStop: vi.fn(),
    onSeek: vi.fn(),
    ...overrides,
  };
  render(<ScenarioBar {...props} />);
  return props;
}

describe("ScenarioBar", () => {
  it("lists scenarios with their track counts", () => {
    setup();
    expect(screen.getByRole("option", { name: "Approach Rush (2)" })).toBeInTheDocument();
  });

  it("offers a no-scenario option so the panel can be used unsaved", () => {
    setup();
    expect(screen.getByRole("option", { name: "No scenario" })).toBeInTheDocument();
  });

  it("selects a scenario", async () => {
    const user = userEvent.setup();
    const props = setup({
      scenarios: [scenario(), scenario({ id: "s2", name: "Night Patrol" })],
      activeScenarioId: null,
    });

    await user.selectOptions(screen.getByLabelText("Active scenario"), "s2");
    expect(props.onSelect).toHaveBeenCalledWith("s2");
  });

  it("deselects when picking the no-scenario option", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.selectOptions(screen.getByLabelText("Active scenario"), "");
    expect(props.onSelect).toHaveBeenCalledWith(null);
  });

  it("creates a scenario from the name field", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByLabelText("New scenario"));
    await user.type(screen.getByLabelText("New scenario name"), "Fresh");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(props.onCreate).toHaveBeenCalledWith("Fresh");
  });

  it("ignores an empty name rather than creating a nameless scenario", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByLabelText("New scenario"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("renames the active scenario, prefilled with its current name", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByLabelText("Rename scenario"));
    const input = screen.getByLabelText("Rename scenario");
    expect(input).toHaveValue("Approach Rush");

    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    expect(props.onRename).toHaveBeenCalledWith("s1", "Renamed");
  });

  it("cannot rename or delete when no scenario is active", () => {
    setup({ activeScenarioId: null });
    expect(screen.getByLabelText("Rename scenario")).toBeDisabled();
    expect(screen.getByLabelText("Delete scenario")).toBeDisabled();
  });

  // Deleting destroys every track in the scenario, so it must not be one click.
  it("asks before deleting, naming what will be lost", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByLabelText("Delete scenario"));

    expect(screen.getByRole("alertdialog")).toHaveTextContent(/Approach Rush/);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/2 tracks/);
    expect(props.onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDelete).toHaveBeenCalledWith("s1");
  });

  it("can cancel the delete confirmation", async () => {
    const user = userEvent.setup();
    const props = setup();

    await user.click(screen.getByLabelText("Delete scenario"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("singularises the delete warning for a one-track scenario", async () => {
    const user = userEvent.setup();
    setup({ scenarios: [scenario({ track_count: 1 })] });

    await user.click(screen.getByLabelText("Delete scenario"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/1 track\?/);
  });

  describe("master transport", () => {
    it("is hidden when no scenario is active", () => {
      setup({ activeScenarioId: null });
      expect(screen.queryByTestId("scenario-transport")).not.toBeInTheDocument();
    });

    it("plays the whole scenario", async () => {
      const user = userEvent.setup();
      const props = setup();

      await user.click(screen.getByRole("button", { name: "Play scenario" }));
      expect(props.onStart).toHaveBeenCalled();
    });

    it("cannot play an empty scenario", () => {
      setup({ durationS: 0 });
      expect(screen.getByRole("button", { name: "Play scenario" })).toBeDisabled();
    });

    it("shows Pause while playing", async () => {
      const user = userEvent.setup();
      const props = setup({ clock: { state: "playing", elapsedS: 10 } });

      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(props.onPause).toHaveBeenCalled();
    });

    it("shows Resume when paused", () => {
      setup({ clock: { state: "paused", elapsedS: 10 } });
      expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    });

    it("cannot stop an already-stopped scenario", () => {
      setup();
      expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    });

    it("stops a running scenario", async () => {
      const user = userEvent.setup();
      const props = setup({ clock: { state: "playing", elapsedS: 10 } });

      await user.click(screen.getByRole("button", { name: "Stop" }));
      expect(props.onStop).toHaveBeenCalled();
    });

    it("shows elapsed against total time", () => {
      setup({ clock: { state: "playing", elapsedS: 90 } });
      expect(screen.getByText("1:30/2:00")).toBeInTheDocument();
    });

    it("scrubs the master timeline", () => {
      const props = setup();
      const slider = screen.getByLabelText("Scenario timeline");
      expect(slider).toHaveAttribute("max", "120");

      // Range inputs need a change event rather than user-event typing.
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      expect(props.onSeek).toBeDefined();
    });
  });

  describe("description editor", () => {
    it("shows the active scenario's description", () => {
      setup({ scenarios: [scenario({ description: "Busy evening arrivals." })] });
      expect(screen.getByLabelText("Scenario description")).toHaveValue(
        "Busy evening arrivals.",
      );
    });

    it("saves through the bar's callback", async () => {
      const user = userEvent.setup();
      const props = setup();

      await user.type(screen.getByLabelText("Scenario description"), "Typed.");
      await user.click(screen.getByRole("button", { name: "Save description" }));

      expect(props.onSaveDescription).toHaveBeenCalledWith("s1", "Typed.");
    });

    it("hides the editor when no scenario is selected", () => {
      setup({ activeScenarioId: null });
      expect(screen.queryByLabelText("Scenario description")).not.toBeInTheDocument();
    });

    it("hides the editor while renaming, so the two inputs cannot be confused", async () => {
      const user = userEvent.setup();
      setup();

      await user.click(screen.getByRole("button", { name: "Rename scenario" }));
      expect(screen.queryByLabelText("Scenario description")).not.toBeInTheDocument();
    });
  });

  it("explains itself instead of rendering controls when storage is unavailable", () => {
    setup({ storageUnavailable: true });
    expect(screen.getByTestId("scenario-unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Active scenario")).not.toBeInTheDocument();
  });
});
