//! Finding the webview's IndexedDB files on disk, for display only.
//!
//! The map tile cache lives in IndexedDB, which the webview engine owns: the
//! page can name a database but never learn where it is stored. WebKit (macOS,
//! Linux) keeps each origin under a salted-hash directory with one
//! `IndexedDB.sqlite3` per database; WebView2 (Windows) keeps one LevelDB
//! directory per origin. Neither path is computable, so this searches the
//! engine's data directories for a file that mentions the database name.
//!
//! Read-only and best-effort: nothing here opens a database or writes, and a
//! miss just means the UI shows the database name without a path.

use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

/// How deep to descend below a root. WebKit's layout is
/// `WebsiteData/Default/<hash>/<hash>/IndexedDB/<hash>/IndexedDB.sqlite3`.
const MAX_DEPTH: usize = 8;

/// How much of each candidate file to scan. SQLite stores the small
/// `IDBDatabaseInfo` table in the first pages; LevelDB logs are small.
const SCAN_BYTES: u64 = 4 * 1024 * 1024;

/// Only our own databases may be looked up: this is not a general file sniffer.
pub const TILE_CACHE_DB_PREFIX: &str = "adsb-tile-cache-";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DatabaseLocation {
    /// The directory holding the database's files, if found.
    pub path: Option<String>,
    /// The engine directories searched -- shown when nothing was found.
    pub searched: Vec<String>,
}

/// The byte patterns a database name may be stored as: UTF-8, and UTF-16 in
/// both byte orders (WebKit's SQLite stores names as UTF-16LE text).
pub fn name_patterns(name: &str) -> Vec<Vec<u8>> {
    let units: Vec<u16> = name.encode_utf16().collect();
    vec![
        name.as_bytes().to_vec(),
        units.iter().flat_map(|u| u.to_le_bytes()).collect(),
        units.iter().flat_map(|u| u.to_be_bytes()).collect(),
    ]
}

/// True when the first `SCAN_BYTES` of `path` contain any of `patterns`.
pub fn file_mentions(path: &Path, patterns: &[Vec<u8>]) -> bool {
    let mut buf = Vec::new();
    let Ok(file) = File::open(path) else {
        return false;
    };
    if file.take(SCAN_BYTES).read_to_end(&mut buf).is_err() {
        return false;
    }
    patterns
        .iter()
        .filter(|p| !p.is_empty())
        .any(|p| buf.windows(p.len()).any(|w| w == p.as_slice()))
}

/// Does this directory hold the database? WebKit: `IndexedDB.sqlite3` (or its
/// WAL, before the first checkpoint). WebView2: any file of a
/// `*.indexeddb.leveldb` directory.
fn dir_holds(dir: &Path, patterns: &[Vec<u8>]) -> bool {
    let sqlite = dir.join("IndexedDB.sqlite3");
    if sqlite.is_file() {
        return file_mentions(&sqlite, patterns)
            || file_mentions(&dir.join("IndexedDB.sqlite3-wal"), patterns);
    }
    let is_leveldb = dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(".indexeddb.leveldb"));
    if is_leveldb && let Ok(entries) = std::fs::read_dir(dir) {
        return entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .any(|p| file_mentions(&p, patterns));
    }
    false
}

fn walk(dir: &Path, depth: usize, patterns: &[Vec<u8>]) -> Option<PathBuf> {
    if dir_holds(dir, patterns) {
        return Some(dir.to_path_buf());
    }
    if depth == MAX_DEPTH {
        return None;
    }
    let mut children: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) // no symlink loops
        .map(|e| e.path())
        .collect();
    children.sort(); // deterministic when two copies exist
    children
        .into_iter()
        .find_map(|c| walk(&c, depth + 1, patterns))
}

/// Search `roots` for the database named `db_name`; returns its directory.
pub fn find_indexeddb(roots: &[PathBuf], db_name: &str) -> Option<PathBuf> {
    let patterns = name_patterns(db_name);
    roots
        .iter()
        .filter(|r| r.is_dir())
        .find_map(|r| walk(r, 0, &patterns))
}

/// Where this platform's webview keeps its data for this app.
///
/// - macOS (WKWebView): `~/Library/WebKit/<bundle id>` for a bundled app, or
///   `~/Library/WebKit/<executable name>` for `tauri dev`, which runs a bare
///   binary. Both are listed; whichever exists is searched.
/// - Windows (WebView2): `<local app data>/EBWebView`.
/// - Linux (WebKitGTK): the app's data directories.
pub fn candidate_roots(
    identifier: &str,
    exe_name: Option<&str>,
    home: Option<&Path>,
    app_data: Option<&Path>,
    app_local_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if cfg!(target_os = "macos") {
        if let Some(home) = home {
            let webkit = home.join("Library/WebKit");
            roots.push(webkit.join(identifier));
            if let Some(exe) = exe_name {
                roots.push(webkit.join(exe));
            }
        }
    } else if cfg!(target_os = "windows") {
        if let Some(local) = app_local_data {
            roots.push(local.join("EBWebView"));
        }
    } else {
        roots.extend(app_data.map(Path::to_path_buf));
        roots.extend(app_local_data.map(Path::to_path_buf));
    }
    roots.dedup();
    roots
}

