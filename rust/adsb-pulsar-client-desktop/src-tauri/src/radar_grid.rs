//! Météo-France radar mosaics: decoding ODIM_H5, projecting, rendering.
//!
//! The rainfall mosaic (`LAME_D_EAU`, 500 m) is an ODIM_H5 composite on a polar
//! stereographic grid. This module turns one into a PNG in Web Mercator over a
//! box around the receiver, so the webview can show it as a plain image
//! overlay. Pure functions only; fetching and caching live in `radar.rs`.

use chrono::{DateTime, NaiveDateTime, Utc};

/// WGS84.
const A: f64 = 6_378_137.0;
const F: f64 = 1.0 / 298.257_223_563;

/// North polar stereographic projection with a latitude of true scale
/// (`+proj=stere +lat_0=90 +lat_ts=… +lon_0=… +x_0=… +y_0=…`), ellipsoidal.
/// Snyder, *Map Projections: A Working Manual*, eqs. 21-33 to 21-40.
#[derive(Debug, Clone, PartialEq)]
pub struct Stereo {
    e: f64,
    lon0: f64,
    x0: f64,
    y0: f64,
    /// a · m_c / t_c: ρ = k · t(φ).
    k: f64,
}

impl Stereo {
    /// Parse a proj string. Only the north polar case is accepted: it is the
    /// one Météo-France uses, and the others need different formulas.
    pub fn parse(projdef: &str) -> Result<Self, String> {
        let get = |key: &str| {
            projdef
                .split_whitespace()
                .filter_map(|t| t.strip_prefix('+')?.split_once('='))
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v)
        };
        let num = |key: &str, default: f64| -> Result<f64, String> {
            get(key).map_or(Ok(default), |v| {
                v.parse().map_err(|_| format!("bad {key} in {projdef:?}"))
            })
        };
        if get("proj") != Some("stere") || (num("lat_0", f64::NAN)? - 90.0).abs() > 1e-9 {
            return Err(format!(
                "unsupported projection {projdef:?}: only north polar stereographic"
            ));
        }
        if let Some(e) = get("ellps").filter(|e| *e != "WGS84") {
            return Err(format!("unsupported ellipsoid {e}"));
        }
        let e = (2.0 * F - F * F).sqrt();
        let lat_ts = num("lat_ts", 90.0)?.to_radians();
        let k = if (lat_ts - std::f64::consts::FRAC_PI_2).abs() < 1e-12 {
            // True scale at the pole (k0 = 1).
            2.0 * A / ((1.0 + e).powf(1.0 + e) * (1.0 - e).powf(1.0 - e)).sqrt()
        } else {
            let m_c = lat_ts.cos() / (1.0 - e * e * lat_ts.sin().powi(2)).sqrt();
            A * m_c / t(lat_ts, e)
        };
        Ok(Stereo {
            e,
            lon0: num("lon_0", 0.0)?.to_radians(),
            x0: num("x_0", 0.0)?,
            y0: num("y_0", 0.0)?,
            k,
        })
    }

    /// (lon, lat) in degrees → (x, y) in metres.
    pub fn forward(&self, lon: f64, lat: f64) -> (f64, f64) {
        let rho = self.k * t(lat.to_radians(), self.e);
        let dl = lon.to_radians() - self.lon0;
        (self.x0 + rho * dl.sin(), self.y0 - rho * dl.cos())
    }

    /// (x, y) in metres → (lon, lat) in degrees. Only the tests need it so far
    /// (round trips, cell centres); a rain-rate readout on hover would too.
    #[cfg(test)]
    pub fn inverse(&self, x: f64, y: f64) -> (f64, f64) {
        let (dx, dy) = (x - self.x0, y - self.y0);
        let t = dx.hypot(dy) / self.k;
        let lon = self.lon0 + dx.atan2(-dy);
        // φ by fixed-point iteration (Snyder 7-9): converges in a few steps.
        let half_pi = std::f64::consts::FRAC_PI_2;
        let mut lat = half_pi - 2.0 * t.atan();
        for _ in 0..15 {
            let es = self.e * lat.sin();
            lat = half_pi - 2.0 * (t * ((1.0 - es) / (1.0 + es)).powf(self.e / 2.0)).atan();
        }
        (lon.to_degrees(), lat.to_degrees())
    }
}

/// Snyder's t(φ) for the ellipsoid.
fn t(lat: f64, e: f64) -> f64 {
    let es = e * lat.sin();
    (std::f64::consts::FRAC_PI_4 - lat / 2.0).tan() / ((1.0 - es) / (1.0 + es)).powf(e / 2.0)
}

