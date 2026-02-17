import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { tracksToGeoJSON, geoJSONToTracks } from "./geojson";
import type { AircraftTrack } from "./types";
import type { TrackFeatureCollection } from "./geojson";

/** Export tracks to a GeoJSON file via native save dialog. Returns true if saved, false if cancelled. */
export async function exportTracksToFile(
  activeTracks: AircraftTrack[],
  historyTracks: AircraftTrack[],
): Promise<boolean> {
  const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultName = `adsb-tracks-${now}.geojson`;

  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
  });

  if (!path) return false;

  const geojson = tracksToGeoJSON(activeTracks, historyTracks);
  const content = JSON.stringify(geojson, null, 2);
  await writeTextFile(path, content);

  return true;
}

/** Import tracks from a GeoJSON file via native open dialog. Returns tracks or null if cancelled. */
export async function importTracksFromFile(): Promise<AircraftTrack[] | null> {
  const path = await open({
    multiple: false,
    filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
  });

  if (!path) return null;

  const content = await readTextFile(path as string);
  const geojson: TrackFeatureCollection = JSON.parse(content);

  return geoJSONToTracks(geojson);
}
