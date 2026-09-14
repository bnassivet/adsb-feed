//! Receiver-centred sampling grid.
//!
//! The service samples the weather model on a regular lat/lon grid around the
//! receiver. Cells are addressed row-major from the south-west corner:
//! `index = row * nlon + col`, where rows go north and columns go east. Every
//! per-point array in a [`WeatherSnapshot`](crate::WeatherSnapshot) uses that
//! order.

use serde::{Deserialize, Serialize};

/// Nautical miles per degree of latitude.
pub const NM_PER_DEG_LAT: f64 = 60.0;

/// Floor for `cos(latitude)` when widening the longitude extent. Without it a
/// receiver near a pole asks for an unbounded number of columns.
const MIN_COS_LAT: f64 = 0.1;

/// A regular lat/lon grid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GridSpec {
    /// Latitude of the southernmost row, degrees.
    pub lat0: f64,
    /// Longitude of the westernmost column, degrees, in `[-180, 180)`.
    pub lon0: f64,
    /// Row spacing, degrees.
    pub dlat: f64,
    /// Column spacing, degrees.
    pub dlon: f64,
    /// Number of rows.
    pub nlat: usize,
    /// Number of columns.
    pub nlon: usize,
}

/// Why a grid could not be built.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum GridError {
    #[error("spacing_deg must be a positive number, got {0}")]
    Spacing(f64),
    #[error("radius_nm must be a positive number, got {0}")]
    Radius(f64),
    #[error("latitude must be within [-90, 90], got {0}")]
    Latitude(f64),
}

impl GridSpec {
    /// Builds a grid covering at least `radius_nm` around `(lat, lon)`.
    ///
    /// The centre is snapped to a multiple of `spacing_deg`, so a receiver
    /// position edited by a few hundred metres keeps the same grid points: the
    /// cache stays aligned and the provider sees identical coordinates.
    pub fn centered(
        lat: f64,
        lon: f64,
        radius_nm: f64,
        spacing_deg: f64,
    ) -> Result<Self, GridError> {
        if !(spacing_deg.is_finite() && spacing_deg > 0.0) {
            return Err(GridError::Spacing(spacing_deg));
        }
        if !(radius_nm.is_finite() && radius_nm > 0.0) {
            return Err(GridError::Radius(radius_nm));
        }
        if !(lat.is_finite() && (-90.0..=90.0).contains(&lat)) {
            return Err(GridError::Latitude(lat));
        }

        let s = spacing_deg;
        let clat = (lat / s).round() * s;
        let clon = (lon / s).round() * s;

        // Rows beyond a pole do not exist, so clip them rather than wrapping.
        // Rounding before floor/ceil keeps 1.0000000000000002 from costing a row.
        let half_rows = (radius_nm / NM_PER_DEG_LAT / s).ceil() as i64;
        let k_min = (-half_rows).max(round9((-90.0 - clat) / s).ceil() as i64);
        let k_max = half_rows.min(round9((90.0 - clat) / s).floor() as i64);
        let nlat = (k_max - k_min + 1) as usize;

        // A degree of longitude shrinks with cos(latitude), so the same radius
        // needs more columns further from the equator. Never more than one lap.
        let cos_lat = clat.to_radians().cos().max(MIN_COS_LAT);
        let half_cols = (radius_nm / (NM_PER_DEG_LAT * cos_lat) / s).ceil() as usize;
        let max_cols = round9(360.0 / s).floor() as usize;
        let nlon = (2 * half_cols + 1).min(max_cols);

        Ok(Self {
            lat0: round6(clat + k_min as f64 * s),
            lon0: wrap_lon(clon - ((nlon - 1) / 2) as f64 * s),
            dlat: s,
            dlon: s,
            nlat,
            nlon,
        })
    }

    /// Number of grid points.
    pub fn len(&self) -> usize {
        self.nlat * self.nlon
    }

    /// Whether the grid has no points.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Row-major index of a cell.
    pub fn index(&self, row: usize, col: usize) -> usize {
        row * self.nlon + col
    }

    /// `(lat, lon)` of a cell, longitude wrapped into `[-180, 180)`.
    pub fn point(&self, row: usize, col: usize) -> (f64, f64) {
        (
            round6(self.lat0 + row as f64 * self.dlat),
            wrap_lon(self.lon0 + col as f64 * self.dlon),
        )
    }