/// A rainfall composite: accumulated rain per cell over a time window.
#[derive(Debug, Clone)]
pub struct RainField {
    pub proj: Stereo,
    /// Projected coordinates of the image's upper-left outer corner.
    pub x_ul: f64,
    pub y_ul: f64,
    pub xscale: f64,
    pub yscale: f64,
    pub xsize: usize,
    pub ysize: usize,
    /// Raw values, row 0 at the top.
    pub values: Vec<u16>,
    pub gain: f64,
    pub offset: f64,
    pub nodata: u16,
    pub undetect: u16,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

impl RainField {
    pub fn accumulation_minutes(&self) -> f64 {
        (self.end - self.start).num_seconds() as f64 / 60.0
    }

    /// The cell containing a point, as (row, col).
    pub fn cell_at(&self, lon: f64, lat: f64) -> Option<(usize, usize)> {
        let (x, y) = self.proj.forward(lon, lat);
        let col = (x - self.x_ul) / self.xscale;
        let row = (self.y_ul - y) / self.yscale;
        (col >= 0.0 && row >= 0.0 && (col as usize) < self.xsize && (row as usize) < self.ysize)
            .then_some((row as usize, col as usize))
    }

    /// Rain rate in mm/h at a cell; None where there is no radar coverage.
    /// Zero where the radars see no rain (`undetect`).
    pub fn rate_mm_h(&self, row: usize, col: usize) -> Option<f64> {
        let v = *self.values.get(row * self.xsize + col)?;
        if v == self.nodata {
            return None;
        }
        if v == self.undetect {
            return Some(0.0);
        }
        let mm = self.offset + self.gain * f64::from(v);
        Some(mm * 60.0 / self.accumulation_minutes().max(1.0))
    }
}

/// Decode an ODIM_H5 rainfall composite (quantity ACRR).
pub fn decode_odim(bytes: Vec<u8>) -> Result<RainField, String> {
    use hdf5_reader::Hdf5File;
    fn err(what: &str) -> impl Fn(hdf5_reader::error::Error) -> String + '_ {
        move |e| format!("radar file: {what}: {e}")
    }
    let f = Hdf5File::from_vec(bytes).map_err(err("not an HDF5 file"))?;
    let group = |path: &str| f.group(path).map_err(err(path));
    let where_ = group("where")?;
    let data_what = group("dataset1/data1/what")?;
    let set_what = group("dataset1/what")?;
    let num = |g: &hdf5_reader::group::Group, k: &str| {
        g.attribute(k).and_then(|a| a.read_as_f64()).map_err(err(k))
    };
    let text = |g: &hdf5_reader::group::Group, k: &str| {
        g.attribute(k).and_then(|a| a.read_string()).map_err(err(k))
    };

    let quantity = text(&data_what, "quantity")?;
    if quantity.trim() != "ACRR" {
        return Err(format!(
            "radar file: expected rain accumulation (ACRR), got {quantity}"
        ));
    }
    let proj = Stereo::parse(&text(&where_, "projdef")?)?;
    let (x_ul, y_ul) = proj.forward(num(&where_, "UL_lon")?, num(&where_, "UL_lat")?);
    let (xsize, ysize) = (
        num(&where_, "xsize")? as usize,
        num(&where_, "ysize")? as usize,
    );
    let values: Vec<u16> = f
        .dataset("dataset1/data1/data")
        .and_then(|d| d.read_array::<u16>())
        .map_err(err("dataset1/data1/data"))?
        .iter()
        .copied()
        .collect();
    if values.len() != xsize * ysize {
        return Err(format!(
            "radar file: {} values for a {xsize}x{ysize} grid",
            values.len()
        ));
    }
    let when = |d: &str, t: &str| -> Result<DateTime<Utc>, String> {
        let (d, t) = (text(&set_what, d)?, text(&set_what, t)?);
        NaiveDateTime::parse_from_str(&format!("{}{}", d.trim(), t.trim()), "%Y%m%d%H%M%S")
            .map(|n| n.and_utc())
            .map_err(|e| format!("radar file: bad time {d} {t}: {e}"))
    };
    Ok(RainField {
        proj,
        x_ul,
        y_ul,
        xscale: num(&where_, "xscale")?,
        yscale: num(&where_, "yscale")?,
        xsize,
        ysize,
        values,
        gain: num(&data_what, "gain")?,
        offset: num(&data_what, "offset")?,
        nodata: num(&data_what, "nodata")? as u16,
        undetect: num(&data_what, "undetect")? as u16,
        start: when("startdate", "starttime")?,
        end: when("enddate", "endtime")?,
    })
}

