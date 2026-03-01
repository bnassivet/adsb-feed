//! Pure geodesic math for ADS-B range analysis.
//!
//! These functions serve as reference implementations to validate DuckDB SQL
//! results and are available for future reuse.

/// Earth's mean radius in nautical miles.
const EARTH_RADIUS_NM: f64 = 3440.065;

/// Great-circle distance between two points using the haversine formula.
///
/// Returns distance in nautical miles.
///
/// # Examples
/// ```
/// use adsb_data_engine::geo::haversine_nm;
/// let d = haversine_nm(0.0, 0.0, 0.0, 0.0);
/// assert!((d - 0.0).abs() < 1e-9);
/// ```
pub fn haversine_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let dlat = lat2 - lat1;
    let dlon = (lon2 - lon1).to_radians();

    let a = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_NM * a.sqrt().asin()
}

/// Initial (forward) bearing from point 1 to point 2.
///
/// Returns degrees in the range [0, 360).
///
/// # Examples
/// ```
/// use adsb_data_engine::geo::initial_bearing_deg;
/// let b = initial_bearing_deg(0.0, 0.0, 1.0, 0.0);
/// assert!((b - 0.0).abs() < 0.01); // Due north
/// ```
pub fn initial_bearing_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let dlon = (lon2 - lon1).to_radians();

    let y = dlon.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlon.cos();

    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

/// Map a bearing in degrees to a 10° sector index (0..35).
///
/// Sector 0 covers [355°, 5°), sector 1 covers [5°, 15°), etc.
///
/// # Examples
/// ```
/// use adsb_data_engine::geo::bearing_to_sector;
/// assert_eq!(bearing_to_sector(0.0), 0);   // North
/// assert_eq!(bearing_to_sector(90.0), 9);  // East
/// assert_eq!(bearing_to_sector(359.0), 0); // Just west of north → sector 0
/// ```
pub fn bearing_to_sector(bearing_deg: f64) -> usize {
    (((bearing_deg + 5.0) % 360.0) as usize) / 10
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_haversine_zero_distance() {
        let d = haversine_nm(45.0, -73.0, 45.0, -73.0);
        assert!((d - 0.0).abs() < 1e-9);
    }

    #[test]
    fn test_haversine_jfk_lhr() {
        // JFK (40.6413, -73.7781) → LHR (51.4700, -0.4543)
        // Known great-circle distance ≈ 2999 NM (±5 NM for coordinate precision)
        let d = haversine_nm(40.6413, -73.7781, 51.4700, -0.4543);
        assert!(
            (d - 2999.0).abs() < 10.0,
            "JFK→LHR distance {d} NM not within 10 NM of expected 2999"
        );
    }

    #[test]
    fn test_haversine_short_distance() {
        // ~1° latitude ≈ 60 NM
        let d = haversine_nm(45.0, 0.0, 46.0, 0.0);
        assert!(
            (d - 60.0).abs() < 0.5,
            "1° latitude distance {d} NM not within 0.5 NM of 60"
        );
    }

    #[test]
    fn test_bearing_due_north() {
        let b = initial_bearing_deg(45.0, -73.0, 46.0, -73.0);
        assert!(
            b.abs() < 0.01 || (b - 360.0).abs() < 0.01,
            "North bearing: {b}"
        );
    }

    #[test]
    fn test_bearing_due_east() {
        let b = initial_bearing_deg(0.0, 0.0, 0.0, 1.0);
        assert!((b - 90.0).abs() < 0.01, "East bearing: {b}");
    }

    #[test]
    fn test_bearing_due_south() {
        let b = initial_bearing_deg(46.0, -73.0, 45.0, -73.0);
        assert!((b - 180.0).abs() < 0.01, "South bearing: {b}");
    }

    #[test]
    fn test_bearing_due_west() {
        let b = initial_bearing_deg(0.0, 1.0, 0.0, 0.0);
        assert!((b - 270.0).abs() < 0.01, "West bearing: {b}");
    }

    #[test]
    fn test_sector_north() {
        assert_eq!(bearing_to_sector(0.0), 0);
        assert_eq!(bearing_to_sector(4.9), 0);
    }

    #[test]
    fn test_sector_east() {
        assert_eq!(bearing_to_sector(90.0), 9);
    }

    #[test]
    fn test_sector_south() {
        assert_eq!(bearing_to_sector(180.0), 18);
    }

    #[test]
    fn test_sector_west() {
        assert_eq!(bearing_to_sector(270.0), 27);
    }

    #[test]
    fn test_sector_wrap_around_355() {
        assert_eq!(bearing_to_sector(355.0), 0);
    }

    #[test]
    fn test_sector_wrap_around_359() {
        assert_eq!(bearing_to_sector(359.0), 0);
    }

    #[test]
    fn test_sector_boundary_5() {
        // 5.0° + 5.0 = 10.0 → sector 1
        assert_eq!(bearing_to_sector(5.0), 1);
    }

    #[test]
    fn test_sector_boundary_354() {
        // 354.9 + 5 = 359.9 → 359 / 10 = 35
        assert_eq!(bearing_to_sector(354.9), 35);
    }

    #[test]
    fn test_all_sectors_covered() {
        // Each 10° center bearing should map to sequential sectors
        for i in 0..36 {
            let center = (i * 10) as f64;
            let s = bearing_to_sector(center);
            let expected = ((center + 5.0) % 360.0) as usize / 10;
            assert_eq!(
                s, expected,
                "bearing {center}° → sector {s}, expected {expected}"
            );
        }
    }
}
