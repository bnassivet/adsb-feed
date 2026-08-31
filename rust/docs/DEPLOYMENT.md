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

Edit `/etc/adsb/feed.toml` (and `data-server.toml`) before starting — unless you
shipped rendered configs, below.

### Identities, and the stage convention

**`source_id` is an identity on a shared bus.** It is stamped onto every stored
record, and the MQTT client id derives from it: publishers use it verbatim,
subscribers append `-sub`. Two rules follow, and they pull in opposite
directions:

- A feed node and the recorder that stores its data **must share `source_id`**.
  The recorder stamps *its own* value onto every record, so a mismatch makes the
  data claim the wrong receiver. They do not collide on the broker because only
  one of them subscribes.
- Any *additional* subscriber — a desktop app, a second recorder — **must not**
  reuse it, or it takes an id already in use and the two evict each other in a
  reconnect loop.

Ids also carry the deployment **stage**, and the topic is scoped to match:

```
source_id  =  <site>-<stage>          e.g. pi-roof-prod
mqtt_topic =  adsb/<stage>/sbs/raw    e.g. adsb/prod/sbs/raw
```

The topic is the stronger guard of the two: distinct ids stop clients evicting
each other, but only a distinct topic stops a development feed writing into this
recorder's database. It is a convention, not enforcement — the clients have no
MQTT credentials, so nothing stops a misconfigured publisher.

### Shipping configs instead of editing on the Pi

`make deploy` sends the generic `*.example.toml` by default. For a fleet, author
one file per stage in `deploy/` and render it per node — the shared values
(`source_id`, topic, Quack token) are then written once and cannot drift:

```bash
cp deploy/fleet-template.toml deploy/prod.toml    # gitignored: hostnames + token
make render-fleet F=deploy/prod.toml
cd rust && make deploy PI_HOST=pi@pi4.lan CONFIG_DIR=../deploy/.rendered/pi4
```

`install_config` still refuses to overwrite a live `/etc/adsb/*.toml` — a new one
lands as `*.toml.new` — so this configures a *new* node and stages an upgrade for
an existing one. See `deploy/README.md`.

## The broker

Everything downstream of dump1090 goes through MQTT, so the node needs a broker:
`apt install mosquitto`, or the compose stack at `infrastructure/mqtt/`. It does
not have to run on the same node as the feed client — `mqtt_broker` is just an
address — but co-locating it with the recorder is the usual choice.

**Mosquitto 2.x ships closed.** With no `listener` directive its default
listener binds `localhost` and refuses remote anonymous clients, so a broker
installed from `apt` and left alone accepts the local feed client and **nothing
across the LAN** — the desktop app then sees no live aircraft with no error that
names the cause. Copy `infrastructure/mqtt/mosquitto.conf`, or at minimum:

```conf
listener 1883
allow_anonymous true    # LAN-local bus; see the warning below
persistence false
```

`allow_anonymous true` means anyone who can reach port 1883 can read the feed
and publish to it. That is acceptable on a trusted LAN and nowhere else — never
port-forward it.

**The clients cannot authenticate.** There is no `mqtt_username`/`mqtt_password`
in `Config`; `allow_anonymous false` therefore locks out the feed client and the
recorder along with everyone else. The isolation mechanism is the network, not
the broker: keep 1883 on a trusted segment, and put a proxy in front of it if
that is not enough. Adding credentials means adding the fields and passing them
through `MqttOptions::set_credentials` on both ends first.

`persistence false` is deliberate: the ADS-B feed is a live stream, so a
disconnected subscriber has missed nothing it can still use, and persistence
only costs SD-card writes. Durability is the recorder's job, in DuckDB.

### Start order, and what systemd does not guarantee

QoS 0 plus no persistence means **anything published before the recorder
subscribes is gone**. `adsb-data-server.service` carries
`After=mosquitto.service` and `adsb-pulsar-client.service` carries
`After=adsb-data-server.service`, so a boot brings them up in the right order.

`After=` is ordering only, not a dependency: it says "not before", never "only
if it worked". A recorder that starts and then crashes still lets the feed
start, and the feed will happily publish into a topic nobody is reading. That
is the intended posture for an edge node — the feed must not stop because
storage is broken — but it means **`systemctl is-active` on both units is not
proof that anything is being recorded.** Check `row_count`, as below.

The window is small in practice (the recorder subscribes within a second or
two of starting) and costs a few seconds of positions after a reboot. It is not
worth engineering away; it *is* worth knowing about before you go hunting for a
gap in the data at every restart.

### When two clients fight

The MQTT client id derives from `source_id`. Brokers evict an existing session
when a second client connects with the same id, so two nodes sharing a
`source_id` — or one node with a leftover process — knock each other off in a
loop. The feed client detects this and says so outright after a few short-lived
connections:

```
MQTT connection to localhost:1883 keeps dropping (2 times). Another client is
probably connected with the same id ('pi-roof') and evicting this one --
check for a second adsb-pulsar-client, or set a distinct mqtt_client_id.
```

Reconnects are paced by the client itself (100 ms doubling to 30 s), and the
attempt counter resets only after a connection has held for 30 s — an eviction
storm connects *successfully* every time, so resetting on connect would leave it
spinning. Set `mqtt_client_id` explicitly if one node must run two feed clients.

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

## Pointing a desktop at this node

The desktop has **two independent planes**, and a Pi deployment has to satisfy
both:

| Plane | Desktop setting | Serves from |
|---|---|---|
| Live aircraft | `[mqtt].host` = this node | the broker, port 1883 |
| History | `[remote].uri` = `quack:<host>:9494` + `token` | `adsb-data-server`, Quack sharing on |

Setting only the second is the common mistake: history loads, live map stays
empty. From the developer machine, `make remote` sets both — see
`QUICKSTART.md` topology 3 and the `run-adsb-stack` skill.

History over Quack additionally needs `share = true` in
`/etc/adsb/data-server.toml` (off by default, see above). The live plane needs
only a reachable broker.

## Verifying a node

```bash
systemctl status adsb-pulsar-client adsb-data-server
journalctl -u adsb-data-server -f

# Is data landing?
curl -s -X POST localhost:8787/tools/getStorageStats -d '{}' | python3 -m json.tool

# Watch the raw feed
mosquitto_sub -h localhost -t 'adsb/sbs/raw' -C 5

# ... and from ANOTHER machine, which is what the desktop actually does.
# Works locally but not remotely => the mosquitto listener is still localhost-only.
mosquitto_sub -h raspberrypi.local -t 'adsb/sbs/raw' -C 5
```

Watch RSS against `MemoryMax` for at least an hour of real traffic before
calling a node good.
