import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AircraftTable } from "../AircraftTable";
import type { AircraftTrack, TrackSection } from "@/lib/types";

// jsdom doesn't implement scrollIntoView
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function makeTrack(hex: string, overrides?: Partial<AircraftTrack>): AircraftTrack {
  return {
    hex_ident: hex,
    callsign: hex.toUpperCase(),
    altitude: 35000,
    ground_speed: 450,
    track: 180,
    latitude: 45.5,
    longitude: -73.6,
    vertical_rate: 0,
    squawk: "1200",
    is_on_ground: false,
    timestamp: "",
    positions: [],
    first_seen: Date.now(),
    last_seen: Date.now(),
    message_count: 0,
    ...overrides,
  };
}

function makeHiddenSections(entries: Record<string, string[]>): Map<TrackSection, Set<string>> {
  return new Map(
    Object.entries(entries).map(([k, v]) => [k as TrackSection, new Set(v)])
  );
}

describe("AircraftTable selection", () => {
  it("calls onSelectTrack with hex_ident and modifier keys on row click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <AircraftTable
        tracks={[makeTrack("ABC123")]}
        selectedHexIdents={new Set()}
        onSelectTrack={onSelect}
      />,
    );

    const row = screen.getByTestId("row-ABC123");
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith("ABC123", expect.objectContaining({
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
    }));
  });

  it("highlights selected row with bg-blue-900/40", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("ABC123"), makeTrack("DEF456")]}
        selectedHexIdents={new Set(["ABC123"])}
      />,
    );

    const selectedRow = screen.getByTestId("row-ABC123");
    const otherRow = screen.getByTestId("row-DEF456");
    expect(selectedRow.className).toContain("bg-blue-900/40");
    expect(otherRow.className).not.toContain("bg-blue-900/40");
  });

  it("highlights multiple selected rows", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")]}
        selectedHexIdents={new Set(["AAA", "CCC"])}
      />,
    );

    expect(screen.getByTestId("row-AAA").className).toContain("bg-blue-900/40");
    expect(screen.getByTestId("row-BBB").className).not.toContain("bg-blue-900/40");
    expect(screen.getByTestId("row-CCC").className).toContain("bg-blue-900/40");
  });

  it("highlights selected history row", () => {
    render(
      <AircraftTable
        tracks={[]}
        historyTracks={[makeTrack("HIST01")]}
        selectedHexIdents={new Set(["HIST01"])}
      />,
    );

    const row = screen.getByTestId("row-hist-HIST01");
    expect(row.className).toContain("bg-blue-900/40");
  });

  it("calls onSelectTrack for history row clicks", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <AircraftTable
        tracks={[]}
        historyTracks={[makeTrack("HIST01")]}
        selectedHexIdents={new Set()}
        onSelectTrack={onSelect}
      />,
    );

    const row = screen.getByTestId("row-hist-HIST01");
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith("HIST01", expect.objectContaining({
      shiftKey: false,
    }));
  });

  it("adds cursor-pointer to rows when onSelectTrack is provided", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("ABC123")]}
        selectedHexIdents={new Set()}
        onSelectTrack={() => {}}
      />,
    );

    const row = screen.getByTestId("row-ABC123");
    expect(row.className).toContain("cursor-pointer");
  });

  it("auto-scrolls last-selected row into view", () => {
    const { rerender } = render(
      <AircraftTable
        tracks={[makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")]}
        selectedHexIdents={new Set()}
      />,
    );

    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    rerender(
      <AircraftTable
        tracks={[makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")]}
        selectedHexIdents={new Set(["BBB"])}
        lastSelectedHexIdent="BBB"
      />,
    );

    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
    });
  });
});

