# Quick Start Guide

## 0. Prerequisites

Install Protocol Buffers compiler (required for building):

**macOS:**
```bash
brew install protobuf
# Or: sudo port install protobuf3-cpp
```

**Linux:**
```bash
sudo apt-get install protobuf-compiler  # Debian/Ubuntu
sudo yum install protobuf-compiler      # RHEL/CentOS
```

**Verify:**
```bash
protoc --version
```

## 1. Build the Binary

```bash
cd src/rust/adsb-pulsar-client

# For local development
make build

# For production (optimized)
make release
```

## 2. Test Locally

### Test Mode (no backend needed)

```bash
# Connect to dump1090 and count messages — no backend required
./target/debug/adsb-pulsar-client \
  --socket-host localhost \
  --socket-port 30003 \
  --test-mode \
  --log-level debug
```

### Write to a Local File (no Pulsar needed)

```bash
# Forward messages to a file — useful for offline analysis or testing
./target/debug/adsb-pulsar-client \
  --forwarder file \
  --file-path /tmp/adsb_test.sbs \
  --socket-host localhost \
  --socket-port 30003 \
  --log-level debug
```

### With Local Pulsar

```bash
# Start Pulsar
docker run -it -p 6650:6650 -p 8080:8080 apachepulsar/pulsar:latest bin/pulsar standalone

# Forward to Pulsar
./target/release/adsb-pulsar-client \
  --source-id my-local-test \
  --socket-host localhost \
  --socket-port 30003 \
  --pulsar-broker pulsar://localhost:6650 \
  --pulsar-topic persistent://public/default/adsb-test
```

### Forward to Pulsar and File Simultaneously

```bash
# Fan-out to both backends at once
./target/release/adsb-pulsar-client \
  --forwarder pulsar \
  --forwarder file \
  --file-path /tmp/adsb_backup.sbs \
  --socket-host localhost \
  --socket-port 30003 \
  --pulsar-broker pulsar://localhost:6650 \
  --pulsar-topic persistent://public/default/adsb-test
```

## 3. Deploy to Raspberry Pi

### Option A: Cross-Compile

```bash
# On your development machine
make cross-armv7

# Copy to Raspberry Pi
scp target/armv7-unknown-linux-gnueabihf/release/adsb-pulsar-client pi@raspberrypi.local:/home/pi/
```

### Option B: Build on Raspberry Pi

```bash
# On Raspberry Pi
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

cd /home/pi/adsb-feed/src/rust/adsb-pulsar-client
make release
```

## 4. Run on Raspberry Pi

### Manual Test

```bash
./adsb-pulsar-client \
  --source-id raspberry-pi-01 \
  --socket-host localhost \
  --socket-port 30003 \
  --pulsar-broker pulsar://your-pulsar-server.com:6650 \
  --pulsar-topic persistent://kradsb/adsb/sbs-topic
```

### As Systemd Service

```bash
# Copy binary to system location
sudo cp target/release/adsb-pulsar-client /usr/local/bin/

# Create systemd service (see adsb-pulsar-client.service)
sudo nano /etc/systemd/system/adsb-pulsar-client.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable adsb-pulsar-client
sudo systemctl start adsb-pulsar-client

# Check status
sudo systemctl status adsb-pulsar-client

# View logs
sudo journalctl -u adsb-pulsar-client -f
```

## 5. Verify Data Flow

### Check Pulsar Topic

```bash
# On Pulsar server
pulsar-admin topics stats persistent://kradsb/adsb/sbs-topic

# Consume messages
pulsar-client consume persistent://kradsb/adsb/sbs-topic \
  -s test-consumer \
  -n 10
```

### Monitor Client Logs

```bash
# On Raspberry Pi
sudo journalctl -u adsb-pulsar-client -f --since "5 minutes ago"
```

You should see periodic statistics like:

```
Statistics: Messages: 15234, Errors: 0, Queue: 0, Throughput: 1523.4 msg/s, Sent: 3.45 MB, Received: 3.52 MB
```

## Common Issues

### "Connection refused" to dump1090

