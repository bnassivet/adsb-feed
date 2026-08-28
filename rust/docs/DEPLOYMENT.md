# Deploying the ADS-B edge stack to a Raspberry Pi

> **This document is about a deployed Raspberry Pi.** For running the stack on a
> development machine, use `make up` from the repo root — see `QUICKSTART.md` and
> the `run-adsb-stack` skill. The two are independent: the Pi path uses
> `/etc/adsb/*.toml` and systemd, the dev path uses `adsb-stack.toml` and `.run/`.

Two binaries, deployed independently:

| Binary | Role | Architecture |
|---|---|---|
| `adsb-pulsar-client` | dump1090 → MQTT (and optionally Pulsar) | any, incl. 32-bit ARM |
| `adsb-data-server` | MQTT → DuckDB, Quack sharing, query API | **aarch64 / x86_64 only** |

DuckDB has no 32-bit ARM support, so a Pi Zero or a Pi 3 on a 32-bit OS can run
the feed client only; storage must live on a 64-bit node. A mixed fleet is
therefore the normal case, not an edge case.

## Building the Pi artifacts

On an **Apple Silicon Mac this is not a cross-compile.** The host is `arm64`
and the Pi is `aarch64` — the same architecture — so a `--platform linux/arm64`
container builds *natively* under Docker's VM. There is no cross toolchain to
configure, and DuckDB's bundled C++ amalgamation compiles with the container's
own gcc.

```bash
cd rust
make feed-arm64      # ~19s,    2.1 MB
make server-arm64    # ~10 min, 38 MB (bundled DuckDB, statically linked)
make edge-arm64      # both
```

Measured on an M-series Mac, 16 CPUs / 7.7 GB Docker VM. Both artifacts were
verified as `ELF 64-bit LSB pie executable, ARM aarch64` and smoke-tested in an
`aarch64` Debian container: `adsb-data-server` opens DuckDB, creates the
database file and starts its MQTT source.

The 38 MB is DuckDB statically linked — budget for it on a small SD card. The
feed client, which a 32-bit node runs alone, stays at 2.1 MB.

### What does not work, and why

- **`cross` fails on Apple Silicon.** Its images are x86_64, and
  `rust-toolchain.toml` pins 1.92, so it tries `rustup toolchain add
  1.92-x86_64-unknown-linux-gnu` and rustup refuses a non-host toolchain.
- **Do not compile `adsb-data-server` on the Pi.** The bundled DuckDB build is
  heavy in both time and RAM; a Pi will thrash or OOM.
- **Parallelism must be capped, twice over, on an 8 GB Docker VM.** The release
  profile sets `codegen-units = 1` (right for a small, fast edge binary), so
  every parallel `rustc` holds a whole crate's codegen in one unit.
  - At the default job count, `arrow-cast` is SIGKILLed by the OOM killer.
  - At `-j 4`, the *C++* side fails instead: DuckDB's unity-build translation
    units (`ub_src_*.cpp`) each take GBs in `cc1plus` at `-O3`, and cc-rs
    reports the kill as a bare `exit status: 1` — no "Killed", no signal, which
    makes it read like a compile error rather than memory exhaustion.

  Hence `JOBS = 4` for the feed client and `SERVER_JOBS = 2` for the data
  server. Measured good at 2: peak ~1.1 GiB, 9m44s. Cap parallelism rather than
  weakening the profile — the profile is what keeps the shipped binary small.

### Feed client without Pulsar

Omitting Pulsar drops the `pulsar` crate and with it the **`protoc` build
requirement**, which is the main friction when building for the edge:

```bash
cargo build --release -p adsb-pulsar-client --no-default-features --features cli,mqtt
```

Verified: that dependency graph contains neither `pulsar` nor `prost`.

## Installing

```bash
make deploy PI_HOST=pi@raspberrypi.local
# then, on the Pi:
sudo bash /tmp/install-edge.sh
```

`install-edge.sh` detects the architecture and skips the data server on 32-bit
nodes. It is idempotent, and it **never overwrites an existing config** — a new
one lands as `*.toml.new` so an upgrade cannot silently change a running node's
settings.

Edit `/etc/adsb/feed.toml` (and `data-server.toml`) before starting. **Set a
unique `source_id` per node**: it is stamped onto every stored record, and the
MQTT client id derives from it, so duplicates both make the data unattributable
and cause brokers to evict each other's sessions.

## The broker

The MQTT hop needs one. On the Pi: `apt install mosquitto`, or use the compose
stack at `infrastructure/mqtt/`. Persistence is deliberately off: the ADS-B feed
is a live stream, so a disconnected subscriber has missed nothing it can use,
and persistence only costs SD-card writes. Durability is the recorder's job.

## Resource limits

The two units are deliberately not interchangeable:

| | `adsb-pulsar-client` | `adsb-data-server` |
|---|---|---|
| `MemoryMax` | 100M | **512M** |
| Why | parses lines, forwards bytes | DuckDB wants ≥125 MB **per thread** |

Copying the feed client's 100M to the data server gets it OOM-killed on its
first real query. This is the single most likely deployment mistake.

## Quack sharing

Off by default (`share = false`). Before enabling it:

- The `quack` extension is **not** statically linked into the bundled DuckDB
  build. First use downloads it from `extensions.duckdb.org`, so the host needs
  outbound network and a writable extension directory. The unit sets
  `HOME=/var/lib/adsb` for exactly this; a read-only home makes sharing report
  `Unavailable` rather than fail loudly.
- **A token grants full read *and* write** access to every table.
- The Quack server terminates **no TLS**. A client attaching to a remote daemon
  assumes HTTPS and needs `DISABLE_SSL true` without a reverse proxy — needing
  that flag is the signal your deployment is missing its proxy.

Treat it as homelab-grade on a trusted LAN. Never port-forward it.

## Verifying a node

```bash
systemctl status adsb-pulsar-client adsb-data-server
journalctl -u adsb-data-server -f

# Is data landing?
curl -s -X POST localhost:8787/tools/getStorageStats -d '{}' | python3 -m json.tool

# Watch the raw feed
mosquitto_sub -h localhost -t 'adsb/sbs/raw' -C 5
```

Watch RSS against `MemoryMax` for at least an hour of real traffic before
calling a node good.
