# ADS-B Pulsar Client (Rust)

High-performance ADS-B feed client written in Rust. Connects to a dump1090 TCP socket and fans
SBS-1 messages out to one or more pluggable forwarding backends simultaneously (Apache Pulsar,
local file, or custom implementations).

## Features

- ⚡ **High Performance**: Async/await with Tokio, ~50k msg/s on Raspberry Pi 4
- 🔌 **Pluggable Backends**: Apache Pulsar, file output, or custom `MessageForwarder` implementations
- 🔀 **Multi-Forwarder Fan-out**: Forward to several backends simultaneously (e.g., Pulsar + file)
- 🔄 **Independent Failure Handling**: Each backend has its own retry queue; one failure doesn't affect others
- 💾 **Per-Forwarder Retry Queue**: Prevents data loss during transient backend failures
- 🔒 **Type Safety**: Leverages Rust's type system for correctness
- 📊 **Comprehensive Metrics**: Throughput, error rates, queue sizes (lock-free atomics)
- 🎯 **Zero-Copy Operations**: Efficient memory usage with `bytes` crate
- 🛡️ **Graceful Shutdown**: Handles SIGINT/SIGTERM signals properly
- 🧪 **Test Mode**: Run without any backend for development
- 📝 **Structured Logging**: Using `tracing` for performance and clarity

## Comparison with Python Version

| Feature | Python | Rust |
|---------|--------|------|
| Runtime | CPython GIL | Tokio async (multi-threaded) |
| Memory Safety | Runtime | Compile-time |
| Typical Throughput | ~10k msg/s | ~50k+ msg/s |
| Memory Usage | ~50-100 MB | ~10-20 MB |
| Binary Size | N/A (interpreter) | ~5 MB (stripped) |
| Startup Time | ~500ms | ~50ms |
| Dependencies | Python + libs | Single binary |

## Installation

### Prerequisites

