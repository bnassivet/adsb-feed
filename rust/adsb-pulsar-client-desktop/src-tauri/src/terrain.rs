//! Ground elevation at a point, from Terrarium tiles, and sea depth from
//! EMODnet, for "What's here?" and the aircraft's height above ground.
//!
//! Terrarium (Mapzen open data on AWS, keyless) stores the height in each
//! pixel's colour: `R*256 + G + B/256 - 32768` metres. A tile is downloaded
//! once and kept on disk for good (terrain does not change); any point inside
//! it is then read locally. Sea is 0 m in these tiles, so depth comes from
//! EMODnet's point query, which over land answers a positive height instead.

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::Path;

/// ~9 × 7 km tiles at 45° N: a click or a passing aircraft needs one download.
pub const ZOOM: u32 = 12;
const TILE: usize = 256;
pub const USER_AGENT: &str = "adsb-pulsar-client-desktop (terrain)";

pub fn tile_url(z: u32, x: u32, y: u32) -> String {
    format!("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png")
}

/// The tile holding a point, and the point's position in it, in pixels.
pub fn locate(lat: f64, lon: f64, z: u32) -> Result<(u32, u32, f64, f64), String> {
    if !(lat.is_finite() && lon.is_finite() && lat.abs() <= 85.05 && lon.abs() <= 180.0) {
        return Err(format!("No elevation at {lat}, {lon}"));
    }
    let n = f64::from(1u32 << z);
    let fx = (lon + 180.0) / 360.0 * n;
    let fy = (1.0 - lat.to_radians().tan().asinh() / std::f64::consts::PI) / 2.0 * n;
    let (x, y) = (fx.floor().min(n - 1.0), fy.floor().min(n - 1.0));
    Ok((
        x as u32,
        y as u32,
        (fx - x) * TILE as f64,
        (fy - y) * TILE as f64,
    ))
}

pub fn decode_rgb(r: u8, g: u8, b: u8) -> f64 {
    f64::from(r) * 256.0 + f64::from(g) + f64::from(b) / 256.0 - 32768.0
}

/// A decoded tile: one height per pixel, metres.
pub struct TerrainTile {
    heights: Vec<f32>,
}

impl TerrainTile {
    pub fn from_png(bytes: &[u8]) -> Result<Self, String> {
        let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut reader = decoder
            .read_info()
            .map_err(|e| format!("terrain tile: {e}"))?;
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader
            .next_frame(&mut buf)
            .map_err(|e| format!("terrain tile: {e}"))?;
        let channels = match info.color_type {
            png::ColorType::Rgb => 3,
            png::ColorType::Rgba => 4,
            other => return Err(format!("terrain tile: unexpected colour type {other:?}")),
        };
        if info.width as usize != TILE || info.height as usize != TILE {
            return Err(format!(
                "terrain tile: {}×{} pixels",
                info.width, info.height
            ));
        }
        let heights = buf[..info.buffer_size()]
            .chunks_exact(channels)
            .map(|p| decode_rgb(p[0], p[1], p[2]) as f32)
            .collect();
        Ok(Self { heights })
    }

    fn at(&self, x: usize, y: usize) -> f64 {
        f64::from(self.heights[y.min(TILE - 1) * TILE + x.min(TILE - 1)])
    }

    /// Bilinear between the four pixel centres around the point.
    pub fn height_at(&self, px: f64, py: f64) -> f64 {
        let (x, y) = ((px - 0.5).max(0.0), (py - 0.5).max(0.0));
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (tx, ty) = (x - x.floor(), y - y.floor());
        let top = self.at(x0, y0) * (1.0 - tx) + self.at(x0 + 1, y0) * tx;
        let bottom = self.at(x0, y0 + 1) * (1.0 - tx) + self.at(x0 + 1, y0 + 1) * tx;
        top * (1.0 - ty) + bottom * ty
    }
}

/// The tile's PNG from disk, or downloaded and kept there for good.
pub async fn tile_bytes<F, Fut>(
    dir: &Path,
    z: u32,
    x: u32,
    y: u32,
    fetch: F,
) -> Result<Vec<u8>, String>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let path = dir.join(format!("{z}/{x}/{y}.png"));
    if let Ok(bytes) = std::fs::read(&path) {
        return Ok(bytes);
    }
    let bytes = fetch(tile_url(z, x, y)).await?;
    TerrainTile::from_png(&bytes)?; // a bad answer is not kept
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("png.tmp");
    if std::fs::write(&tmp, &bytes).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
    Ok(bytes)
}

pub fn depth_url(lat: f64, lon: f64) -> String {
    format!("https://rest.emodnet-bathymetry.eu/depth_sample?geom=POINT({lon}%20{lat})")
}

/// Sea depth at a point, metres (negative below sea level).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Depth {
    pub avg_m: f64,
    pub min_m: Option<f64>,
    pub max_m: Option<f64>,
}

#[derive(Deserialize)]
struct DepthSample {
    avg: Option<f64>,
    min: Option<f64>,
    max: Option<f64>,
}

