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

## Where things are

| Path | What |
|---|---|
| `adsb-stack-template.toml` | Tracked template; `make config` copies it |
| `adsb-stack.toml` | Your local config — the only file you edit. Gitignored |
| `.run/` | Rendered configs, PID files, logs, dev database. Disposable, gitignored |
| `.run/logs/*.log` | Per-process output (`make logs N=feed`) |
| `skills/` | Agent skills, symlinked into `.claude/` by `make skills` |

## Ports

| Port | Service |
|---|---|
| 1883 | MQTT broker |
| 30003 | dump1090 (real or mock) |
| 8787 | Data server query API |
| 8788 | Desktop tool server — separate port so it does not collide with 8787 |
| 9494 | Quack (DuckDB over HTTP) |
| 3000 | Desktop dev server — **collides with Grafana** in the Pulsar stack |
| 8000 / 8300 | adsb-agent / adsb-simulation-agent |
