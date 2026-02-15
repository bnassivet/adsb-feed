# CLAUDE.md - Rust ADS-B Pulsar Client

This file provides guidance to Claude Code when working with the Rust implementation of the ADS-B Pulsar client.

## Project Overview

This is a high-performance Rust implementation of the ADS-B feed client that connects to dump1090 TCP sockets and forwards SBS-1 format messages to Apache Pulsar. It is a drop-in replacement for the Python client (`src/python/pulsar-client-async.py`) with significantly better performance characteristics.

## Architecture

### Core Components

```
src/
├── main.rs      # Entry point, CLI argument parsing, signal handling
├── lib.rs       # Library exports and module declarations
├── client.rs    # ADSBFeedClient - core async client implementation
├── config.rs    # Config struct with clap derive for CLI/env parsing
├── error.rs     # ClientError enum with thiserror derive
└── metrics.rs   # Thread-safe atomic metrics (lock-free)
```

### Data Flow

```
dump1090 (TCP)
     │
     ▼
┌─────────────────┐
│  Socket Reader  │  Tokio async TCP stream
│  (BufReader)    │
└────────┬────────┘
         │ Raw bytes
         ▼
┌─────────────────┐
│  Line Buffer    │  BytesMut for zero-copy line extraction
│  (bytes crate)  │
└────────┬────────┘
         │ Complete SBS-1 lines
         ▼
┌─────────────────┐
│  Retry Queue    │  VecDeque for failed message retry
│  (VecDeque)     │
└────────┬────────┘
         │ Batched messages
         ▼
┌─────────────────┐
│ Pulsar Producer │  pulsar-rs async client
│  (batching)     │
└────────┬────────┘
         │
         ▼
   Apache Pulsar
```

### Key Design Patterns

1. **Async/Await with Tokio**: Full async runtime for non-blocking I/O
2. **Zero-Copy Buffers**: `bytes::BytesMut` for efficient memory management
3. **Lock-Free Metrics**: Atomic operations with `Ordering::Relaxed`
4. **Typed Errors**: `thiserror` derive for ergonomic error handling
5. **CLI with Clap**: Type-safe argument parsing with environment variable support

## Build and Development

### Prerequisites

```bash
# Rust 1.75+ required
rustup --version

# Protocol Buffers compiler (required by pulsar crate)
protoc --version  # Must be installed
```

### Common Build Commands

```bash
# Development build (fast compile, debug symbols)
cargo build

# Production build (optimized, LTO, stripped)
cargo build --release

# Run tests
cargo test

# Run with debug logging
RUST_LOG=debug cargo run -- --test-mode

# Lint with clippy
cargo clippy -- -D warnings

# Format code
cargo fmt

# Check formatting without modifying
cargo fmt --check

# Generate documentation
cargo doc --no-deps --open
```

### Running the Client

```bash
# SBS-1 text messages (port 30003)
cargo run -- \
  --source-id my-receiver \
  --socket-host 10.0.0.200 \
  --socket-port 30003 \
  --pulsar-broker pulsar://localhost:6650 \
  --pulsar-topic persistent://kradsb/adsb/sbs-topic

# Binary messages (port 30002)
cargo run -- \
  --source-id my-receiver \
  --socket-host 10.0.0.200 \
  --socket-port 30002 \
  --pulsar-broker pulsar://localhost:6650 \
  --pulsar-topic persistent://kradsb/adsb/sbs-binary-topic

# Test mode (no Pulsar connection)
cargo run -- --socket-host localhost --socket-port 30003 --test-mode
```

### Environment Variables

All CLI options can be set via environment variables:

```bash
export ADSB_SOURCE_ID=my-receiver
export ADSB_SOCKET_HOST=10.0.0.200
export ADSB_SOCKET_PORT=30003
export PULSAR_BROKER=pulsar://localhost:6650
export PULSAR_TOPIC=persistent://kradsb/adsb/sbs-topic
export RUST_LOG=info

cargo run
```

## Code Conventions

### Error Handling

- Use `Result<T, ClientError>` for fallible operations
- Propagate errors with `?` operator
- Add context with `.context()` from anyhow when needed
- Check `is_recoverable()` to determine retry behavior

