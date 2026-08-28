//! Remove the TST00* mock aircraft written during app verification.
//!
//! Run through this workspace's own `adsb-data-engine` crate so the on-disk
//! format is never migrated by a mismatched CLI: the `duckdb` dependency is
//! pinned exactly (`=1.10505.0`) because the autoinstalled `quack` extension
//! is keyed to the exact build, and an arbitrary `duckdb` CLI opening this
//! file could upgrade it irreversibly.
//!
//! Only ever deletes hex_idents matching the mock prefix.

use duckdb::Connection;

const TABLES: [&str; 3] = ["positions", "raw_messages", "flights"];

fn mock_rows(conn: &Connection, table: &str) -> u64 {
    conn.query_row(
        &format!("SELECT count(*) FROM {table} WHERE hex_ident LIKE 'TST00%'"),
        [],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0) as u64
}

fn all_rows(conn: &Connection, table: &str) -> u64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap_or(0) as u64
}

fn report(conn: &Connection, label: &str) {
    println!("{label}");
    for t in TABLES {
        println!(
            "  {t:<14} mock={:<8} total={}",
            mock_rows(conn, t),
            all_rows(conn, t)
        );
    }
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: purge_test_rows <path-to-adsb_history.db>");
    let conn = Connection::open(&path).expect("open database (is the app stopped?)");

    report(&conn, "BEFORE");
    for t in TABLES {
        let n = conn
            .execute(&format!("DELETE FROM {t} WHERE hex_ident LIKE 'TST00%'"), [])
            .expect("delete");
        println!("deleted {n} rows from {t}");
    }
    // Fold the WAL back into the file so the cleanup survives without the app
    // reopening this handle.
    conn.execute_batch("CHECKPOINT;").expect("checkpoint");
    report(&conn, "AFTER");
}