describe("collapsible sections", () => {
  it("renders history section header with track count", () => {
    render(<AircraftTable tracks={[]} historyTracks={[makeTrack("H1")]} />);
    expect(screen.getByText(/History/)).toBeInTheDocument();
    expect(screen.getByText(/\(1\)/)).toBeInTheDocument();
  });

  it("collapses history rows when header is clicked", async () => {
    const user = userEvent.setup();
    render(<AircraftTable tracks={[]} historyTracks={[makeTrack("H1")]} />);

    expect(screen.getByTestId("row-hist-H1")).toBeInTheDocument();

    await user.click(screen.getByTestId("history-section-header"));
    expect(screen.queryByTestId("row-hist-H1")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("history-section-header"));
    expect(screen.getByTestId("row-hist-H1")).toBeInTheDocument();
  });

  it("renders imported section header with track count", () => {
    render(<AircraftTable tracks={[]} importedTracks={[makeTrack("I1")]} />);
    expect(screen.getByText(/Imported/)).toBeInTheDocument();
  });

  it("collapses imported rows when header is clicked", async () => {
    const user = userEvent.setup();
    render(<AircraftTable tracks={[]} importedTracks={[makeTrack("I1")]} />);

    expect(screen.getByTestId("row-imported-I1")).toBeInTheDocument();

    await user.click(screen.getByTestId("imported-section-header"));
    expect(screen.queryByTestId("row-imported-I1")).not.toBeInTheDocument();
  });

  it("hides imported section when no imported tracks", () => {
    render(<AircraftTable tracks={[]} importedTracks={[]} />);
    expect(screen.queryByTestId("imported-section-header")).not.toBeInTheDocument();
  });
});

describe("imported row selection", () => {
  it("highlights selected imported row with indigo background", () => {
    const importedTrack = makeTrack("IMP001", { callsign: "TEST01" });
    render(
      <AircraftTable
        tracks={[]}
        importedTracks={[importedTrack]}
        selectedHexIdents={new Set(["IMP001"])}
        onSelectTrack={vi.fn()}
      />,
    );
    const row = screen.getByTestId("row-imported-IMP001");
    expect(row.className).toContain("bg-indigo-900/40");
    expect(row.className).not.toContain("opacity-60");
  });

  it("keeps opacity-60 on unselected imported row", () => {
    const importedTrack = makeTrack("IMP002", { callsign: "TEST02" });
    render(
      <AircraftTable
        tracks={[]}
        importedTracks={[importedTrack]}
        selectedHexIdents={new Set()}
        onSelectTrack={vi.fn()}
      />,
    );
    const row = screen.getByTestId("row-imported-IMP002");
    expect(row.className).toContain("opacity-60");
    expect(row.className).not.toContain("bg-indigo-900/40");
  });
});

describe("DB History section", () => {
  it("renders dbhistory section header when dbHistoryTracks exist", () => {
    render(<AircraftTable tracks={[]} dbHistoryTracks={[makeTrack("DB01")]} />);
    expect(screen.getByTestId("dbhistory-section-header")).toBeInTheDocument();
    expect(screen.getByText(/DB History/)).toBeInTheDocument();
  });

  it("hides dbhistory section when no dbHistoryTracks", () => {
    render(<AircraftTable tracks={[]} dbHistoryTracks={[]} />);
    expect(screen.queryByTestId("dbhistory-section-header")).not.toBeInTheDocument();
  });

  it("collapses/expands dbhistory rows on header click", async () => {
    const user = userEvent.setup();
    render(<AircraftTable tracks={[]} dbHistoryTracks={[makeTrack("DB01")]} />);

    expect(screen.getByTestId("row-dbhist-DB01")).toBeInTheDocument();

    await user.click(screen.getByTestId("dbhistory-section-header"));
    expect(screen.queryByTestId("row-dbhist-DB01")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("dbhistory-section-header"));
    expect(screen.getByTestId("row-dbhist-DB01")).toBeInTheDocument();
  });

  it("highlights selected dbhistory row with cyan background", () => {
    render(
      <AircraftTable
        tracks={[]}
        dbHistoryTracks={[makeTrack("DB01")]}
        selectedHexIdents={new Set(["DB01"])}
        onSelectTrack={vi.fn()}
      />,
    );
    const row = screen.getByTestId("row-dbhist-DB01");
    expect(row.className).toContain("bg-cyan-900/40");
  });
});