```rust
// Good: typed error with recovery info
pub enum ClientError {
    Socket(#[from] std::io::Error),  // Recoverable
    Config(String),                   // Not recoverable
}

impl ClientError {
    pub fn is_recoverable(&self) -> bool {
        matches!(self, Self::Socket(_) | Self::Pulsar(_))
    }
}
```

### Async Patterns

- Use `tokio::select!` for concurrent operations
- Prefer `tokio::time::interval` over `sleep` loops
- Use `tokio::signal` for graceful shutdown

```rust
loop {
    tokio::select! {
        result = stream.read(&mut buffer) => { /* handle data */ }
        _ = stats_interval.tick() => { /* log stats */ }
        _ = shutdown_rx.recv() => { break; }
    }
}
```

### Metrics

- All metrics use atomic operations (no mutex)
- Use `Ordering::Relaxed` for counters (sufficient for statistics)
- Create snapshots for consistent reads

```rust
// Incrementing (lock-free)
self.metrics.inc_messages_sent();

// Reading snapshot
let stats = self.metrics.snapshot();
info!("{}", stats);
```

## Configuration

### CLI Arguments (Cargo.toml uses clap derive)

| Argument | Default | Environment Variable |
|----------|---------|---------------------|
| `--source-id` | kraspberryPi | `ADSB_SOURCE_ID` |
| `--socket-host` | 10.0.0.200 | `ADSB_SOCKET_HOST` |
| `--socket-port` | 30003 | `ADSB_SOCKET_PORT` |
| `--pulsar-broker` | pulsar://localhost:6650 | `PULSAR_BROKER` |
| `--pulsar-topic` | persistent://kradsb/adsb/sbs-topic | `PULSAR_TOPIC` |
| `--test-mode` | false | - |
| `--log-level` | info | `RUST_LOG` |

### Performance Tuning Options

| Option | Default | Description |
|--------|---------|-------------|
| `--recv-buffer-size` | 65536 | Socket receive buffer |
| `--pulsar-batch-delay-ms` | 100 | Batch delay before sending |
| `--pulsar-batch-max-messages` | 100 | Max messages per batch |
| `--max-retry-queue-size` | 1000 | Retry queue capacity |
| `--log-sample-rate` | 100 | Log stats every N messages |

## Testing

### TDD Workflow

All changes follow Test-Driven Development:
1. **Red**: Write a failing test first
2. **Green**: Minimum code to make it pass
3. **Refactor**: Clean up while tests stay green

**No code lands without a test.** Bug fixes require a regression test first.

### Unit Tests (~52 tests)

Tests live inline in each module under `#[cfg(test)] mod tests`:

| Module | Tests | What's Covered |
|--------|-------|----------------|
| `config.rs` | 18 | Validation (empty source_id, invalid broker URLs, zero buffers), connection mode parsing, duration conversions, serde roundtrip |
| `error.rs` | 10 | `is_recoverable()` and `should_retry()` for all variants, display formatting |
| `metrics.rs` | 12 | Atomic counters, snapshot consistency, clone-shares-state, JSON serialization |
| `client.rs` | 12 | `process_buffer()` — single/multi-line extraction, incomplete buffering, CRLF, overflow, empty/whitespace lines |

```bash
# Run all unit tests
cargo test -p adsb-pulsar-client

# Run a specific module's tests
cargo test -p adsb-pulsar-client config::tests
cargo test -p adsb-pulsar-client error::tests

# Run a single test by name
cargo test -p adsb-pulsar-client test_default_config_is_valid

# Show println output
cargo test -p adsb-pulsar-client -- --nocapture
```

### Integration Tests (5 tests)

Located in `tests/` directory with shared infrastructure in `tests/common/mod.rs`:

| Test | What |
|------|------|
| `test_client_connects_receives_messages` | Mock sends 3 SBS lines, message tap receives all 3 |
| `test_message_tap_delivers_all` | Send N messages, verify tap count == N |
| `test_client_shutdown_stops_cleanly` | Client runs, verify metrics > 0, clean abort |
| `test_client_handles_disconnect` | Mock disconnects, client handles gracefully |
| `test_large_burst` | 100 messages rapid-fire, all arrive via tap |

