import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AircraftTable } from "../AircraftTable";
import type { AircraftTrack } from "@/lib/types";

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

describe("AircraftTable selection", () => {
  it("calls onSelectTrack with hex_ident on row click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <AircraftTable
        tracks={[makeTrack("ABC123")]}
        selectedHexIdent={null}
        onSelectTrack={onSelect}
      />,
    );

    const row = screen.getByTestId("row-ABC123");
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith("ABC123");
  });

  it("highlights selected row with bg-blue-900/40", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("ABC123"), makeTrack("DEF456")]}
        selectedHexIdent="ABC123"
      />,
    );

    const selectedRow = screen.getByTestId("row-ABC123");
    const otherRow = screen.getByTestId("row-DEF456");
    expect(selectedRow.className).toContain("bg-blue-900/40");
    expect(otherRow.className).not.toContain("bg-blue-900/40");
  });

  it("highlights selected history row", () => {
    render(
      <AircraftTable
        tracks={[]}
        historyTracks={[makeTrack("HIST01")]}
        selectedHexIdent="HIST01"
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
        selectedHexIdent={null}
        onSelectTrack={onSelect}
      />,
    );

    const row = screen.getByTestId("row-hist-HIST01");
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith("HIST01");
  });

  it("adds cursor-pointer to rows when onSelectTrack is provided", () => {
    render(
      <AircraftTable
        tracks={[makeTrack("ABC123")]}
        selectedHexIdent={null}
        onSelectTrack={() => {}}
      />,
    );

    const row = screen.getByTestId("row-ABC123");
    expect(row.className).toContain("cursor-pointer");
  });

  it("auto-scrolls selected row into view", () => {
    const { rerender } = render(
      <AircraftTable
        tracks={[makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")]}
        selectedHexIdent={null}
      />,
    );

    // Clear any prior calls, then select BBB
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    rerender(
      <AircraftTable
        tracks={[makeTrack("AAA"), makeTrack("BBB"), makeTrack("CCC")]}
        selectedHexIdent="BBB"
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
        selectedHexIdent="IMP001"
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
        selectedHexIdent={null}
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
        selectedHexIdent="DB01"
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