/// Rain-rate colour scale, mm/h → RGBA; None below the drizzle threshold.
/// Thresholds double from 1 mm/h, the usual radar-map progression.
pub fn rate_colour(mm_h: f64) -> Option<[u8; 4]> {
    let (_, hex) = SCALE.iter().rev().find(|(lower, _)| mm_h >= *lower)?;
    let c = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    Some([c(1), c(3), c(5), 255])
}

/// The legend: (lower bound in mm/h, RGB hex), lightest first. Shared with the
/// webview so the legend and the image cannot drift apart.
pub const SCALE: [(f64, &str); 8] = [
    (0.1, "#9bd3f5"),
    (1.0, "#4aa3f0"),
    (2.0, "#1f5fd6"),
    (4.0, "#29b34a"),
    (8.0, "#f5e130"),
    (16.0, "#f59a23"),
    (32.0, "#e8322b"),
    (64.0, "#c026d3"),
];

/// A lat/lng box: (south, west, north, east).
pub type LatLngBox = (f64, f64, f64, f64);

/// RGBA image of the field over `bbox`, in Web Mercator rows (what Leaflet's
/// image overlay expects), sampling the cell under each pixel's centre.
pub fn render(field: &RainField, bbox: LatLngBox, width: usize, height: usize) -> Vec<u8> {
    let (south, west, north, east) = bbox;
    let merc = |lat: f64| {
        (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0)
            .tan()
            .ln()
    };
    let (y_top, y_bottom) = (merc(north), merc(south));
    let mut out = vec![0u8; width * height * 4];
    for r in 0..height {
        let ym = y_top - (r as f64 + 0.5) / height as f64 * (y_top - y_bottom);
        let lat = (2.0 * ym.exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
        for c in 0..width {
            let lon = west + (c as f64 + 0.5) / width as f64 * (east - west);
            let colour = field
                .cell_at(lon, lat)
                .and_then(|(row, col)| field.rate_mm_h(row, col))
                .and_then(rate_colour);
            if let Some(px) = colour {
                let i = (r * width + c) * 4;
                out[i..i + 4].copy_from_slice(&px);
            }
        }
    }
    out
}

pub fn encode_png(rgba: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width as u32, height as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(|e| format!("png: {e}"))?;
        w.write_image_data(rgba).map_err(|e| format!("png: {e}"))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MF_PROJ: &str = "+proj=stere +lat_0=90 +lon_0=0 +lat_ts=45 +ellps=WGS84 +x_0=619652.07 +y_0=5262818.34 +datum=WGS84 ";
    const TINY: &[u8] = include_bytes!("testdata/odim_acrr_tiny.h5");

    fn close(a: (f64, f64), b: (f64, f64), tol: f64) -> bool {
        (a.0 - b.0).abs() < tol && (a.1 - b.1).abs() < tol
    }

    // --- Projection (references from pyproj with the same proj string) ------

    #[test]
    fn projects_like_pyproj() {
        let p = Stereo::parse(MF_PROJ).unwrap();
        for (lon, lat, x, y) in [
            (-1.61, 47.16, 499_419.661, 985_180.857),
            (2.35, 48.86, 787_529.828, 1_172_055.47),
            (-4.49, 48.39, 295_146.027, 1_130_357.126),
        ] {
            let got = p.forward(lon, lat);
            assert!(
                close(got, (x, y), 0.05),
                "({lon}, {lat}) → {got:?}, want ({x}, {y})"
            );
        }
    }

    #[test]
    fn grid_corners_land_where_the_file_says() {
        // UL outer corner at (0, 1 736 000), LL at (0, 0): 3472 cells of 500 m.
        let p = Stereo::parse(MF_PROJ).unwrap();
        assert!(close(p.forward(-9.965, 53.67), (0.0, 1_736_000.0), 0.05));
        assert!(close(
            p.forward(-6.715173408021557, 38.14493289858148),
            (0.0, 0.0),
            0.05
        ));
    }

    #[test]
    fn inverse_undoes_forward() {
        let p = Stereo::parse(MF_PROJ).unwrap();
        let (lon, lat) = p.inverse(500_000.0, -600_000.0);
        assert!(
            close((lon, lat), (-1.169166, 33.418821), 1e-6),
            "{lon}, {lat}"
        );
        for (lon, lat) in [(-1.61, 47.16), (8.5, 42.0), (-5.0, 52.0)] {
            let (x, y) = p.forward(lon, lat);
            assert!(close(p.inverse(x, y), (lon, lat), 1e-9));
        }
    }

    #[test]
    fn only_north_polar_stereographic_is_accepted() {
        assert!(Stereo::parse("+proj=merc +lon_0=0").is_err());
        assert!(Stereo::parse("+proj=stere +lat_0=-90 +lat_ts=-71").is_err());
        assert!(Stereo::parse("+proj=stere +lat_0=90 +lat_ts=60 +ellps=WGS84").is_ok());
    }

    // --- Decoding (fixture: same attributes as the real file, 6×8 cells) ------

    #[test]
    fn decodes_the_fixture() {
        let f = decode_odim(TINY.to_vec()).unwrap();
        assert_eq!((f.xsize, f.ysize), (6, 8));
        assert_eq!((f.xscale, f.yscale), (500.0, 500.0));
        assert!(close((f.x_ul, f.y_ul), (0.0, 1_736_000.0), 0.05));
        assert_eq!((f.nodata, f.undetect), (65535, 65534));
        assert_eq!(f.values[0 * 6 + 1], 10);
        assert_eq!(f.values[1 * 6 + 2], 551);
        assert_eq!(f.start.to_rfc3339(), "2026-11-19T03:05:00+00:00");
        assert_eq!(f.end.to_rfc3339(), "2026-11-19T03:10:00+00:00");
        assert_eq!(f.accumulation_minutes(), 5.0);
    }

    #[test]
    fn rejects_other_files() {
        assert!(decode_odim(b"not hdf5".to_vec()).is_err());
    }

    #[test]
    fn rates_are_per_hour() {
        let f = decode_odim(TINY.to_vec()).unwrap();
        // 551 × 0.01 = 5.51 mm in 5 minutes = 66.12 mm/h.
        assert!((f.rate_mm_h(1, 2).unwrap() - 66.12).abs() < 1e-9);
        assert_eq!(f.rate_mm_h(0, 0), Some(0.0));
        assert_eq!(f.rate_mm_h(2, 3), Some(0.0), "undetect: covered, no rain");
        assert_eq!(f.rate_mm_h(4, 4), None, "nodata: outside coverage");
    }

    #[test]
    fn finds_the_cell_under_a_point() {
        let f = decode_odim(TINY.to_vec()).unwrap();
        // Centre of row 1, col 2.
        let (lon, lat) = f.proj.inverse(2.5 * 500.0, 1_736_000.0 - 1.5 * 500.0);
        assert_eq!(f.cell_at(lon, lat), Some((1, 2)));
        assert_eq!(f.cell_at(2.35, 48.86), None, "outside this tiny grid");
    }

    // --- Colours and rendering ----------------------------------------------------

    #[test]
    fn colour_scale_steps_and_threshold() {
        assert_eq!(rate_colour(0.0), None);
        assert_eq!(rate_colour(0.05), None);
        let light = rate_colour(0.5).unwrap();
        let heavy = rate_colour(70.0).unwrap();
        assert_ne!(light, heavy);
        assert_eq!(rate_colour(1.0), rate_colour(1.9), "same band");
        assert_ne!(rate_colour(1.9), rate_colour(2.0), "next band");
        assert_eq!(heavy, [0xc0, 0x26, 0xd3, 255]);
    }

    #[test]
    fn renders_the_rain_where_it_is() {
        let f = decode_odim(TINY.to_vec()).unwrap();
        // A small box centred on cell (1, 2), entirely inside it: every pixel is that cell.
        let (lon, lat) = f.proj.inverse(2.5 * 500.0, 1_736_000.0 - 1.5 * 500.0);
        let d = 0.0005;
        let img = render(&f, (lat - d, lon - d, lat + d, lon + d), 4, 4);
        assert_eq!(img.len(), 4 * 4 * 4);
        assert_eq!(&img[0..4], &rate_colour(66.12).unwrap());
        // Far away: transparent.
        let img = render(&f, (40.0, 0.0, 40.1, 0.1), 2, 2);
        assert!(img.chunks(4).all(|p| p[3] == 0));
    }

    #[test]
    fn encodes_a_png() {
        let png = encode_png(&[255, 0, 0, 255, 0, 0, 0, 0], 2, 1).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }
}