**Test infrastructure (`tests/common/mod.rs`):**
- `MockDump1090` — TCP listener on port 0, accepts connection, sends configurable SBS lines
- `SBS_MSG3_POSITION`, `SBS_MSG1_CALLSIGN`, `SBS_MSG4_SPEED` — sample constants
- `test_config_for_port(port)` — creates `Config` with `test_mode = true` pointing to localhost

```bash
# Run integration tests only
cargo test -p adsb-pulsar-client --test test_message_flow

# Run all tests (unit + integration + doc-tests)
cargo test -p adsb-pulsar-client
```

### Doc-Tests (8 tests)

Inline `///` examples in `error.rs`, `metrics.rs`, and `lib.rs` that compile and run as tests.

### CI Gate

```bash
cargo test -p adsb-pulsar-client && cargo clippy -p adsb-pulsar-client -- -D warnings && cargo fmt --check
```

### Manual Integration Testing

```bash
# Start local Pulsar (Docker)
docker run -it -p 6650:6650 -p 8080:8080 apachepulsar/pulsar:latest bin/pulsar standalone

# Run client in test mode
cargo run -- --test-mode --socket-host localhost --socket-port 30003 --log-level debug
```

### Debugging

```bash
# Verbose logging
RUST_LOG=debug cargo run -- [options]

# Trace level (very verbose)
RUST_LOG=trace cargo run -- [options]

# Module-specific logging
RUST_LOG=adsb_pulsar_client=debug,pulsar=warn cargo run -- [options]
```

## Deployment

### Building for Production

```bash
# Optimized release build
cargo build --release

# Binary location
ls -la target/release/adsb-pulsar-client
# Size: ~5 MB (stripped)
```

### Systemd Service

A template service file is provided at `adsb-pulsar-client.service`. Deploy as:

```bash
sudo cp target/release/adsb-pulsar-client /usr/local/bin/
sudo cp adsb-pulsar-client.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now adsb-pulsar-client
sudo journalctl -u adsb-pulsar-client -f
```

## Dependencies

Key crates used:

| Crate | Purpose |
|-------|---------|
| `tokio` | Async runtime with full features |
| `pulsar` | Apache Pulsar client |
| `clap` | CLI argument parsing with derive |
| `tracing` | Structured logging |
| `tracing-subscriber` | Log formatting and filtering |
| `thiserror` | Derive macro for error types |
| `anyhow` | Flexible error handling |
| `bytes` | Zero-copy byte buffers |
| `chrono` | Date/time handling |
| `serde` | Serialization (for future use) |

## Troubleshooting

### Build Errors

**"Could not find protoc"**
```bash
# Install protobuf compiler
brew install protobuf  # macOS
sudo apt install protobuf-compiler  # Linux
```

**Linker errors on ARM cross-compile**
```bash
# Install ARM toolchain
# Note: Cross-compilation may require additional setup for your environment
```

### Runtime Issues

**Connection refused to dump1090**
```bash
# Verify dump1090 is running
netstat -tlnp | grep 30003
telnet localhost 30003
```

**Pulsar connection timeout**
```bash
# Check Pulsar is accessible
curl http://localhost:8080/admin/v2/clusters
```

**High memory usage**
```bash
# Reduce buffer sizes
cargo run -- \
  --max-retry-queue-size 100 \
  --max-line-buffer-size 10000
```

## Performance Comparison with Python

| Metric | Python | Rust | Improvement |
|--------|--------|------|-------------|
| Throughput | ~10k msg/s | ~50k msg/s | 5x |
| Memory | ~75 MB | ~15 MB | 5x |
| CPU | ~52% | ~12% | 4x |
| Startup | ~500ms | ~50ms | 10x |
| Binary | N/A | ~5 MB | - |

## Related Documentation

- `../RUST_IMPLEMENTATION.md`: Detailed comparison with Python implementation
- `README.md`: Comprehensive usage documentation
- `QUICKSTART.md`: Getting started guide
- `BUILD_REQUIREMENTS.md`: protoc installation guide
- `DOCUMENTATION.md`: Rust doc generation guide