/// Locate the database and report what was searched.
pub fn locate(roots: &[PathBuf], db_name: &str) -> Result<DatabaseLocation, String> {
    if !db_name.starts_with(TILE_CACHE_DB_PREFIX) {
        return Err(format!("not a tile cache database: {db_name}"));
    }
    Ok(DatabaseLocation {
        path: find_indexeddb(roots, db_name).map(|p| p.display().to_string()),
        searched: roots.iter().map(|r| r.display().to_string()).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    /// A stand-in for WebKit's SQLite file: header noise, then the name as UTF-16LE.
    fn fake_sqlite(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let mut bytes = b"SQLite format 3\0".to_vec();
        bytes.extend(vec![0u8; 3000]);
        bytes.extend(b"DatabaseName");
        bytes.extend(utf16le(name));
        let file = dir.join("IndexedDB.sqlite3");
        fs::write(&file, bytes).unwrap();
        file
    }

    #[test]
    fn patterns_cover_utf8_and_both_utf16_orders() {
        let p = name_patterns("ab");
        assert!(p.contains(&b"ab".to_vec()));
        assert!(p.contains(&vec![b'a', 0, b'b', 0]));
        assert!(p.contains(&vec![0, b'a', 0, b'b']));
    }

    #[test]
    fn finds_webkit_sqlite_by_its_utf16_name() {
        let tmp = tempfile::tempdir().unwrap();
        let db_dir = tmp.path().join("WebsiteData/Default/h1/h1/IndexedDB/ABC");
        fake_sqlite(&db_dir, "adsb-tile-cache-default");
        let found = find_indexeddb(&[tmp.path().to_path_buf()], "adsb-tile-cache-default");
        assert_eq!(found, Some(db_dir));
    }

    #[test]
    fn tells_stacks_apart() {
        let tmp = tempfile::tempdir().unwrap();
        let dev = tmp.path().join("Default/a/a/IndexedDB/DEV");
        let prod = tmp.path().join("Default/a/a/IndexedDB/PROD");
        fake_sqlite(&dev, "adsb-tile-cache-default");
        fake_sqlite(&prod, "adsb-tile-cache-prod");
        let roots = [tmp.path().to_path_buf()];
        assert_eq!(find_indexeddb(&roots, "adsb-tile-cache-prod"), Some(prod));
        assert_eq!(find_indexeddb(&roots, "adsb-tile-cache-default"), Some(dev));
    }

    #[test]
    fn finds_a_name_still_only_in_the_write_ahead_log() {
        // A fresh database's first transaction may not be checkpointed yet.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("IndexedDB/X");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("IndexedDB.sqlite3"), b"SQLite format 3\0").unwrap();
        fs::write(
            dir.join("IndexedDB.sqlite3-wal"),
            utf16le("adsb-tile-cache-dev"),
        )
        .unwrap();
        let found = find_indexeddb(&[tmp.path().to_path_buf()], "adsb-tile-cache-dev");
        assert_eq!(found, Some(dir));
    }

    #[test]
    fn finds_a_webview2_leveldb_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp
            .path()
            .join("EBWebView/Default/IndexedDB/http_localhost_3200.indexeddb.leveldb");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("000003.log"),
            [b"\x00\x01".as_slice(), b"adsb-tile-cache-default"].concat(),
        )
        .unwrap();
        let found = find_indexeddb(&[tmp.path().to_path_buf()], "adsb-tile-cache-default");
        assert_eq!(found, Some(dir));
    }

    #[test]
    fn missing_roots_and_absent_databases_are_not_errors() {
        let tmp = tempfile::tempdir().unwrap();
        fake_sqlite(&tmp.path().join("IndexedDB/A"), "someone-else");
        let roots = [tmp.path().join("does-not-exist"), tmp.path().to_path_buf()];
        assert_eq!(find_indexeddb(&roots, "adsb-tile-cache-default"), None);
    }

    #[test]
    fn does_not_descend_without_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let mut deep = tmp.path().to_path_buf();
        for i in 0..(MAX_DEPTH + 2) {
            deep.push(format!("d{i}"));
        }
        fake_sqlite(&deep, "adsb-tile-cache-default");
        assert_eq!(
            find_indexeddb(&[tmp.path().to_path_buf()], "adsb-tile-cache-default"),
            None
        );
    }

    #[test]
    fn locate_refuses_names_that_are_not_ours() {
        assert!(locate(&[], "some-other-site").is_err());
    }

    #[test]
    fn locate_reports_the_path_and_the_roots_searched() {
        let tmp = tempfile::tempdir().unwrap();
        let db_dir = tmp.path().join("IndexedDB/A");
        fake_sqlite(&db_dir, "adsb-tile-cache-default");
        let loc = locate(&[tmp.path().to_path_buf()], "adsb-tile-cache-default").unwrap();
        assert_eq!(loc.path, Some(db_dir.display().to_string()));
        assert_eq!(loc.searched, vec![tmp.path().display().to_string()]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_roots_cover_bundle_id_and_dev_binary() {
        let roots = candidate_roots(
            "com.x.app",
            Some("app-bin"),
            Some(Path::new("/Users/u")),
            None,
            None,
        );
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/Users/u/Library/WebKit/com.x.app"),
                PathBuf::from("/Users/u/Library/WebKit/app-bin")
            ]
        );
    }

    #[test]
    fn file_mentions_reads_only_a_bounded_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("big");
        let mut bytes = vec![0u8; SCAN_BYTES as usize];
        bytes.extend(b"needle");
        fs::write(&f, bytes).unwrap();
        assert!(!file_mentions(&f, &[b"needle".to_vec()]));
    }
}
