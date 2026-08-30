# Quickstart

Everything is configured from **`adsb-stack.toml`** and driven from the
**`Makefile`**. Run `make` on its own to list targets.

The stack is four processes joined by an **MQTT broker**: `adsb-pulsar-client`
reads dump1090 and publishes raw SBS-1 to a topic; `adsb-data-server` subscribes
and records to DuckDB; the desktop app displays. The broker is what lets the
receiver live on a different machine from the UI, and what lets the recorder
keep working when the app is closed. No Apache Pulsar is involved — that stays
an optional extra leg for the Spark/Delta pipeline. Design detail:
[`rust/adsb-pulsar-client-desktop/docs/DESIGN.md` §27](rust/adsb-pulsar-client-desktop/docs/DESIGN.md#message-sources--the-mqtt-broker).

```bash
make config    # once: copy adsb-stack-template.toml -> adsb-stack.toml
make skills    # once: link skills/ into .claude/
make build     # cargo build --release
make doctor    # check config, binaries, docker, ports before starting anything
```

`adsb-stack.toml` is **gitignored** — it is your machine's copy, like a `.env`.
It holds your antenna's real position, local paths and a Quack token, none of
which belong in someone else's checkout. `adsb-stack-template.toml` is the
tracked version; edit that only when adding a setting everyone should get.
`make config` never overwrites an existing file.

Set your antenna's real position in `[receiver]` before anything else — it is
the map centre, the origin for the mock feed, and the reference for
detection-range analysis.

## 1. All-local development

No receiver and no Pulsar needed — `dump1090.mock = true` is the default, which
starts six simulated aircraft orbiting the coordinates in `[receiver]`.

```bash
make up          # broker -> data server -> feed
make verify      # confirms rows are actually being recorded
make up-desktop  # ... and the desktop app (backgrounded)
make logs N=desktop
make down        # stops everything, desktop included
```

`make reap` clears orphans if a previous run left something holding a port.

**A second stack in parallel.** `STACK=<name>` selects one; unset behaves exactly
as above, so nothing needs renaming.

```bash
make config STACK=prod   # creates adsb-stack-prod.toml
make up     STACK=prod   # its own .run/prod/, database, logs and broker
make paths  STACK=prod   # which files am I actually using?
```

Rendered configs, PIDs, logs, the database and the docker compose project are
all keyed by the name. **Ports are not** — set them in the second stack's own
`[mqtt]`, `[storage]`, `[dump1090]` and `[agents]`, and `make doctor STACK=prod`
reports what still collides.

The desktop app can run twice — set `[desktop].dev_port` and
`[desktop].tool_port` (`:3000` and `:8788` are the defaults) and the rest
follows. Each instance keeps its **own DuckDB and
settings** in `<app-data>/<stack>/`, so dev and prod history never mix, and talks
to its own stack's agent. A named stack builds into `rust/target-desktop-<name>`,
so the first run compiles from scratch (~10 min, several GB) and says so.

With a real receiver, set `dump1090.mock = false` and point `[dump1090]` at it.

**The desktop reads dump1090 directly here, not through the broker.** Its
`source_kind` defaults to `socket`, and locally that is the same `:30003` the
feed client uses — one hop less for the same data. The MQTT path is still
exercised by the recorder, which is what `make verify` checks. To put the
desktop on the broker too, launch it with
`ADSB_SOURCE_KIND=mqtt ADSB_MQTT_BROKER=localhost npm run tauri dev`, or set it
in **Settings → Connection → Feed Source**.

## 2. With the AI agents

Chat, voice and simulated trajectories. Needs an LLM endpoint — LM Studio on
`:1234` by default, configured at `agents.llm_base_url`.

```bash
make up-agents   # adds adsb-agent (:8000) and adsb-simulation-agent (:8300)
```

## 3. Desktop against a Raspberry Pi

The Pi records; this machine only displays. Nothing runs locally — no broker, no
feed, no recorder.

**Two independent planes both have to point at the Pi**, and forgetting the
second is the classic misconfiguration: history loads fine while the live map
stays empty.

| Plane | Setting | Applied |
|---|---|---|
| History | `[remote].uri` + `token` → Quack `ATTACH` | first launch only |
| Live feed | `[mqtt].host` → the Pi's broker | every launch |

Set `[remote].uri` (e.g. `quack:raspberrypi.local:9494`), `[remote].token`, and
`[mqtt].host` to the Pi's hostname, then:

```bash
make remote
```

`make remote` exports both — `ADSB_REMOTE_URI` for history and
`ADSB_SOURCE_KIND=mqtt` plus the broker address for the live feed. It warns if
`mqtt.host` is still `localhost`, which would read a feed that is not there.

The storage mode is seeded on **first launch only**; afterwards change it in
**Settings → History Storage**. The live source has no such rule — the
environment wins every launch.

To set the Pi up in the first place, see `rust/docs/DEPLOYMENT.md` — that path
uses `make edge-arm64`, `make deploy` and `install-edge.sh` with systemd, and is
independent of the local tooling here.

## 4. Dev and prod side by side

The common pairing: the all-local dev stack for development, and a prod stack
that is a **client** of the Pi fleet. Both at once, on this machine.

```bash
# once
make config STACK=prod          # -> adsb-stack-prod.toml (gitignored)
$EDITOR adsb-stack-prod.toml    # the Pi's hostname, the Quack token, and
                                # ports that differ from the dev stack's

# every day
make up-desktop                 # dev:  local broker, feed, recorder, desktop
make client STACK=prod          # prod: desktop + agents against the Pi fleet

make status ; make status STACK=prod
make down   ; make down   STACK=prod
```

Give the prod stack its own ports — nothing derives them:

| | dev | prod |
|---|---|---|
| `[desktop].dev_port` / `tool_port` | 3000 / 8788 | 3010 / 8798 |
| `[agents].agent_port` / `sim_agent_port` | 8000 / 8300 | 8010 / 8310 |
| `[storage].http_port` | 8787 | 8797 |
| `[receiver].id` | `<host>-dev` | `<host>-prod` — and **not** the fleet's id |

Each window shows its stage as a badge in the top bar — blue for `dev`, amber
for `prod`. It is read from `receiver.id`'s suffix, so an id without one shows
no badge; `make doctor` warns about that.

`make doctor STACK=prod` reports what still collides. The two desktops keep
separate history (`<app-data>/prod/`), separate settings, and each talks to its
own stack's agent.

## 5. Split fleet: feed Pi → recorder Pi → this desktop

The receiver and the recorder on separate machines, with this Mac as a pure
client. Nothing runs locally — no broker, no feed, no recorder.

```
[Pi 3, armv7]                   [Pi 4, aarch64]                  [macOS]
dump1090 → adsb-pulsar-client ──MQTT──→ mosquitto → adsb-data-server
                                  :1883                    ↓  ↓
                                            :1883 (live) ──┘  └── :9494 (history)
                                                     ↓              ↓
                                                    this desktop + agents
```

**Fleet config lives in `deploy/`**, not in `adsb-stack.toml` — deployed nodes
have a different lifecycle from the dev stack (`/etc/adsb` and systemd, versus
`.run/` and `stack.sh`). One authored file per stage renders both nodes:

```bash
cp deploy/fleet-template.toml deploy/prod.toml   # gitignored, like adsb-stack.toml
$EDITOR deploy/prod.toml                          # hostnames, site id, token
make render-fleet F=deploy/prod.toml              # -> deploy/.rendered/<node>/

cd rust
make feed-armv7 && make deploy TARGET_DIR=target-linux-armv7 \
    PI_HOST=pi@pi3.lan CONFIG_DIR=../deploy/.rendered/pi3
make edge-arm64 && make deploy PI_HOST=pi@pi4.lan CONFIG_DIR=../deploy/.rendered/pi4
# then on each Pi:  sudo bash /tmp/install-edge.sh
```

Then point this machine at it in `adsb-stack.toml` — **both planes**, and give
the client its **own** `receiver.id`:

```toml
[receiver]
id = "mac-desktop-prod"        # NOT the fleet's id -- see below
[dump1090]
mock = false
[mqtt]
host = "pi4.lan"               # live plane
topic = "adsb/prod/sbs/raw"
[remote]
uri = "quack:pi4.lan:9494"     # history plane
token = "<the fleet's share_token>"
```

```bash
make client      # desktop + agents, nothing else
```

**Why the client needs its own id.** A subscriber's MQTT client id is
`<receiver.id>-sub`. The Pi 4's recorder already holds `pi-roof-prod-sub`, so a
desktop reusing the fleet's id would take the same one and the two would evict
each other in a loop — killing recording and the live map together, with only a
reconnect storm in the logs to show for it. `make doctor` warns about this and
about a stage that disagrees between `receiver.id` and `mqtt.topic`.

See `deploy/README.md` for the full convention and `rust/docs/DEPLOYMENT.md` for
the node setup, including configuring mosquitto (`apt install` alone leaves it
listening on localhost only).

## Where things are

| Path | What |
|---|---|
| `adsb-stack-template.toml` | Tracked template; `make config` copies it |
| `adsb-stack.toml` | Your local config — the only file you edit. Gitignored |
| `.run/` | Rendered configs, PID files, logs, dev database. Disposable, gitignored |
| `.run/logs/*.log` | Per-process output (`make logs N=feed`) |
| `skills/` | Agent skills, symlinked into `.claude/` by `make skills` |
| `deploy/fleet-template.toml` | Tracked template for a deployed fleet |
| `deploy/<stage>.toml` | Your fleet: hostnames, ids, Quack token. Gitignored |
| `deploy/.rendered/` | Per-node configs `make deploy` ships. Derived, gitignored |

## Ports

| Port | Service |
|---|---|
| 1883 | MQTT broker |
| 30003 | dump1090 (real or mock) |
| 8787 | Data server query API |
| 8788 | Desktop tool server — separate port so it does not collide with 8787 |
| 3010 / 8798 | A second stack's desktop (`[desktop].dev_port` / `tool_port`) |
| 8010 / 8310 | A second stack's agents |
| 8797 / 9495 | A second stack's data server and Quack |
| 9494 | Quack (DuckDB over HTTP) |
| 3000 | Desktop dev server — **collides with Grafana** in the Pulsar stack |
| 8000 / 8300 | adsb-agent / adsb-simulation-agent |

Nothing derives a second stack's ports — set them in that stack's own config
and let `make doctor STACK=<name>` tell you what still collides. The values
above are only the convention this repo's examples use.
