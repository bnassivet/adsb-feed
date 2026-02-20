import { describe, it, expect, beforeEach } from "vitest";
import "@/test/mocks/tauri";
import {
  mockSaveDialogResponse,
  mockOpenDialogResponse,
  mockWriteTextFile,
  mockReadTextFile,
  mockReadFileResponse,
} from "@/test/mocks/tauri";
import { exportTracksToFile, importTracksFromFile } from "@/lib/file-io";
import { tracksToGeoJSON } from "@/lib/geojson";
import type { AircraftTrack } from "@/lib/types";

function makeTrack(overrides: Partial<AircraftTrack> = {}): AircraftTrack {
  return {
    hex_ident: "A1B2C3",
    callsign: "AAL123",
    altitude: 35000,
    ground_speed: 450,
    track: 90,
    latitude: 48.86,
    longitude: 2.35,
    vertical_rate: 0,
    squawk: "1200",
    is_on_ground: false,
    timestamp: "2026/02/16 14:30:00.000",
    positions: [[48.86, 2.35, 35000]],
    first_seen: 1739712600000,
    last_seen: 1739712600000,
    message_count: 100,
    ...overrides,
  };
}

describe("exportTracksToFile", () => {
  beforeEach(() => {
    mockWriteTextFile.mockClear();
  });

  it("opens save dialog and writes GeoJSON to selected path", async () => {
    mockSaveDialogResponse("/tmp/tracks.geojson");
    const track = makeTrack();

    const result = await exportTracksToFile([track], []);

    expect(result).toBe(true);
    expect(mockWriteTextFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteTextFile.mock.calls[0];
    expect(path).toBe("/tmp/tracks.geojson");
    const parsed = JSON.parse(content as string);
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.features).toHaveLength(1);
  });

  it("returns false when user cancels save dialog", async () => {
    mockSaveDialogResponse(null);

    const result = await exportTracksToFile([], []);

    expect(result).toBe(false);
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });
});

describe("importTracksFromFile", () => {
  beforeEach(() => {
    mockReadTextFile.mockClear();
  });

  it("opens file dialog, reads file, returns parsed tracks", async () => {
    const track = makeTrack();
    const geojson = tracksToGeoJSON([track]);
    mockOpenDialogResponse("/tmp/tracks.geojson");
    mockReadFileResponse(JSON.stringify(geojson));

    const result = await importTracksFromFile();

    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
    expect(result![0].hex_ident).toBe("A1B2C3");
  });

  it("returns null when user cancels open dialog", async () => {
    mockOpenDialogResponse(null);

    const result = await importTracksFromFile();

    expect(result).toBeNull();
    expect(mockReadTextFile).not.toHaveBeenCalled();
  });

  it("throws on invalid JSON", async () => {
    mockOpenDialogResponse("/tmp/bad.json");
    mockReadFileResponse("not json");

    await expect(importTracksFromFile()).rejects.toThrow();
  });
});
