/** Tracks → flat typed arrays, the shape GPU layers want. Shared by the three GPU variants. */
import { isColumnar, type AircraftTrack } from "@/lib/types";

export interface Flat {
  count: number;
  lat: Float64Array;
  lng: Float64Array;
  /** NaN where altitude is unknown. */
  alt: Float64Array;
  /** Path i spans [starts[i], starts[i+1]). Length = tracks + 1. */
  starts: Uint32Array;
  /** Index of each track's last point. */
  heads: Uint32Array;
}

export function flatten(tracks: readonly AircraftTrack[]): Flat {
  let count = 0;
  for (const t of tracks) count += t.positions.length;
  const lat = new Float64Array(count);
  const lng = new Float64Array(count);
  const alt = new Float64Array(count);
  const starts = new Uint32Array(tracks.length + 1);
  const heads = new Uint32Array(tracks.length);

  let o = 0;
  tracks.forEach((t, i) => {
    starts[i] = o;
    const p = t.positions;
    if (isColumnar(p)) {
      lat.set(p.lat, o);
      lng.set(p.lng, o);
      alt.set(p.alt, o);
      o += p.length;
    } else {
      for (const [la, ln, al] of p) {
        lat[o] = la;
        lng[o] = ln;
        alt[o] = al ?? NaN;
        o++;
      }
    }
    heads[i] = o - 1;
  });
  starts[tracks.length] = o;
  return { count, lat, lng, alt, starts, heads };
}

const R = 6_378_137;

/** EPSG:4326 → EPSG:3857, as OpenLayers' fromLonLat. */
export function toMercator(lng: number, lat: number): [number, number] {
  const x = (R * lng * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}
