# ADS-B Project Infrastructure

This directory contains infrastructure configuration and deployment files for the ADS-B data streaming pipeline.

## Overview

The infrastructure stack includes:

- **Apache Pulsar** (standalone mode) - Message broker for streaming ADS-B data from edge devices to analytics
- **Prometheus** - Metrics collection and time-series storage
- **Grafana** - Visualization dashboards with pre-built Pulsar monitoring

## Quick Start

### Start the Infrastructure

```bash
# From the infrastructure directory
docker compose up -d

# View logs
docker compose logs -f

# View logs for specific service
docker compose logs -f pulsar
```

### Stop the Infrastructure

```bash
# Stop all services
docker compose down

# Stop and remove all data volumes (clean slate)
docker compose down -v
```

## Service Access

After starting the stack, services are available at:

| Service | URL | Credentials | Purpose |
|---------|-----|-------------|---------|
| **Pulsar Broker** | `pulsar://localhost:6650` | - | Producer/Consumer connections |
| **Pulsar Admin API** | `http://localhost:8080` | - | Admin operations and metrics |
| **Prometheus** | `http://localhost:9090` | - | Metrics queries and exploration |
| **Grafana** | `http://localhost:3000` | `admin/admin` | ADS-B dashboards, provisioned from `grafana/dashboards/` |

Prometheus and Grafana start **without** Pulsar:

```bash
make monitoring          # or: docker compose up -d prometheus grafana
make down-monitoring
```

Pulsar and its init container sit behind a compose profile
(`--profile pulsar`), because the MQTT path needs no Pulsar at all and
monitoring is useful on every stack.

## Monitoring the ADS-B services

The five first-party services each serve `/metrics`:

| Service | Port | Notes |
|---------|------|-------|
| Feed client | 8790 | `[metrics].feed_port`; the only one with a port of its own |
| Data server | 8787 | shares `[storage].http_port` |
| Weather service | 8789 | shares `[weather].http_port` |
| adsb-agent | 8000 | |
| adsb-simulation-agent | 8300 | |

They are **native host processes, not containers**, which is the whole
difficulty. Prometheus reaches them via `host.docker.internal`, mapped to
`host-gateway` so the same target string works on Docker Desktop and on Linux.

**A container reaching the host that way is not loopback.** So on a development
machine only the services bound beyond `127.0.0.1` are scrapeable: set
`[metrics].feed_bind = "0.0.0.0"` for the feed, and expect the recorder and
weather jobs to show as **DOWN** — the recorder's bind is hardcoded to loopback,
and opening the weather service's port would also expose its unauthenticated
`PUT /v1/enabled`. Both agents already bind `0.0.0.0`.

On a Raspberry Pi, use the override instead, which puts Prometheus on the host
network so every target is `localhost` and **nothing has to be opened**:

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml up -d prometheus grafana
```

## Pre-configured Topics

The initialization container automatically creates:

- `persistent://kradsb/adsb/sbs-topic` - For SBS-1 text messages (dump1090 port 30003)
- `persistent://kradsb/adsb/sbs-binary-topic` - For binary messages (dump1090 port 30002)

## Directory Structure

```
infrastructure/
├── docker-compose.yml       # Main Docker Compose configuration
├── docker-compose.pi.yml    # Override: Prometheus on the host network (Pi)
├── prometheus/
│   ├── prometheus.yml       # Scrape config (host.docker.internal targets)
│   └── prometheus.pi.yml    # Scrape config for the host-network override
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/     # Prometheus datasource (uid adsb-prometheus)
│   │   └── dashboards/      # Dashboard provider
│   └── dashboards/          # The ADS-B dashboards themselves (tracked JSON)
├── mqtt/                    # Mosquitto broker for the MQTT path
├── pulsar/                  # Pulsar setup scripts and monitoring (legacy)
├── kubernetes/              # Kubernetes manifests
└── DockerCompose/           # Legacy Docker configurations
```

## Connecting Clients

Once the infrastructure is running, connect your ADS-B feed clients:

**Python Client:**
```bash
cd ../../  # Back to adsb-feed root
source .venv/bin/activate
python src/python/pulsar-client-async.py \
  --source_id my-receiver \
  --first_socket_host 10.0.0.200 \
  --first_socket_port 30003 \
  --pulsar_broker pulsar://localhost:6650 \
  --pulsar_topic persistent://kradsb/adsb/sbs-topic
```

**Rust Client:**
```bash
cd ../rust/adsb-pulsar-client
./target/release/adsb-pulsar-client \
  --source-id my-receiver \
  --socket-host 10.0.0.200 \
  --socket-port 30003 \
  --pulsar-broker pulsar://localhost:6650 \
  --pulsar-topic persistent://kradsb/adsb/sbs-topic
```

## Monitoring

### View Pulsar Topics

```bash
# List all topics
docker compose exec pulsar /pulsar/bin/pulsar-admin topics list kradsb/adsb

# Get topic stats
docker compose exec pulsar /pulsar/bin/pulsar-admin topics stats persistent://kradsb/adsb/sbs-topic
```

### Grafana Dashboards

1. Open Grafana at `http://localhost:3000`
2. Login with `admin/admin`
3. Navigate to Dashboards → Apache Pulsar
4. View pre-built dashboards for:
   - Broker metrics (throughput, latency)
   - Topic statistics
   - Namespace overview
   - Consumer and producer metrics

### Prometheus Queries

Access Prometheus at `http://localhost:9090` to run custom queries:

```promql
# Message rate per topic
rate(pulsar_in_messages_total[1m])

# Broker throughput
rate(pulsar_in_bytes_total[1m])

# Topic backlog
pulsar_subscription_back_log
```

## Data Persistence

All data is persisted in Docker named volumes:

- `adsb_pulsar_data` - Pulsar ledgers and metadata
- `adsb_prometheus_data` - Prometheus metrics database (15 days retention)
- `adsb_grafana_data` - Grafana dashboards and settings

To reset all data:
```bash
docker compose down -v
```

## Troubleshooting

**Services not starting:**
```bash
# Check service health
docker compose ps

# View detailed logs
docker compose logs pulsar
```

**Pulsar topics not created:**
```bash
# Re-run initialization
docker compose up pulsar-init

# Manually create topic
docker compose exec pulsar /pulsar/bin/pulsar-admin topics create persistent://kradsb/adsb/sbs-topic
```

**Cannot connect to Pulsar:**
```bash
# Verify Pulsar is healthy
curl http://localhost:8080/admin/v2/brokers/health

# Check if port is listening
netstat -an | grep 6650
```

## Production Deployment

For production use:

1. **Change Grafana credentials** in `docker-compose.yml`:
   ```yaml
   - GF_SECURITY_ADMIN_PASSWORD=your-secure-password
   ```

2. **Adjust retention** in `docker-compose.yml`:
   ```yaml
   - '--storage.tsdb.retention.time=30d'  # Increase Prometheus retention
   ```

3. **Enable SSL/TLS** for external access (see Pulsar documentation)

4. **Configure firewall** to restrict access to necessary ports only

## Additional Resources

- [Apache Pulsar Documentation](https://pulsar.apache.org/docs/)
- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