```bash
# Check if dump1090 is running
ps aux | grep dump1090

# Verify port 30003 is listening
netstat -tlnp | grep 30003

# Test connection
telnet localhost 30003
```

### "Connection timeout" to Pulsar

```bash
# Verify Pulsar broker is accessible from Raspberry Pi
telnet your-pulsar-server.com 6650

# Check firewall rules
sudo iptables -L
```

### High CPU usage

```bash
# Use release build (optimized)
make release

# Reduce logging
--log-level warn

# Increase batch size
--pulsar-batch-max-messages 200
```

## Performance Tips

1. **Always use release builds in production**: `make release`
2. **Tune batch settings** for your use case (see README.md)
3. **Monitor with journalctl** to track performance
4. **Use systemd** for automatic restarts and logging

---

## Developer Guide — Multi-Forwarder Configuration

### Using the Library Directly

When embedding `adsb-pulsar-client` as a library you construct forwarders manually and pass them
to `ADSBFeedClient::new`:

```rust
use adsb_pulsar_client::{ADSBFeedClient, Config};
use adsb_pulsar_client::forwarder::{MessageForwarder, NoopForwarder};
use adsb_pulsar_client::forwarder::file::FileForwarder;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::default();

    // Build forwarder list — order doesn't matter
    let forwarders: Vec<Box<dyn MessageForwarder>> = vec![
        Box::new(FileForwarder::new("/tmp/adsb.sbs".into())),
        Box::new(NoopForwarder),   // swap in PulsarForwarder for production
    ];

    let mut client = ADSBFeedClient::new(config, forwarders)?;
    client.run().await?;
    Ok(())
}
```

### Implementing a Custom Forwarder

```rust
use adsb_pulsar_client::forwarder::MessageForwarder;
use adsb_pulsar_client::error::Result;

pub struct MyForwarder { connected: bool }

#[async_trait::async_trait]
impl MessageForwarder for MyForwarder {
    async fn connect(&mut self) -> Result<()> {
        self.connected = true;
        Ok(())
    }
    async fn send(&mut self, message: &[u8]) -> Result<()> {
        // deliver message to your backend
        Ok(())
    }
    async fn flush(&mut self) -> Result<()> { Ok(()) }
    async fn disconnect(&mut self) -> Result<()> {
        self.connected = false;
        Ok(())
    }
    fn is_connected(&self) -> bool { self.connected }
    fn name(&self) -> &str { "my-backend" }
}
```

**Contract to implement:**
- Return `Err` from `send()` if delivery fails — the client will call `disconnect()` and retry.
- `is_connected()` controls whether the client calls `send()` or enqueues for retry.
- `flush()` is called on every housekeeping tick (~500 ms); buffer aggressively, flush here.
- See [`docs/DESIGN.md`](docs/DESIGN.md) for the full interface specification.

### Observing Messages with the Tap Channel

```rust
let mut client = ADSBFeedClient::new(config, forwarders)?;

// Attach a broadcast receiver before run()
let mut tap = client.with_message_tap(1024);

tokio::spawn(async move {
    while let Ok(msg) = tap.recv().await {
        println!("saw: {}", String::from_utf8_lossy(&msg));
    }
});

client.run().await?;
```

The tap is fire-and-forget — a slow consumer only drops its own messages, never blocks forwarding.

### Feature Flags

| Feature | Default | Notes |
|---------|---------|-------|
| `pulsar` | **on** | Include Pulsar dependency and `PulsarForwarder` |
| `cli` | **on** | Include `clap` derive on `Config` (gates the binary) |

Disable Pulsar for lightweight embeddings:

```toml
[dependencies]
adsb-pulsar-client = { path = "…", default-features = false, features = ["cli"] }
```

### Running Tests

```bash
# All tests (77 unit + integration + doc-tests)
cargo test -p adsb-pulsar-client

# Without Pulsar feature (checks no pulsar-only code leaks)
cargo test -p adsb-pulsar-client --no-default-features --features cli

# CI gate
cargo test -p adsb-pulsar-client && \
  cargo clippy -p adsb-pulsar-client -- -D warnings && \
  cargo fmt --check
```