describe("Live section fold/unfold", () => {
  it("renders live section header with track count", () => {
    render(<AircraftTable tracks={[makeTrack("A1"), makeTrack("A2")]} />);
    expect(screen.getByTestId("live-section-header")).toBeInTheDocument();
    expect(screen.getByText(/Live/)).toBeInTheDocument();
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument();
  });

  it("hides live section header when no live tracks", () => {
    render(<AircraftTable tracks={[]} />);
    expect(screen.queryByTestId("live-section-header")).not.toBeInTheDocument();
  });

  it("collapses/expands live rows on header click", async () => {
    const user = userEvent.setup();
    render(<AircraftTable tracks={[makeTrack("A1")]} />);

    expect(screen.getByTestId("row-A1")).toBeInTheDocument();

    await user.click(screen.getByTestId("live-section-header"));
    expect(screen.queryByTestId("row-A1")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("live-section-header"));
    expect(screen.getByTestId("row-A1")).toBeInTheDocument();
  });

  it("keeps live rows expanded by default", () => {
    render(<AircraftTable tracks={[makeTrack("A1")]} />);
    expect(screen.getByTestId("row-A1")).toBeInTheDocument();
  });
});

describe("AircraftTable columns", () => {
  it("renders RxTS column header", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123")]} />);
    expect(screen.getByText("RxTS")).toBeInTheDocument();
  });

  it("renders Msg# column header", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123")]} />);
    expect(screen.getByText("Msg#")).toBeInTheDocument();
  });

  it("displays relative time in RxTS column", () => {
    const twoMinAgo = Date.now() - 120_000;
    render(<AircraftTable tracks={[makeTrack("ABC123", { last_seen: twoMinAgo })]} />);
    expect(screen.getByText("2m ago")).toBeInTheDocument();
  });

  it("displays message count in Msg# column", () => {
    render(<AircraftTable tracks={[makeTrack("ABC123", { message_count: 42 })]} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});

describe("AircraftTable map visibility toggle (section-aware)", () => {
  it("renders eye toggle button per row when onToggleMapVisibility is provided", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111"), makeTrack("BBB222")]}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={new Map()}
      />
    );
    expect(screen.getByTestId("visibility-live-AAA111")).toBeInTheDocument();
    expect(screen.getByTestId("visibility-live-BBB222")).toBeInTheDocument();
  });

  it("does not render eye toggle when onToggleMapVisibility is not provided", () => {
    render(<AircraftTable tracks={[makeTrack("AAA111")]} />);
    expect(screen.queryByTestId("visibility-live-AAA111")).not.toBeInTheDocument();
  });

  it("shows open eye icon when track is visible (not hidden)", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={new Map()}
      />
    );
    const btn = screen.getByTestId("visibility-live-AAA111");
    expect(btn.querySelector("[data-icon='eye-open']")).toBeInTheDocument();
  });

  it("shows closed eye icon when track is hidden in its section", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={makeHiddenSections({ live: ["AAA111"] })}
      />
    );
    const btn = screen.getByTestId("visibility-live-AAA111");
    expect(btn.querySelector("[data-icon='eye-closed']")).toBeInTheDocument();
  });

  it("clicking eye toggle calls onToggleMapVisibility with hex_ident and section", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        onToggleMapVisibility={onToggle}
        hiddenSections={new Map()}
      />
    );
    await user.click(screen.getByTestId("visibility-live-AAA111"));
    expect(onToggle).toHaveBeenCalledWith("AAA111", "live");
  });

  it("clicking eye toggle does not trigger row selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        onSelectTrack={onSelect}
        onToggleMapVisibility={onToggle}
        hiddenSections={new Map()}
      />
    );
    await user.click(screen.getByTestId("visibility-live-AAA111"));
    expect(onToggle).toHaveBeenCalledWith("AAA111", "live");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("dims the row when track is hidden from map in its section", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={makeHiddenSections({ live: ["AAA111"] })}
      />
    );
    const row = screen.getByTestId("row-AAA111");
    expect(row.className).toContain("opacity-40");
  });

  it("renders eye toggle for all section types with section-prefixed testids", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("LIVE01")]}
        historyTracks={[makeTrack("HIST01")]}
        dbHistoryTracks={[makeTrack("DB01")]}
        importedTracks={[makeTrack("IMP01")]}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={new Map()}
      />
    );
    expect(screen.getByTestId("visibility-live-LIVE01")).toBeInTheDocument();
    expect(screen.getByTestId("visibility-history-HIST01")).toBeInTheDocument();
    expect(screen.getByTestId("visibility-dbHistory-DB01")).toBeInTheDocument();
    expect(screen.getByTestId("visibility-imported-IMP01")).toBeInTheDocument();
  });
});