- Rust 1.75+ ([install from rustup.rs](https://rustup.rs/))
- **Protocol Buffers compiler (`protoc`)** - Required for building
- Apache Pulsar broker (for production use)

#### Install Protocol Buffers Compiler

**macOS:**
```bash
# Using Homebrew
brew install protobuf

# Or using MacPorts
sudo port install protobuf3-cpp

# Or download pre-built binary from:
# https://github.com/protocolbuffers/protobuf/releases
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get install protobuf-compiler
```

**Linux (RHEL/CentOS):**
```bash
sudo yum install protobuf-compiler
```

**Verify installation:**
```bash
protoc --version
# Should output: libprotoc 3.x.x or higher
```

### Build from Source

```bash
cd src/rust/adsb-pulsar-client

# Development build
cargo build

# Production build (optimized)
cargo build --release

# The binary will be at:
# - Debug: target/debug/adsb-pulsar-client
# - Release: target/release/adsb-pulsar-client
```

### Install System-Wide

```bash
cargo install --path .
```

## Usage

### Basic Usage — Pulsar (default)

```bash
# Connect to dump1090 and forward to Apache Pulsar
adsb-pulsar-client \
  --source-id raspberry-pi-01 \
  --socket-host 192.168.1.100 \
  --socket-port 30003 \
  --pulsar-broker pulsar://pulsar.example.com:6650 \
  --pulsar-topic persistent://kradsb/adsb/sbs-topic
```

### Write to a Local File

```bash
# Forward to a timestamped SBS-1 file (no Pulsar needed)
adsb-pulsar-client \
  --forwarder file \
  --file-path /var/log/adsb/messages.sbs \
  --socket-host 192.168.1.100 \
  --socket-port 30003
```

### Forward to Multiple Backends Simultaneously

```bash
# Pulsar + local file at the same time
adsb-pulsar-client \
  --forwarder pulsar \
  --forwarder file \
  --file-path /var/log/adsb/messages.sbs \
  --socket-host 192.168.1.100 \
  --socket-port 30003 \
  --pulsar-broker pulsar://pulsar.example.com:6650 \
  --pulsar-topic persistent://kradsb/adsb/sbs-topic
```

### Test Mode (No Backend)

```bash
# Count messages from dump1090 without forwarding anywhere
adsb-pulsar-client \
  --socket-host 192.168.1.100 \
  --socket-port 30003 \
  --test-mode
```

### Using Environment Variables

```bash
export ADSB_SOURCE_ID=my-receiver
export ADSB_SOCKET_HOST=192.168.1.100
export ADSB_SOCKET_PORT=30003
export PULSAR_BROKER=pulsar://pulsar.example.com:6650
export PULSAR_TOPIC=persistent://kradsb/adsb/sbs-topic

adsb-pulsar-client
```

### Server Mode (Listen for Connections)

```bash
# Listen on 0.0.0.0:30003 for incoming dump1090 connections
adsb-pulsar-client \
  --socket-host 0.0.0.0 \
  --socket-port 30003 \
  --connection-mode server \
  --pulsar-broker pulsar://localhost:6650
```

## Configuration Options

### Forwarder Selection

| Option | Default | Description |
|--------|---------|-------------|
| `--forwarder` | `pulsar` | Backend to use: `pulsar`, `file`, `noop`. Repeat for multiple backends. |
| `--file-path` | `adsb_messages_<timestamp>.sbs` | Output file path (used when `--forwarder file`) |

### Source and Socket

| Option | Default | Description |
|--------|---------|-------------|
| `--source-id` | `kraspberryPi` | Unique identifier for this data source |
| `--socket-host` | `10.0.0.200` | dump1090 host address |
| `--socket-port` | `30003` | dump1090 SBS-1 port |
| `--connection-mode` | `client` | TCP mode: `client` (connect out) or `server` (accept in) |

### Pulsar (when `--forwarder pulsar`)

| Option | Default | Description |
|--------|---------|-------------|
| `--pulsar-broker` | `pulsar://localhost:6650` | Pulsar broker URL |
| `--pulsar-topic` | `persistent://kradsb/adsb/sbs-topic` | Pulsar topic name |
| `--pulsar-batch-delay-ms` | `100` | Batch delay before sending (ms) |
| `--pulsar-batch-max-messages` | `100` | Max messages per batch |

### Buffer and Reliability

| Option | Default | Description |
|--------|---------|-------------|
| `--recv-buffer-size` | `65536` | Socket receive buffer (bytes) |
| `--socket-timeout-secs` | `30` | Socket read timeout |
| `--initial-retry-delay-secs` | `1` | Initial reconnect backoff delay |
| `--max-retry-delay-secs` | `60` | Maximum reconnect backoff delay |
| `--max-retry-queue-size` | `1000` | Max messages in per-forwarder retry queue |
| `--max-line-buffer-size` | `100000` | Max line buffer size (bytes) |

### Diagnostics

| Option | Default | Description |
|--------|---------|-------------|
| `--test-mode` | `false` | Count messages without forwarding to any backend |
| `--log-level` | `info` | Logging level: `trace`, `debug`, `info`, `warn`, `error` |
| `--log-sample-rate` | `100` | Log statistics every N messages |

## Performance Tuning

### For Maximum Throughput

```bash
adsb-pulsar-client \
  --recv-buffer-size 131072 \
  --pulsar-batch-delay-ms 50 \
  --pulsar-batch-max-messages 200 \
  --log-sample-rate 1000
```

### For Low Latency

```bash
adsb-pulsar-client \
  --pulsar-batch-delay-ms 10 \
  --pulsar-batch-max-messages 50
```

### For Constrained Devices (Raspberry Pi Zero)

```bash
adsb-pulsar-client \
  --recv-buffer-size 8192 \
  --max-retry-queue-size 100 \
  --max-line-buffer-size 10000
```

## Running as a Systemd Service

Create `/etc/systemd/system/adsb-pulsar-client.service`:

```ini
[Unit]
Description=ADS-B Pulsar Feed Client
After=network.target

[Service]
Type=simple
User=adsb
ExecStart=/usr/local/bin/adsb-pulsar-client \
  --source-id raspberry-pi-01 \
  --socket-host 127.0.0.1 \
  --socket-port 30003 \
  --pulsar-broker pulsar://pulsar.example.com:6650 \
  --pulsar-topic persistent://kradsb/adsb/sbs-topic
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable adsb-pulsar-client
sudo systemctl start adsb-pulsar-client
sudo systemctl status adsb-pulsar-client
```

View logs:

```bash
sudo journalctl -u adsb-pulsar-client -f
```

## Cross-Compilation for Raspberry Pi

### For Raspberry Pi (ARM 32-bit)

```bash
# Install cross-compilation tools
rustup target add armv7-unknown-linux-gnueabihf

# Build
cargo build --release --target armv7-unknown-linux-gnueabihf

# Binary will be at:
# target/armv7-unknown-linux-gnueabihf/release/adsb-pulsar-client
```

### For Raspberry Pi (ARM 64-bit)

```bash
rustup target add aarch64-unknown-linux-gnu
cargo build --release --target aarch64-unknown-linux-gnu
```

## Logging

The client uses structured logging with the `tracing` crate.

### Logging Levels

```bash
# Verbose debugging
RUST_LOG=debug adsb-pulsar-client [options]

# Production (default)
RUST_LOG=info adsb-pulsar-client [options]

# Minimal logging
RUST_LOG=error adsb-pulsar-client [options]

# Module-specific logging
RUST_LOG=adsb_pulsar_client=debug,pulsar=info adsb-pulsar-client [options]
```

## Metrics and Monitoring

The client logs periodic statistics:

```
Statistics: Messages: 15234, Errors: 2, Queue: 0, Throughput: 1523.4 msg/s, Sent: 3.45 MB, Received: 3.52 MB
```

### Prometheus Metrics (Optional Feature)

Build with metrics support:

```bash
cargo build --release --features metrics
```

Metrics will be available on `http://localhost:9090/metrics`.

## Troubleshooting

### Connection Refused

```bash
# Verify dump1090 is running and listening
netstat -tlnp | grep 30003

# Test connection manually
telnet 192.168.1.100 30003
```

### Pulsar Connection Failed

```bash
# Verify Pulsar broker is accessible
curl http://pulsar-broker:8080/admin/v2/clusters

# Check topic exists
pulsar-admin topics list kradsb/adsb
```

### High Memory Usage

Reduce buffer sizes:

```bash
adsb-pulsar-client \
  --max-retry-queue-size 100 \
  --max-line-buffer-size 10000
```

### Messages Not Appearing in Pulsar

Enable debug logging:

```bash
RUST_LOG=debug adsb-pulsar-client [options]
```

## Development

All development follows TDD (Red → Green → Refactor). See [`docs/DESIGN.md`](docs/DESIGN.md) for
interface documentation and the custom forwarder guide.

### Run Tests

```bash
# All tests in this crate (unit + integration + doc-tests, ~77 total)
cargo test -p adsb-pulsar-client

# Verify no-Pulsar build still compiles and passes
cargo test -p adsb-pulsar-client --no-default-features --features cli
```

### Format and Lint

```bash
cargo fmt --check
cargo clippy -- -D warnings
```

### Generate Documentation

```bash
cargo doc --no-deps --open
```

## Architecture

```
┌──────────────────┐
│    dump1090      │
│  (SBS-1 TCP)     │
└────────┬─────────┘
         │ raw bytes
         ▼
┌──────────────────────────────────────────────────────────┐
│                   ADSBFeedClient                         │
│                                                          │
│  TcpStream → LineBuffer (BytesMut) → forward_message()  │
│                                            │             │
│                                  ┌─────────┴──────────┐  │
│                                  │   Fan-out loop      │  │
│                                  └──┬──────────────┬───┘  │
│                                     │              │      │
│                    retry_queues[0]  │    retry_queues[N]  │
└─────────────────────────────────────┼──────────────┼──────┘
                                      ▼              ▼
                              Forwarder #0     Forwarder #N
                           (PulsarForwarder) (FileForwarder / …)
                                      │              │
                                      ▼              ▼
                              Apache Pulsar     /var/log/…
```

Each forwarder manages its own connection lifecycle and retry queue. A failure in one backend does
not affect message delivery to the others. See [`docs/DESIGN.md`](docs/DESIGN.md) for a full
interface reference and design rationale.

## License

MIT OR Apache-2.0

## Contributing

Contributions welcome! Please ensure:

1. Code is formatted with `cargo fmt`
2. All tests pass with `cargo test`
3. No clippy warnings with `cargo clippy`
4. Documentation is updated
