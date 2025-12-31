# ADS-B Pulsar Client (Rust)

High-performance ADS-B feed client written in Rust that connects to dump1090 TCP socket and forwards SBS-1 messages to Apache Pulsar.

## Features

- ⚡ **High Performance**: Async/await with Tokio for maximum throughput
- 🔄 **Reliability**: Automatic reconnection with exponential backoff
- 💾 **Message Retry Queue**: Prevents data loss during transient failures
- 🔒 **Type Safety**: Leverages Rust's type system for correctness
- 📊 **Comprehensive Metrics**: Throughput, error rates, queue sizes
- 🎯 **Zero-Copy Operations**: Efficient memory usage with `bytes` crate
- 🛡️ **Graceful Shutdown**: Handles SIGINT/SIGTERM signals properly
- 🧪 **Test Mode**: Run without Pulsar for development
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

### Basic Usage

```bash
# Connect to dump1090 and forward to Pulsar
adsb-pulsar-client \
  --source-id raspberry-pi-01 \
  --socket-host 192.168.1.100 \
  --socket-port 30003 \
  --pulsar-broker pulsar://pulsar.example.com:6650 \
  --pulsar-topic persistent://kradsb/adsb/sbs-topic
```

### Test Mode (No Pulsar)

```bash
# Test connection to dump1090 without sending to Pulsar
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

| Option | Default | Description |
|--------|---------|-------------|
| `--source-id` | kraspberryPi | Unique identifier for this data source |
| `--socket-host` | 10.0.0.200 | dump1090 host address |
| `--socket-port` | 30003 | dump1090 SBS-1 port |
| `--pulsar-broker` | pulsar://localhost:6650 | Pulsar broker URL |
| `--pulsar-topic` | persistent://kradsb/adsb/sbs-topic | Pulsar topic name |
| `--recv-buffer-size` | 65536 | Socket receive buffer (bytes) |
| `--socket-timeout-secs` | 30 | Socket timeout in seconds |
| `--initial-retry-delay-secs` | 1 | Initial retry delay |
| `--max-retry-delay-secs` | 60 | Maximum retry delay |
| `--log-sample-rate` | 100 | Log stats every N messages |
| `--max-retry-queue-size` | 1000 | Max messages in retry queue |
| `--max-line-buffer-size` | 100000 | Max line buffer size (bytes) |
| `--pulsar-batch-delay-ms` | 100 | Pulsar batch delay (ms) |
| `--pulsar-batch-max-messages` | 100 | Max messages per batch |
| `--test-mode` | false | Run without Pulsar |
| `--log-level` | info | Logging level (trace/debug/info/warn/error) |
| `--connection-mode` | client | Connection mode (client/server) |

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

### Run Tests

```bash
cargo test
```

### Format Code

```bash
cargo fmt
```

### Lint Code

```bash
cargo clippy -- -D warnings
```

### Generate Documentation

```bash
cargo doc --open
```

## Architecture

```
┌─────────────────┐
│   dump1090       │
│  (SBS-1 TCP)    │
└────────┬────────┘
         │ Raw SBS-1 messages
         ▼
┌─────────────────┐
│  Socket Reader  │  ← Async TCP with line buffering
│  (Tokio)        │
└────────┬────────┘
         │ Complete messages
         ▼
┌─────────────────┐
│ Message Buffer  │  ← BytesMut for zero-copy
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Retry Queue     │  ← VecDeque for failed messages
│ (VecDeque)      │
└────────┬────────┘
         │ Batched messages
         ▼
┌─────────────────┐
│ Pulsar Producer │  ← pulsar-rs async client
│  (Async)        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Apache Pulsar   │
│  (Persistent)   │
└─────────────────┘
```

## License

MIT OR Apache-2.0

## Contributing

Contributions welcome! Please ensure:

1. Code is formatted with `cargo fmt`
2. All tests pass with `cargo test`
3. No clippy warnings with `cargo clippy`
4. Documentation is updated