describe("section-independent visibility", () => {
  it("same hex hidden in live is visible in history", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        historyTracks={[makeTrack("AAA111")]}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={makeHiddenSections({ live: ["AAA111"] })}
      />
    );
    // Live row should have eye-closed
    const liveBtn = screen.getByTestId("visibility-live-AAA111");
    expect(liveBtn.querySelector("[data-icon='eye-closed']")).toBeInTheDocument();
    // History row should have eye-open
    const histBtn = screen.getByTestId("visibility-history-AAA111");
    expect(histBtn.querySelector("[data-icon='eye-open']")).toBeInTheDocument();
  });

  it("toggle callback receives correct section arg per section", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        historyTracks={[makeTrack("HIST01")]}
        dbHistoryTracks={[makeTrack("DB01")]}
        importedTracks={[makeTrack("IMP01")]}
        onToggleMapVisibility={onToggle}
        hiddenSections={new Map()}
      />
    );

    await user.click(screen.getByTestId("visibility-live-AAA111"));
    expect(onToggle).toHaveBeenCalledWith("AAA111", "live");

    await user.click(screen.getByTestId("visibility-history-HIST01"));
    expect(onToggle).toHaveBeenCalledWith("HIST01", "history");

    await user.click(screen.getByTestId("visibility-dbHistory-DB01"));
    expect(onToggle).toHaveBeenCalledWith("DB01", "dbHistory");

    await user.click(screen.getByTestId("visibility-imported-IMP01"));
    expect(onToggle).toHaveBeenCalledWith("IMP01", "imported");
  });

  it("hidden in one section does not dim row in another section", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        historyTracks={[makeTrack("AAA111")]}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={makeHiddenSections({ live: ["AAA111"] })}
      />
    );
    // Live row should be dimmed
    const liveRow = screen.getByTestId("row-AAA111");
    expect(liveRow.className).toContain("opacity-40");
    // History row: track is not hidden in history section, so the eye should be open
    const histBtn = screen.getByTestId("visibility-history-AAA111");
    expect(histBtn.querySelector("[data-icon='eye-open']")).toBeInTheDocument();
  });
});

describe("group header visibility toggle", () => {
  it("renders group eye icon on section header when onToggleGroupVisibility provided", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("A1")]}
        onToggleGroupVisibility={vi.fn()}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={new Map()}
      />
    );
    expect(screen.getByTestId("group-visibility-live")).toBeInTheDocument();
  });

  it("clicking group eye calls onToggleGroupVisibility with section and hex list", async () => {
    const user = userEvent.setup();
    const onGroupToggle = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("A1"), makeTrack("A2")]}
        historyTracks={[makeTrack("H1")]}
        onToggleGroupVisibility={onGroupToggle}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={new Map()}
      />
    );

    await user.click(screen.getByTestId("group-visibility-live"));
    expect(onGroupToggle).toHaveBeenCalledWith("live", expect.arrayContaining(["A1", "A2"]));
    expect(onGroupToggle.mock.calls[0][1]).toHaveLength(2);

    await user.click(screen.getByTestId("group-visibility-history"));
    expect(onGroupToggle).toHaveBeenCalledWith("history", ["H1"]);
  });

  it("group eye shows eye-closed when ALL tracks in section are hidden via hiddenSections", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("A1"), makeTrack("A2")]}
        onToggleGroupVisibility={vi.fn()}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={makeHiddenSections({ live: ["A1", "A2"] })}
      />
    );
    const btn = screen.getByTestId("group-visibility-live");
    expect(btn.querySelector("[data-icon='eye-closed']")).toBeInTheDocument();
  });

  it("group eye shows eye-open when only some tracks in section are hidden", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("A1"), makeTrack("A2")]}
        onToggleGroupVisibility={vi.fn()}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={makeHiddenSections({ live: ["A1"] })}
      />
    );
    const btn = screen.getByTestId("group-visibility-live");
    expect(btn.querySelector("[data-icon='eye-open']")).toBeInTheDocument();
  });

  it("group eye click does not collapse the section", async () => {
    const user = userEvent.setup();
    const onGroupToggle = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("A1")]}
        onToggleGroupVisibility={onGroupToggle}
        onToggleMapVisibility={vi.fn()}
        hiddenSections={new Map()}
      />
    );

    // Rows should be visible before and after group eye click
    expect(screen.getByTestId("row-A1")).toBeInTheDocument();
    await user.click(screen.getByTestId("group-visibility-live"));
    expect(screen.getByTestId("row-A1")).toBeInTheDocument();
    expect(onGroupToggle).toHaveBeenCalledWith("live", ["A1"]);
  });
});

