const EARTH_RADIUS_NM = 3440.065; // Earth mean radius in nautical miles

/**
 * Computes the great-circle distance between two points using the Haversine formula.
 * @returns Distance in nautical miles.
 */
export function haversineDistanceNm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}
