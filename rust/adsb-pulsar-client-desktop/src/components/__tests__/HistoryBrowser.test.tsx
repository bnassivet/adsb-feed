import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryBrowser } from "@/components/HistoryBrowser";
import type { AircraftTrack } from "@/lib/types";

// Mock @/lib/commands module directly for component tests
vi.mock("@/lib/commands", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/commands")>();
  return {
    ...real,
    getStorageStats: vi.fn(),
    getAircraftSummary: vi.fn(),
    getTrajectory: vi.fn(),
  };
});
import {
  getStorageStats,
  getAircraftSummary,
  getTrajectory,
} from "@/lib/commands";

const STATS = {
  row_count: 42_000,
  db_size_bytes: 10_485_760, // 10 MB
  oldest_timestamp_ms: new Date("2026-02-20T10:00:00Z").getTime(),
  newest_timestamp_ms: new Date("2026-02-23T12:00:00Z").getTime(),
};

const SUMMARY = [
  {
    hex_ident: "AAAAAA",
    callsign: "SKY001",
    position_count: 100,
    first_seen_ms: 1_000_000,
    last_seen_ms: 2_000_000,
    min_altitude: 5000,
    max_altitude: 35000,
  },
];

const POSITIONS = [
  {
    hex_ident: "AAAAAA",
    callsign: "SKY001",
    latitude: 48.5,
    longitude: 2.3,
    altitude: 30000,
    ground_speed: 450,
    track: 270,
    vertical_rate: -200,
    squawk: null,
    is_on_ground: false,
    timestamp_ms: 1_500_000,
  },
];

describe("HistoryBrowser", () => {
  const onImportTracks = vi.fn((_tracks: AircraftTrack[]) => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows storage stats after mount", async () => {
    vi.mocked(getStorageStats).mockResolvedValue(STATS);
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => {
      expect(screen.getByText(/42,000/)).toBeInTheDocument();
    });
    expect(screen.getByText(/10\.0 MB/i)).toBeInTheDocument();
  });

  it("shows 'History unavailable' when storage is not available", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getStorageStats).mockResolvedValue("Storage not available" as any);
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => {
      expect(screen.getByText(/history unavailable/i)).toBeInTheDocument();
    });
  });

  it("shows 'Browse DB History' button when stats load successfully", async () => {
    vi.mocked(getStorageStats).mockResolvedValue(STATS);
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => {
      expect(screen.getByText(/browse db history/i)).toBeInTheDocument();
    });
  });

  it("shows aircraft list when Browse DB History is clicked", async () => {
    vi.mocked(getStorageStats).mockResolvedValue(STATS);
    vi.mocked(getAircraftSummary).mockResolvedValue(SUMMARY);
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => screen.getByText(/browse db history/i));
    await userEvent.click(screen.getByText(/browse db history/i));
    await waitFor(() => {
      expect(screen.getByText("SKY001")).toBeInTheDocument();
    });
  });

  it("calls onImportTracks with converted track when aircraft row is clicked", async () => {
    vi.mocked(getStorageStats).mockResolvedValue(STATS);
    vi.mocked(getAircraftSummary).mockResolvedValue(SUMMARY);
    vi.mocked(getTrajectory).mockResolvedValue(POSITIONS);
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => screen.getByText(/browse db history/i));
    await userEvent.click(screen.getByText(/browse db history/i));
    await waitFor(() => screen.getByText("SKY001"));
    await userEvent.click(screen.getByText("SKY001"));
    await waitFor(() => {
      expect(onImportTracks).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ hex_ident: "AAAAAA", callsign: "SKY001" }),
        ])
      );
    });
  });

  it("shows time range inputs when Browse is open", async () => {
    vi.mocked(getStorageStats).mockResolvedValue(STATS);
    vi.mocked(getAircraftSummary).mockResolvedValue(SUMMARY);
    render(<HistoryBrowser onImportTracks={onImportTracks} />);
    await waitFor(() => screen.getByText(/browse db history/i));
    await userEvent.click(screen.getByText(/browse db history/i));
    await waitFor(() => {
      expect(screen.getByLabelText(/start/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/end/i)).toBeInTheDocument();
    });
  });
});
