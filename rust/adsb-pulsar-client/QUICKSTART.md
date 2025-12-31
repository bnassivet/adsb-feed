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

### Test Mode (No Pulsar)

```bash
# Run against local dump1090 and just display messages
./target/debug/adsb-pulsar-client \
  --socket-host localhost \
  --socket-port 30003 \
  --test-mode \
  --log-level debug
```

### With Local Pulsar

```bash
# Make sure Pulsar is running locally
docker run -it -p 6650:6650 -p 8080:8080 apachepulsar/pulsar:latest bin/pulsar standalone

# Run the client
./target/release/adsb-pulsar-client \
  --source-id my-local-test \
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