/// EMODnet's answer; None over land, where it gives a positive height.
pub fn parse_depth(body: &[u8]) -> Result<Option<Depth>, String> {
    let s: DepthSample =
        serde_json::from_slice(body).map_err(|e| format!("EMODnet answer: {e}"))?;
    Ok(s.avg.filter(|a| *a < 0.0).map(|avg_m| Depth {
        avg_m,
        min_m: s.min,
        max_m: s.max,
    }))
}

/// What "What's here?" answers. Either half can fail on its own.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatIsHere {
    /// Ground height, metres; 0 at sea.
    pub elevation_m: Option<f64>,
    pub elevation_error: Option<String>,
    pub depth: Option<Depth>,
    pub depth_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 256×256 RGB tile whose height grows by 1 m per pixel to the right.
    fn ramp_png() -> Vec<u8> {
        let mut data = Vec::with_capacity(TILE * TILE * 3);
        for _y in 0..TILE {
            for x in 0..TILE {
                let h = 1000.0 + x as f64 + 32768.0;
                data.extend([(h / 256.0).floor() as u8, (h % 256.0) as u8, 0]);
            }
        }
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, TILE as u32, TILE as u32);
        enc.set_color(png::ColorType::Rgb);
        enc.write_header().unwrap().write_image_data(&data).unwrap();
        out
    }

    #[test]
    fn colours_decode_to_metres() {
        assert_eq!(decode_rgb(128, 0, 0), 0.0);
        assert_eq!(decode_rgb(146, 172, 128), 4780.5); // a summit
        assert_eq!(decode_rgb(127, 255, 0), -1.0);
    }

    #[test]
    fn points_are_located_in_their_tile() {
        let (x, y, px, py) = locate(0.0, 0.0, 1).unwrap();
        assert_eq!((x, y), (1, 1));
        assert!(px.abs() < 1e-9 && py.abs() < 1e-9);
        // Mont Blanc at z12 (tile numbers checked independently in Python).
        let (x, y, px, py) = locate(45.8326, 6.8652, 12).unwrap();
        assert_eq!((x, y), (2126, 1459));
        assert!((0.0..256.0).contains(&px) && (0.0..256.0).contains(&py));
        assert!(locate(89.0, 0.0, 12).is_err());
        assert!(locate(f64::NAN, 0.0, 12).is_err());
    }

    #[test]
    fn tiles_decode_and_interpolate() {
        let t = TerrainTile::from_png(&ramp_png()).unwrap();
        assert_eq!(t.height_at(10.5, 100.0), 1010.0, "a pixel centre");
        assert_eq!(t.height_at(11.0, 100.0), 1010.5, "between two centres");
        assert_eq!(t.height_at(0.0, 0.0), 1000.0, "clamped at the edge");
        assert!(TerrainTile::from_png(b"not a png").is_err());
    }

    #[tokio::test]
    async fn a_tile_is_downloaded_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let png = ramp_png();
        let got = tile_bytes(dir.path(), 12, 1, 2, |url| {
            assert!(url.ends_with("/terrarium/12/1/2.png"));
            let png = png.clone();
            async move { Ok(png) }
        })
        .await
        .unwrap();
        assert_eq!(got, png);
        assert!(dir.path().join("12/1/2.png").exists());
        let again = tile_bytes(dir.path(), 12, 1, 2, |_| async {
            panic!("cached: no request")
        })
        .await;
        assert_eq!(again.unwrap(), png);
    }

    #[tokio::test]
    async fn a_bad_tile_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let r = tile_bytes(dir.path(), 12, 1, 2, |_| async { Ok(b"<html>".to_vec()) }).await;
        assert!(r.is_err());
        assert!(!dir.path().join("12/1/2.png").exists());
    }

    #[test]
    fn depth_is_kept_at_sea_only() {
        let sea = br#"{"min":-23.24,"max":-22.01,"avg":-22.678669,"stdev":0.23}"#;
        assert_eq!(
            parse_depth(sea).unwrap(),
            Some(Depth {
                avg_m: -22.678669,
                min_m: Some(-23.24),
                max_m: Some(-22.01)
            })
        );
        let land = br#"{"avg":42.226036,"elementarySurfaces":1,"reference":{}}"#;
        assert_eq!(
            parse_depth(land).unwrap(),
            None,
            "over land EMODnet gives a height"
        );
        assert_eq!(parse_depth(b"{}").unwrap(), None);
        assert!(parse_depth(b"busy").is_err());
        assert_eq!(
            depth_url(48.3, -4.6),
            "https://rest.emodnet-bathymetry.eu/depth_sample?geom=POINT(-4.6%2048.3)"
        );
    }

    /// Live: Mont Blanc from Terrarium. `cargo test -- --ignored terrain`.
    #[tokio::test]
    #[ignore]
    async fn live_terrain_mont_blanc() {
        let client = reqwest::Client::new();
        let (x, y, px, py) = locate(45.8326, 6.8652, ZOOM).unwrap();
        let body = client
            .get(tile_url(ZOOM, x, y))
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let h = TerrainTile::from_png(&body).unwrap().height_at(px, py);
        assert!((4700.0..4810.0).contains(&h), "{h} m");
    }
}
