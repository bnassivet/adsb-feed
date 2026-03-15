# CLAUDE.md - Rust Workspace

Cargo workspace containing the ADS-B feed client library, adsd-data-engine and Tauri desktop app.

## Workspace Members

| Crate | Path | Purpose |
|-------|------|---------|
| `adsb-pulsar-client` | `adsb-pulsar-client/` | Library + CLI for dump1090 → Pulsar forwarding |
| `adsb-pulsar-client-desktop-lib` | `adsb-pulsar-client-desktop/src-tauri/` | Tauri v2 desktop app backend |
| `adsb-data-engine` | `adsb-data-engine/` | Shared SBS-1 parser + DuckDB persistent storage for historical queries |

## Testing

### TDD Workflow

All changes follow Test-Driven Development (Red → Green → Refactor). No code lands without a test.

### Run All Tests

```bash
# From this directory (adsb-feed/rust/)
cargo test --workspace                    # ~227 tests (unit + integration + doc-tests)
cargo clippy --workspace -- -D warnings   # Lint
cargo fmt --workspace --check             # Format check
```

### Run by Crate

```bash
cargo test -p adsb-pulsar-client              # Library: ~65 tests (unit + integration + doc)
cargo test -p adsb-pulsar-client-desktop-lib  # Tauri: ~19 tests (unit)
cargo test -p adsb-data-engine               # Data engine: ~113 tests (SBS parser + storage + import)
```

### Run Specific Tests

```bash
cargo test --workspace test_parse_msg3       # By test name substring
cargo test --workspace config::tests         # By module path
cargo test --workspace -- --nocapture        # Show stdout
```

### CI Gate

```bash
cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --workspace --check
```

### Documentation

Save new feature development plan in adsb-pulsar-client-desktop/docs/plans before starting implementation.
Update Design documentation (DESIGN.md, DOCUMENTATION.md) before proposing to commit a new feature implementation.

## Build Notes

- `cli` feature (default-enabled on `adsb-pulsar-client`) gates `clap` dependency
- Tauri crate uses `default-features = false` to exclude clap
- `[profile.release]` settings must be in this workspace root `Cargo.toml`, not member crates
- `protoc` required at build time (Pulsar crate dependency)
- `adsb-data-engine` uses `duckdb` crate (DuckDB 1.2) via C FFI — no extra system packages needed beyond Rust toolchain; DuckDB is statically linked

## Continous improvement

Update CLAUDE.md with pertinent lessons learned especially from feature or issue implementation failures
