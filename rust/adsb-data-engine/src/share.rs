//! Exposing the managed DuckDB database over the Quack protocol.
//!
//! [Quack](https://duckdb.org/docs/current/quack/overview) turns a DuckDB
//! instance into an HTTP server that other DuckDB clients can `ATTACH` to.
//! That is the whole purpose of this module: the engine keeps sole ownership
//! of the database and remains the only writer on the ingest path, while
//! other processes — the webapp, spark-adsb, an ad-hoc `duckdb` CLI — get
//! live SQL access instead of being locked out by the exclusive file lock.
//!
//! # Two things to know before using this
//!
//! **The extension is fetched at runtime.** `quack` is *not* statically
//! linked into the bundled DuckDB build (`libduckdb-sys` links only
//! `core_functions`, `parquet` and `json`), so the first `INSTALL quack`
//! downloads it from `extensions.duckdb.org`. Offline, sharing is simply
//! unavailable — which is why every failure here is reported as
//! [`ShareStatus::Unavailable`] rather than propagated as a fatal error.
//!
//! **A token grants full read *and* write access** to every table, because
//! the server runs with Quack's default permissive authorization. Quack's
//! authorization hook is a SQL macro, and macros cannot execute DML, so
//! table-level rules are not expressible without shipping a custom DuckDB
//! extension. Bind to localhost unless you have fronted it with a
//! TLS-terminating reverse proxy — the Quack server does no TLS itself.

use crate::error::StorageError;
use crate::types::{RemoteConfig, ShareConfig, ShareInfo};
use duckdb::Connection;
use tracing::info;

/// Escape a single-quoted SQL string literal.
///
/// The URI and token reach us from configuration, and `quack_serve` takes
/// them positionally in SQL text, so they must be escaped rather than
/// interpolated raw.
fn sql_quote(value: &str) -> String {
    value.replace('\'', "''")
}

/// Tables recorded by the daemon, which a remote client reads rather than owns.
///
/// The complement -- `events_of_interest`, `scenarios`, `scenario_tracks` --
/// are *authored* by whoever is using the app, so they stay in the local
/// database even in remote mode.
pub const OBSERVED_TABLES: [&str; 4] = ["positions", "raw_messages", "flights", "status_events"];

