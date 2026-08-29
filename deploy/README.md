# `deploy/` — fleet configuration

Configs for **deployed nodes** (Raspberry Pis running systemd), as opposed to
`adsb-stack.toml` in the repo root, which configures the **development stack**
on this machine. The two are independent and use different paths: `/etc/adsb/`
and systemd here, `.run/` and `scripts/stack.sh` there.

```
deploy/
  fleet-template.toml    tracked     copy this to start a fleet
  <stage>.toml           gitignored  the real thing: hostnames, ids, token
  .rendered/             gitignored  derived; `make deploy` ships from here
    pi3/feed.toml
    pi4/data-server.toml
```

## Why one file per stage, not one per node

Three things must agree across hosts, and every one of them fails **silently**:

| Must match | Between |
|---|---|
| `source_id` | the feed node ↔ the recorder |
| `mqtt_topic` | every node in the fleet |
| `share_token` | the recorder ↔ whoever attaches to it |

A feed publishing to one topic while the recorder subscribes to another looks
healthy from both sides and records nothing. So the shared values are written
**once** and composed into each node's file, the same reasoning that produced
`adsb-stack.toml` for the dev stack.

## Usage

```bash
cp deploy/fleet-template.toml deploy/prod.toml   # gitignored
$EDITOR deploy/prod.toml
make render-fleet F=deploy/prod.toml             # -> deploy/.rendered/<node>/

# ship binaries + that node's rendered config
cd rust
make feed-armv7   && make deploy TARGET_DIR=target-linux-armv7 PI_HOST=pi@pi3.lan CONFIG_DIR=../deploy/.rendered/pi3
make edge-arm64   && make deploy PI_HOST=pi@pi4.lan CONFIG_DIR=../deploy/.rendered/pi4
# then on each Pi:  sudo bash /tmp/install-edge.sh
```

`install-edge.sh` reads `uname -m` and skips the data server on 32-bit ARM, so a
feed-only node needs no special handling. It **never overwrites** an existing
`/etc/adsb/*.toml` — a new one lands as `*.toml.new`, so an upgrade cannot
silently change a running node's settings. That also means re-rendering does not
reconfigure a live node: copy the `.new` file over deliberately and restart.

## The stage convention

`source_id` is an identity on a shared bus, so it must be unique per process
role **and** per environment:

```
source_id  =  <site>-<stage>          composed by the renderer
mqtt_topic =  adsb/<stage>/sbs/raw    derived from `stage` unless set
```

| Process | `source_id` | MQTT client id | Topic |
|---|---|---|---|
| feed (publisher) | `pi-roof-prod` | `pi-roof-prod` | `adsb/prod/sbs/raw` |
| recorder (subscriber) | `pi-roof-prod` | `pi-roof-prod-sub` | `adsb/prod/sbs/raw` |
| desktop (subscriber) | `mac-desktop-prod` | `mac-desktop-prod-sub` | `adsb/prod/sbs/raw` |

Two rules fall out of how ids are derived (`config.rs`, `mqtt_client_id()`;
`source/mqtt_source.rs` appends `-sub` for subscribers):

- **The feed and recorder share `source_id`** — the recorder stamps its own
  value onto every stored record, so a mismatch misattributes the data. They do
  not collide on the broker because only one of them is a subscriber.
- **A desktop must not reuse it.** It is a *second* subscriber, so it would take
  `<id>-sub` — already the recorder's — and the two would evict each other in a
  loop, killing recording and the live map together. Give the client its own
  `[receiver].id` in `adsb-stack.toml`.

The stage in the **topic** is the stronger guard of the two: distinct ids stop
clients evicting each other, but only a distinct topic stops a dev feed writing
into the prod recorder's database.

Note this is a *convention*, not enforcement. The clients have no MQTT
credentials (`Config` has no `mqtt_username`/`password`), so nothing stops a
misconfigured client subscribing to the prod topic. The trust boundary is the
network segment.

## See also

- `rust/docs/DEPLOYMENT.md` — building the artifacts, systemd, the broker,
  resource limits, verifying a node
- `QUICKSTART.md` — the topologies, including a desktop attached to a fleet
- `rust/adsb-pulsar-client/feed.example.toml`,
  `rust/adsb-data-server/data-server.example.toml` — the field-by-field schema
  reference these rendered files conform to
