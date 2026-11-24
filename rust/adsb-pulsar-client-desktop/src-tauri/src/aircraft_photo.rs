//! Aircraft photo thumbnails for the details panel.
//!
//! The link comes from the flight-info cache (adsbdb → airport-data.com, or
//! hexdb.io when the airframe came from the hexdb fallback). The
//! bytes are fetched here, kept on disk one file per hex, and handed to the
//! webview as a `data:` URL: it works offline once fetched, and the webview's
//! CSP needs no new image host.
//!
//! The URL is read from our own cache, never taken from the frontend, and is
//! still checked against a host allow-list before anything is requested.

use base64::Engine;
use std::future::Future;
use std::path::{Path, PathBuf};

/// Hosts the flight-info sources link photos on. Anything else is refused.
const ALLOWED_HOSTS: &[&str] = &["airport-data.com", "image.airport-data.com", "hexdb.io"];

/// A thumbnail is a few KB; anything this large is not one.
pub const MAX_PHOTO_BYTES: usize = 2 * 1024 * 1024;

/// Cache file for one hex. `None` for anything that is not a 24-bit ICAO
/// address, so a hex can never name a path outside `dir`.
pub fn photo_path(dir: &Path, hex: &str) -> Option<PathBuf> {
    let h = hex.trim().to_uppercase();
    (h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| dir.join(format!("{h}.img")))
}

/// `https` on an allowed host, or why not.
pub fn check_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("Photo link is not https: {url}"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if ALLOWED_HOSTS.contains(&host) {
        Ok(())
    } else {
        Err(format!("Photo host not allowed: {host}"))
    }
}

/// The image type from its first bytes; `None` if it is not JPEG, PNG or WebP
/// (an HTML error page served with a 200, for instance).
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub fn data_url(bytes: &[u8]) -> Option<String> {
    let mime = sniff_mime(bytes)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// The photo for `hex` as a `data:` URL: from disk if kept, else fetched from
/// `url` and kept. `Ok(None)` when there is no link to fetch.
pub async fn load_photo<F, Fut>(
    dir: &Path,
    hex: &str,
    url: Option<&str>,
    fetch: F,
) -> Result<Option<String>, String>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let path = photo_path(dir, hex).ok_or_else(|| format!("Invalid ICAO hex '{hex}'"))?;
    if let Ok(bytes) = tokio::fs::read(&path).await
        && let Some(url) = data_url(&bytes)
    {
        return Ok(Some(url));
    }
    let Some(url) = url else { return Ok(None) };
    check_url(url)?;
    let bytes = fetch(url.to_string()).await?;
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err(format!("Photo too large ({} bytes)", bytes.len()));
    }
    let data = data_url(&bytes).ok_or("Photo link did not return an image")?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Photo cache: {e}"))?;
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("Photo cache: {e}"))?;
    Ok(Some(data))
}

/// The real fetch: GET with the shared user agent, size-capped.
pub async fn fetch_bytes(client: &reqwest::Client, url: String) -> Result<Vec<u8>, String> {
    let resp = client
        .get(&url)
        .header(
            reqwest::header::USER_AGENT,
            adsb_data_server::flight_info::USER_AGENT,
        )
        .send()
        .await
        .map_err(|e| format!("Photo unreachable ({e})"))?;
    if !resp.status().is_success() {
        return Err(format!("Photo: HTTP {}", resp.status().as_u16()));
    }
    if resp
        .content_length()
        .is_some_and(|n| n as usize > MAX_PHOTO_BYTES)
    {
        return Err("Photo too large".into());
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Photo: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F'];
    const THUMB: &str = "https://airport-data.com/images/aircraft/thumbnails/001/742/001742555.jpg";

    fn fake(
        answer: Result<Vec<u8>, String>,
    ) -> (
        Arc<Mutex<Vec<String>>>,
        impl FnOnce(String) -> std::future::Ready<Result<Vec<u8>, String>>,
    ) {
        let asked = Arc::new(Mutex::new(vec![]));
        let a = asked.clone();
        (asked, move |url: String| {
            a.lock().unwrap().push(url);
            std::future::ready(answer)
        })
    }

    #[test]
    fn path_only_for_valid_hex() {
        let d = Path::new("/c");
        assert_eq!(
            photo_path(d, "3c6444"),
            Some(PathBuf::from("/c/3C6444.img"))
        );
        assert_eq!(photo_path(d, "../etc"), None);
        assert_eq!(photo_path(d, "3C644"), None);
    }

    #[test]
    fn url_must_be_https_on_an_allowed_host() {
        assert!(check_url(THUMB).is_ok());
        assert!(check_url("https://image.airport-data.com/aircraft/1.jpg").is_ok());
        assert!(check_url("http://airport-data.com/x.jpg").is_err());
        assert!(check_url("https://evil.test/airport-data.com/x.jpg").is_err());
        assert!(check_url("https://airport-data.com.evil.test/x.jpg").is_err());
        assert!(check_url("https://localhost:8787/tools/x").is_err());
        assert!(check_url("https://hexdb.io/static/aircraft-images/EI-DCL-thumb.jpg").is_ok());
        assert!(check_url("https://hexdb.io.evil.test/x.jpg").is_err());
    }

    #[test]
    fn sniffs_images_and_rejects_html() {
        assert_eq!(sniff_mime(JPEG), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_mime(b"<html>404</html>"), None);
        assert!(
            data_url(JPEG)
                .unwrap()
                .starts_with("data:image/jpeg;base64,/9j/")
        );
    }

    #[tokio::test]
    async fn fetches_once_then_serves_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (asked, f) = fake(Ok(JPEG.to_vec()));
        let first = load_photo(dir.path(), "3C6444", Some(THUMB), f)
            .await
            .unwrap();
        assert!(first.unwrap().starts_with("data:image/jpeg"));
        assert_eq!(asked.lock().unwrap().as_slice(), [THUMB]);

        let (asked, f) = fake(Err("offline".into()));
        let again = load_photo(dir.path(), "3c6444", Some(THUMB), f)
            .await
            .unwrap();
        assert!(again.is_some());
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn no_link_means_no_photo_and_no_request() {
        let dir = tempfile::tempdir().unwrap();
        let (asked, f) = fake(Ok(JPEG.to_vec()));
        assert_eq!(
            load_photo(dir.path(), "3C6444", None, f).await.unwrap(),
            None
        );
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_disallowed_host_without_requesting() {
        let dir = tempfile::tempdir().unwrap();
        let (asked, f) = fake(Ok(JPEG.to_vec()));
        assert!(
            load_photo(dir.path(), "3C6444", Some("https://evil.test/x.jpg"), f)
                .await
                .is_err()
        );
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn non_image_is_an_error_and_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (_, f) = fake(Ok(b"<html>gone</html>".to_vec()));
        assert!(
            load_photo(dir.path(), "3C6444", Some(THUMB), f)
                .await
                .is_err()
        );
        assert!(!photo_path(dir.path(), "3C6444").unwrap().exists());
    }

    #[tokio::test]
    async fn oversized_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut big = JPEG.to_vec();
        big.resize(MAX_PHOTO_BYTES + 1, 0);
        let (_, f) = fake(Ok(big));
        let err = load_photo(dir.path(), "3C6444", Some(THUMB), f)
            .await
            .unwrap_err();
        assert!(err.contains("too large"));
    }
}
