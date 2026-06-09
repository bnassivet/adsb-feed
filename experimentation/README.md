# adsb-feed

Lightweight ADS-B data ingestion client designed for Raspberry Pi deployment. Captures SBS-1 format messages from dump1090 and forwards them to Apache Pulsar message broker.

## Quick Start

### Prerequisites

- Python 3.12+
- [uv](https://github.com/astral-sh/uv) package manager
- dump1090 or compatible ADS-B receiver running on TCP port 30003
- Apache Pulsar broker (local or remote)

### Installation

```bash
# Install uv if not already installed
curl -LsSf https://astral.sh/uv/install.sh | sh

# Navigate to adsb-feed directory
cd adsb-feed

# Create virtual environment and install dependencies
uv sync

# Or install in development mode with dev dependencies
uv sync --all-extras
```

### Running the Feed Client

```bash
# Activate the virtual environment
source .venv/bin/activate

# Run with default settings (localhost dump1090 and Pulsar)
python src/python/pulsar-client-async.py

# Run with custom settings
python src/python/pulsar-client-async.py \
  --source_id raspberrypi-001 \
  --first_socket_host 10.0.0.200 \
  --first_socket_port 30003 \
  --pulsar_broker pulsar://pulsar-server.local:6650 \
  --pulsar_topic persistent://kradsb/adsb/sbs-topic
```

## Configuration Parameters

### Required Parameters
- `--source_id`: Unique identifier for this data source (default: "kraspberryPi")
- `--first_socket_host`: dump1090 host address (default: "10.0.0.200")
- `--first_socket_port`: dump1090 SBS-1 port (default: 30003)
- `--pulsar_broker`: Pulsar broker URL (default: "pulsar://localhost:6650")
- `--pulsar_topic`: Pulsar topic name (default: "persistent://kradsb/adsb/sbs-topic")

### Optional Parameters
- `--log_level`: Logging verbosity - DEBUG, INFO, WARNING, ERROR (default: INFO)
- `--log_sample_rate`: Log statistics every N messages (default: 100)
- `--test-mode`: Run in test mode without Pulsar (just display messages with logger)

## Features

### Reliability
- **Automatic reconnection**: Recovers from dump1090 and Pulsar outages automatically
- **Connection retry**: Exponential backoff retry logic (1s → 60s max)
- **Socket timeouts**: Prevents hanging on network issues
- **Message integrity**: Line buffering prevents message fragmentation
- **Graceful shutdown**: Proper resource cleanup on SIGINT/SIGTERM

### Performance
- **Optimized I/O**: 8KB receive buffer for efficient data transfer
- **Sampled logging**: Avoids I/O bottleneck at high message rates
- **Efficient timestamps**: Fast time.time() instead of datetime

### Monitoring
- **Message statistics**: Tracks total messages and errors
- **Configurable logging**: Adjust verbosity without code changes
- **Structured logs**: Timestamped, leveled logging for better debugging

## Advanced Usage

### Test Mode (No Pulsar Required)
Test the connection to dump1090 without needing Pulsar:
```bash
python src/python/pulsar-client-async.py \
  --test-mode \
  --source_id test-client \
  --first_socket_host localhost \
  --first_socket_port 30003 \
  --log_level INFO \
  --log_sample_rate 10
```
This mode:
- Connects to dump1090 and receives messages
- Does NOT instantiate Pulsar client (no Pulsar needed)
- Logs ALL messages with full content to console
- Displays statistics summary every N messages
- Perfect for testing and development

### Debug Mode
```bash
python src/python/pulsar-client-async.py \
  --log_level DEBUG \
  --source_id raspberrypi-001
```

### Production (Minimal Logging)
```bash
python src/python/pulsar-client-async.py \
  --log_level WARNING \
  --log_sample_rate 1000 \
  --source_id raspberrypi-prod-001 \
  --pulsar_broker pulsar://production-broker:6650
```

## Raspberry Pi Deployment

For Raspberry Pi deployment, see the deployment guide in the project documentation.

### Raspberry Pi Optimization
- Lightweight: Only ~20MB RAM footprint
- Minimal logging to reduce SD card wear
- Automatic recovery from network issues
- Low CPU usage (~5% on RPi 4)

## Development

```bash
# Install with dev dependencies
uv sync --all-extras

# Run tests (when available)
pytest

# Format code
ruff format src/

# Lint code
ruff check src/
```

## Architecture

This component is designed to be **loosely coupled** from the analytics layer (`spark-adsb`). It only communicates via Apache Pulsar, enabling independent deployment and scaling.

See `../CLAUDE.md` for full project architecture documentation.