describe("selection-aware eye toggle", () => {
  it("clicking eye on a multi-selected track calls onToggleMapVisibility for all selected in that section", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("A1"), makeTrack("A2"), makeTrack("A3")]}
        selectedHexIdents={new Set(["A1", "A2"])}
        onToggleMapVisibility={onToggle}
        hiddenSections={new Map()}
      />
    );
    // Click eye on A1 which is part of multi-selection
    await user.click(screen.getByTestId("visibility-live-A1"));
    // Should toggle both selected tracks in this section
    expect(onToggle).toHaveBeenCalledWith("A1", "live");
    expect(onToggle).toHaveBeenCalledWith("A2", "live");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("clicking eye on an unselected track only toggles that one track even with multi-select active", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("A1"), makeTrack("A2"), makeTrack("A3")]}
        selectedHexIdents={new Set(["A1", "A2"])}
        onToggleMapVisibility={onToggle}
        hiddenSections={new Map()}
      />
    );
    // Click eye on A3 which is NOT selected
    await user.click(screen.getByTestId("visibility-live-A3"));
    expect(onToggle).toHaveBeenCalledWith("A3", "live");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("clicking eye on a single-selected track toggles just that track", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("A1"), makeTrack("A2")]}
        selectedHexIdents={new Set(["A1"])}
        onToggleMapVisibility={onToggle}
        hiddenSections={new Map()}
      />
    );
    // Single selection — normal behavior
    await user.click(screen.getByTestId("visibility-live-A1"));
    expect(onToggle).toHaveBeenCalledWith("A1", "live");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("multi-select eye toggle only affects selected tracks within the same section", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    // A1 is in live, H1 is in history — both selected
    render(
      <AircraftTable
        tracks={[makeTrack("A1"), makeTrack("A2")]}
        historyTracks={[makeTrack("H1")]}
        selectedHexIdents={new Set(["A1", "A2", "H1"])}
        onToggleMapVisibility={onToggle}
        hiddenSections={new Map()}
      />
    );
    // Click eye on A1 (live section) — should only toggle A1, A2 (live selected), not H1
    await user.click(screen.getByTestId("visibility-live-A1"));
    expect(onToggle).toHaveBeenCalledWith("A1", "live");
    expect(onToggle).toHaveBeenCalledWith("A2", "live");
    expect(onToggle).not.toHaveBeenCalledWith("H1", expect.anything());
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});

describe("AircraftTable onRemoveTrack", () => {
  it("renders × button per row when onRemoveTrack is provided", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111"), makeTrack("BBB222")]}
        onRemoveTrack={vi.fn()}
      />
    );
    expect(screen.getByTestId("remove-AAA111")).toBeInTheDocument();
    expect(screen.getByTestId("remove-BBB222")).toBeInTheDocument();
  });

  it("does not render × button when onRemoveTrack is not provided", () => {
    render(<AircraftTable tracks={[makeTrack("AAA111")]} />);
    expect(screen.queryByTestId("remove-AAA111")).not.toBeInTheDocument();
  });

  it("clicking × calls onRemoveTrack with hex_ident", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        onRemoveTrack={onRemove}
      />
    );
    await user.click(screen.getByTestId("remove-AAA111"));
    expect(onRemove).toHaveBeenCalledWith("AAA111");
  });

  it("clicking × does not trigger row selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    render(
      <AircraftTable
        tracks={[makeTrack("AAA111")]}
        onSelectTrack={onSelect}
        onRemoveTrack={onRemove}
      />
    );
    await user.click(screen.getByTestId("remove-AAA111"));
    expect(onRemove).toHaveBeenCalledWith("AAA111");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