/// Whether a Quack URI names a local host.
///
/// DuckDB's client defaults `DISABLE_SSL` to true for `localhost`, `127.0.0.1`
/// and `::1`, and false everywhere else -- i.e. a client attaching to a remote
/// daemon assumes HTTPS. Since the Quack server terminates no TLS itself, a
/// bare remote daemon needs the flag set explicitly.
fn is_local_uri(uri: &str) -> bool {
    let rest = uri.strip_prefix("quack:").unwrap_or(uri);
    let host = if let Some(stripped) = rest.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        rest.split(':').next().unwrap_or("")
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Builds the `ATTACH` statement for a remote daemon.
///
/// The token is escaped rather than interpolated raw: it reaches us from
/// configuration and lands in SQL text.
pub fn attach_sql(config: &RemoteConfig, alias: &str) -> String {
    let mut opts: Vec<String> = vec!["TYPE quack".to_string()];

    if let Some(token) = &config.token {
        opts.push(format!("TOKEN '{}'", sql_quote(token)));
    }

    let disable_ssl = config.disable_ssl.unwrap_or(!is_local_uri(&config.uri));
    if disable_ssl {
        opts.push("DISABLE_SSL true".to_string());
    }

    format!(
        "ATTACH '{}' AS {} ({})",
        sql_quote(&config.uri),
        alias,
        opts.join(", ")
    )
}

/// Builds views that point the observed table names at the attached catalog.
///
/// This is what keeps the change small: every existing query references bare
/// `positions`, `flights` and so on, so pointing those names at `edge.*` makes
/// the whole read path work in remote mode without touching any query SQL.
pub fn remote_view_sql(alias: &str) -> String {
    OBSERVED_TABLES
        .iter()
        .map(|t| format!("CREATE OR REPLACE VIEW {t} AS SELECT * FROM {alias}.{t};"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Install and load the `quack` extension.
///
/// Reaches the network on first use; subsequent calls hit the local
/// extension cache.
pub(crate) fn load_extension(conn: &Connection) -> Result<(), StorageError> {
    conn.execute_batch("INSTALL quack; LOAD quack;")?;
    Ok(())
}

/// Extracts the port from an HTTP URL, e.g. `http://localhost:9494` -> `9494`.
fn port_of(url: &str) -> Option<&str> {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host_port = after_scheme.split('/').next().unwrap_or(after_scheme);
    let (_, port) = host_port.rsplit_once(':')?;
    (!port.is_empty() && port.chars().all(|c| c.is_ascii_digit())).then_some(port)
}

/// Whether a `quack:` URI already names a port.
///
/// IPv6 literals are bracketed (`quack:[::1]:1234`), so a bare `:` is not
/// enough to decide — the colons inside the brackets are part of the address.
fn has_port(uri: &str) -> bool {
    let rest = uri.strip_prefix("quack:").unwrap_or(uri);
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    match rest.rfind(']') {
        Some(close) => rest[close + 1..].starts_with(':'),
        None => rest.contains(':'),
    }
}

/// Returns `listen_uri` with the port made explicit, taking it from
/// `listen_url` when the URI omits it. Falls back to the URI unchanged if the
/// port cannot be determined — a portless URI still connects on the default.
fn qualify_uri(listen_uri: &str, listen_url: &str) -> String {
    if has_port(listen_uri) {
        return listen_uri.to_string();
    }
    match port_of(listen_url) {
        Some(port) => format!("{listen_uri}:{port}"),
        None => listen_uri.to_string(),
    }
}

/// Start a Quack server on `conn`'s database instance.
///
/// Returns the coordinates clients need: the listen URI, the HTTP URL, and
/// the auth token (generated by DuckDB when `cfg.token` is `None`).
pub(crate) fn start(conn: &Connection, cfg: &ShareConfig) -> Result<ShareInfo, StorageError> {
    load_extension(conn)?;

    let mut args = format!("'{}'", sql_quote(&cfg.uri));
    if let Some(token) = &cfg.token {
        args.push_str(&format!(", token := '{}'", sql_quote(token)));
    }
    if cfg.allow_other_hostname {
        args.push_str(", allow_other_hostname := true");
    }

    // `quack_serve` returns exactly one row: (listen_uri, listen_url, auth_token).
    let raw: (String, String, String) =
        conn.query_row(&format!("CALL quack_serve({args})"), [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;

    // When no port was requested, `listen_uri` comes back without one
    // ("quack:localhost") and the resolved port appears only in `listen_url`.
    // Both forms connect, but callers display `listen_uri`, so a reader would
    // never learn which port is actually in use. Normalise it here so every
    // consumer gets a URI that names the port.
    let info = ShareInfo {
        listen_uri: qualify_uri(&raw.0, &raw.1),
        listen_url: raw.1,
        token: raw.2,
    };

    info!("Database shared over Quack at {}", info.listen_uri);
    Ok(info)
}

/// Stop the Quack server listening on `listen_uri`.
///
/// Pass the `listen_uri` returned by [`start`], not the configured URI — the
/// former has the port resolved.
pub(crate) fn stop(conn: &Connection, listen_uri: &str) -> Result<(), StorageError> {
    conn.execute_batch(&format!("CALL quack_stop('{}')", sql_quote(listen_uri)))?;
    info!("Stopped sharing {listen_uri}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualify_uri_adds_the_resolved_port_when_the_uri_omits_it() {
        // The default case: ShareConfig::default() asks for "quack:localhost",
        // and the port comes back only in the URL.
        assert_eq!(
            qualify_uri("quack:localhost", "http://localhost:9494"),
            "quack:localhost:9494"
        );
    }

    #[test]
    fn qualify_uri_leaves_an_explicit_port_alone() {
        assert_eq!(
            qualify_uri("quack:localhost:9999", "http://localhost:9999"),
            "quack:localhost:9999"
        );
        assert_eq!(
            qualify_uri("quack:0.0.0.0:9500", "http://0.0.0.0:9500"),
            "quack:0.0.0.0:9500"
        );
    }

    #[test]
    fn qualify_uri_handles_ipv6_literals() {
        // Colons inside the brackets are the address, not a port.
        assert_eq!(
            qualify_uri("quack:[::1]", "http://[::1]:9494"),
            "quack:[::1]:9494"
        );
        assert_eq!(
            qualify_uri("quack:[::1]:1234", "http://[::1]:1234"),
            "quack:[::1]:1234"
        );
    }

    #[test]
    fn qualify_uri_falls_back_when_the_port_cannot_be_read() {
        // Never fabricate a port: a portless URI still connects on the default.
        assert_eq!(
            qualify_uri("quack:localhost", "http://localhost"),
            "quack:localhost"
        );
        assert_eq!(qualify_uri("quack:localhost", ""), "quack:localhost");
    }

    #[test]
    fn qualify_uri_accepts_the_double_slash_form() {
        assert_eq!(
            qualify_uri("quack://localhost", "http://localhost:9494"),
            "quack://localhost:9494"
        );
    }

    #[test]
    fn sql_quote_escapes_embedded_single_quotes() {
        assert_eq!(sql_quote("quack:localhost"), "quack:localhost");
        assert_eq!(sql_quote("it's"), "it''s");
        // The case that matters: a token crafted to break out of the literal.
        assert_eq!(
            sql_quote("'); DROP TABLE positions; --"),
            "''); DROP TABLE positions; --"
        );
    }
}

#[cfg(test)]
mod attach_tests {
    use super::*;

    fn cfg(uri: &str, token: Option<&str>) -> RemoteConfig {
        RemoteConfig {
            uri: uri.to_string(),
            token: token.map(String::from),
            disable_ssl: None,
        }
    }

    #[test]
    fn attach_sql_names_the_catalog_and_carries_the_token() {
        let sql = attach_sql(&cfg("quack:pi.lan:9494", Some("SECRET")), "edge");
        assert!(sql.contains("ATTACH 'quack:pi.lan:9494'"), "{sql}");
        assert!(sql.contains("AS edge"), "{sql}");
        assert!(sql.contains("TOKEN 'SECRET'"), "{sql}");
    }

    #[test]
    fn a_remote_host_disables_ssl_by_default() {
        // The Quack server terminates no TLS, but the client assumes HTTPS for
        // any non-local URI. Without this the attach fails against a bare
        // daemon -- and needing it is the signal a proxy is missing.
        let sql = attach_sql(&cfg("quack:pi.lan:9494", Some("S")), "edge");
        assert!(sql.contains("DISABLE_SSL true"), "{sql}");
    }

    #[test]
    fn a_local_host_does_not_need_the_flag() {
        // DuckDB already defaults DISABLE_SSL true for localhost/127.0.0.1/::1.
        for uri in [
            "quack:localhost:9494",
            "quack:127.0.0.1:9494",
            "quack:[::1]:9494",
        ] {
            let sql = attach_sql(&cfg(uri, Some("S")), "edge");
            assert!(!sql.contains("DISABLE_SSL"), "{uri} -> {sql}");
        }
    }

    #[test]
    fn an_explicit_disable_ssl_overrides_the_host_heuristic() {
        let mut c = cfg("quack:pi.lan:9494", Some("S"));
        c.disable_ssl = Some(false);
        let sql = attach_sql(&c, "edge");
        assert!(!sql.contains("DISABLE_SSL"), "{sql}");
    }

    #[test]
    fn a_token_with_a_quote_is_escaped() {
        // The token reaches us from configuration and is interpolated into SQL
        // text, so it must be escaped rather than trusted.
        let sql = attach_sql(&cfg("quack:pi.lan:9494", Some("a'b")), "edge");
        assert!(sql.contains("TOKEN 'a''b'"), "{sql}");
    }

    #[test]
    fn a_missing_token_omits_the_clause() {
        let sql = attach_sql(&cfg("quack:localhost:9494", None), "edge");
        assert!(!sql.contains("TOKEN"), "{sql}");
    }

    #[test]
    fn observed_views_cover_exactly_the_recorded_tables() {
        let sql = remote_view_sql("edge");
        for t in ["positions", "raw_messages", "flights", "status_events"] {
            assert!(
                sql.contains(&format!(
                    "CREATE OR REPLACE VIEW {t} AS SELECT * FROM edge.{t}"
                )),
                "missing view for {t}: {sql}"
            );
        }
        // Authored tables stay local and must NOT be shadowed by a remote view.
        for t in ["events_of_interest", "scenarios", "scenario_tracks"] {
            assert!(
                !sql.contains(&format!("VIEW {t} ")),
                "{t} must stay local: {sql}"
            );
        }
    }
}