    /// Every point, in row-major order.
    pub fn points(&self) -> Vec<(f64, f64)> {
        (0..self.nlat)
            .flat_map(|row| (0..self.nlon).map(move |col| (row, col)))
            .map(|(row, col)| self.point(row, col))
            .collect()
    }
}

/// Rounds to 1e-6 degrees (~0.1 m): coordinates end up in URLs and cache keys.
fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

fn round9(v: f64) -> f64 {
    (v * 1e9).round() / 1e9
}

fn wrap_lon(lon: f64) -> f64 {
    round6((lon + 180.0).rem_euclid(360.0) - 180.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RX_LAT: f64 = 46.7179;
    const RX_LON: f64 = -2.3372;

    fn default_grid() -> GridSpec {
        GridSpec::centered(RX_LAT, RX_LON, 300.0, 1.0).unwrap()
    }

    #[test]
    fn default_receiver_grid_has_expected_shape() {
        // ±300 NM is ±5° of latitude, and ±7.3° of longitude at 47°N.
        let g = default_grid();
        assert_eq!(g.nlat, 11);
        assert_eq!(g.nlon, 17);
        assert_eq!(g.len(), 187);
    }

    #[test]
    fn centre_is_snapped_to_the_spacing() {
        let g = default_grid();
        assert_eq!(g.point(5, 8), (47.0, -2.0));
    }

    #[test]
    fn grid_covers_the_requested_radius() {
        let g = default_grid();
        let lat_half_span = (g.nlat - 1) as f64 * g.dlat / 2.0;
        let lon_half_span = (g.nlon - 1) as f64 * g.dlon / 2.0;
        assert!(lat_half_span * NM_PER_DEG_LAT >= 300.0);
        let nm_per_deg_lon = NM_PER_DEG_LAT * 47.0_f64.to_radians().cos();
        assert!(lon_half_span * nm_per_deg_lon >= 300.0);
    }

    #[test]
    fn points_are_row_major_from_the_south_west() {
        let g = default_grid();
        let pts = g.points();
        assert_eq!(pts.len(), g.len());
        assert_eq!(pts[0], g.point(0, 0));
        assert_eq!(pts[g.nlon], g.point(1, 0));
        assert_eq!(pts[g.index(3, 4)], g.point(3, 4));
        // Rows go north, columns go east.
        assert!(g.point(1, 0).0 > g.point(0, 0).0);
        assert!(g.point(0, 1).1 > g.point(0, 0).1);
    }

    #[test]
    fn coordinates_carry_no_float_noise() {
        // They end up in a URL; 46.00000000000001 is a different cache key.
        for (lat, lon) in default_grid().points() {
            assert_eq!(lat, (lat * 1e6).round() / 1e6);
            assert_eq!(lon, (lon * 1e6).round() / 1e6);
        }
    }

    #[test]
    fn rejects_non_positive_spacing_and_radius() {
        assert_eq!(
            GridSpec::centered(RX_LAT, RX_LON, 300.0, 0.0),
            Err(GridError::Spacing(0.0))
        );
        assert_eq!(
            GridSpec::centered(RX_LAT, RX_LON, -1.0, 1.0),
            Err(GridError::Radius(-1.0))
        );
        assert!(matches!(
            GridSpec::centered(RX_LAT, RX_LON, 300.0, f64::NAN),
            Err(GridError::Spacing(_))
        ));
    }

    #[test]
    fn rejects_out_of_range_latitude() {
        assert_eq!(
            GridSpec::centered(91.0, 0.0, 300.0, 1.0),
            Err(GridError::Latitude(91.0))
        );
    }

    #[test]
    fn near_a_pole_rows_stay_in_range_and_columns_stay_bounded() {
        let g = GridSpec::centered(89.0, 0.0, 600.0, 1.0).unwrap();
        for (lat, _) in g.points() {
            assert!((-90.0..=90.0).contains(&lat), "lat {lat} out of range");
        }
        assert!(g.nlon <= 360, "nlon {} wraps the globe", g.nlon);
    }

    #[test]
    fn longitudes_wrap_across_the_antimeridian() {
        let g = GridSpec::centered(0.0, 179.0, 300.0, 1.0).unwrap();
        for (_, lon) in g.points() {
            assert!((-180.0..180.0).contains(&lon), "lon {lon} not wrapped");
        }
    }
}
