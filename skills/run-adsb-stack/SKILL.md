---
name: run-adsb-stack
description: Configure, launch, verify and stop the local ADS-B stack (MQTT broker, feed client, data server, desktop app, AI agents). Use when asked to run, start, bring up, launch, restart, stop, or smoke-test the stack or the system end to end, to check whether data is flowing, or to point the desktop app at a remote data server on a Raspberry Pi.
---

# Running the ADS-B stack

The no-Pulsar path is four processes joined by an **MQTT broker**:
`adsb-pulsar-client` (dump1090 → MQTT), `adsb-data-server` (MQTT → DuckDB,
served over Quack), and the desktop app. Two optional Python agents add chat and
simulated flights.

The broker is the whole point: it decouples the receiver's machine from the UI's,
and lets the recorder keep working with the app closed. Apache Pulsar is **not**
in this path — it is an optional extra fan-out leg for Spark/Delta, enabled with
`pulsar.enabled = true`, never a replacement for MQTT.

**All paths below are relative to the repo root (`adsb-feed/`).**

## First: is the stack already configured?

```bash
make doctor
```

Checks the config file, binaries, the Docker daemon, port availability, skill
links, and — when agents are enabled — the LLM endpoint. Fix whatever it reports
before `make up`.

**If it reports `MISSING adsb-stack.toml`**, this is a fresh checkout:

```bash
make config     # copies adsb-stack-template.toml -> adsb-stack.toml
```

`adsb-stack.toml` is gitignored — the machine's own copy, like a `.env`. It
never exists in a fresh clone, and `make config` refuses to overwrite one that
does, so it is always safe to run.

**Then set `[receiver]` before starting anything.** The latitude/longitude are
the map centre, the origin the mock feed orbits, and the reference for
detection-range analysis; the template ships someone else's coordinates. Also
change `storage.share_token` if the port will be reachable by anyone else.

## Run it

```bash
make up          # broker -> recorder -> feed
make status      # what is running
make verify      # PROVES data is being recorded, not just that processes exist
make logs N=feed # tail one process; omit N for all
make down        # stops EVERYTHING it started, including the desktop
```

| Also | |
|---|---|
| `make up-desktop` | stack + the desktop app, backgrounded (`make logs N=desktop`) |
| `make down-desktop` | stop just the desktop |
| `make up-agents` | stack + adsb-agent and adsb-simulation-agent |
| `make reap` | kill whatever still holds the stack's ports (orphans) |
| `make remote` | desktop only, pointed at a data server elsewhere |
| `make client` | desktop **+ agents** only, no local broker/feed/recorder |
| `make render-fleet F=deploy/prod.toml` | render per-node configs for deployed Pis |

`make verify` samples `row_count` twice six seconds apart and fails if it has
not moved. That distinction matters: every process can be "running" while
nothing is recorded — see the ordering gotcha below.

Add the desktop with `make up-desktop`, or the agents with `make up-agents`.

## Running two stacks at once

`STACK` selects one. Unset, everything resolves as it always has —
`adsb-stack.toml` and `.run/` — so nothing needs renaming.

```bash
make up                      # adsb-stack.toml      -> .run/
make config STACK=prod       # creates adsb-stack-prod.toml
make up     STACK=prod       # adsb-stack-prod.toml -> .run/prod/
make paths  STACK=prod       # which files does this resolve to?
```

Everything mutable is keyed by the name: rendered configs, PID files, logs, the
database and the docker compose project. **Ports are not** — they come from each
stack's own config, which is where you can see and choose them. So a second
stack needs its own `mqtt.port`, `storage.http_port`, `dump1090.port`,
`agents.*_port`; `make doctor STACK=<name>` reports the collisions.

Two caveats worth knowing before you try:

- **The desktop app is single-instance across all stacks.** Its dev server is
  pinned to :3000, and both instances would resolve the same Tauri app-data
  directory, sharing one settings store and one DuckDB file — whose exclusive
  lock the second would lose, silently running real-time-only. `make up-desktop`
  and `make client` refuse with an explanation rather than half-work.
- **A stack whose `mqtt.host` is not local starts no broker** and `down` will not
  stop one. That is what makes a client stack safe to run beside a full one.

## Live feed and history are two independent planes

This trips people up, so check both when the app looks half-broken:

| Plane | Comes from | Selected by | Env precedence |
|---|---|---|---|
| **Live aircraft** | the broker, or dump1090 directly | `source_kind` = `mqtt` \| `socket` | env wins on **every** launch |
| **History / DB panel** | local DuckDB, or a remote one over Quack | storage mode = embedded \| remote | env seeds the **first** launch only |

They are configured separately and can disagree. An empty live map with a
working DB History panel means the history plane is pointed at the remote node
and the live plane is not.

`make up-desktop` points neither plane anywhere. Locally the desktop reads
dump1090 on `:30003` directly — the same socket the feed client uses, one hop
less for the same data. The MQTT path is still exercised, by the recorder, which
is what `make verify` proves. To put the desktop itself on the broker:

```bash
cd rust/adsb-pulsar-client-desktop
ADSB_SOURCE_KIND=mqtt ADSB_MQTT_BROKER=localhost npm run tauri dev
```

or set **Settings → Connection → Feed Source** to *MQTT subscription*.

## Configuration

**Edit `adsb-stack.toml`. Nothing else.** `make render` expands it into
`.run/feed.toml` and `.run/data-server.toml`, which carry a DO-NOT-EDIT header
because the next render overwrites them.

Three files, one direction of flow:

| File | Tracked? | Who edits it |
|---|---|---|
| `adsb-stack-template.toml` | yes | only when adding a setting everyone should get |
| `adsb-stack.toml` | **no** | you, freely — it is this machine's config |
| `.run/*.toml` | no | nobody; generated |

The file exists because `source_id` and the MQTT broker/port/topic are needed by
*both* binaries. Kept in two hand-edited files they drift, and the failure is
silent — a feed publishing to one topic while the recorder subscribes to another
looks healthy from both sides and records nothing.

Useful switches:

| Want | Set |
|---|---|
| No real receiver attached | `dump1090.mock = true` (6 aircraft orbiting your coordinates) |
| Also feed Spark/Delta | `pulsar.enabled = true` (needs `infrastructure/docker-compose.yml`) |
| Let other tools query the DB | `storage.share = true` (already the default) |
| Chat and simulated flights | `agents.enabled = true` |

To confirm a change actually reached a binary:

```bash
./rust/target/release/adsb-pulsar-client --config .run/feed.toml --print-config
```

## Identity: the one config mistake that looks like a network fault

A subscriber's MQTT client id is `<source_id>-sub`; a publisher's is `<source_id>`.
Brokers evict an existing session when a second client arrives with the same id,
so two processes sharing one identity knock each other off in a loop.

| Process | `source_id` | Client id |
|---|---|---|
| feed (publisher) | `pi-roof-prod` | `pi-roof-prod` |
| recorder (subscriber) | `pi-roof-prod` — **same, deliberately** | `pi-roof-prod-sub` |
| desktop (subscriber) | `mac-desktop-prod` — **must differ** | `mac-desktop-prod-sub` |

The feed and recorder *must* match: the recorder stamps its own `source_id` onto
every stored record, so a mismatch misattributes the data. A desktop must *not*
match, because it would collide with the recorder.

Ids also carry a **stage** (`-dev` / `-prod`) and the topic is
`adsb/<stage>/sbs/raw`, so a dev stack and a deployed fleet can share a LAN. The
topic is the stronger guard: distinct ids stop eviction, but only a distinct
topic stops a dev feed writing into the prod recorder's database. `make doctor`
warns when an id has no stage, when the topic disagrees with it, or when this
machine's id looks like the remote node's.

## Fleet config for deployed nodes

Deployed Pis do **not** use `adsb-stack.toml` — they use `/etc/adsb/*.toml` and
systemd. Those are authored in `deploy/`, one file per stage, rendered per node:

```bash
cp deploy/fleet-template.toml deploy/prod.toml   # gitignored
make render-fleet F=deploy/prod.toml             # -> deploy/.rendered/<node>/
cd rust && make deploy PI_HOST=pi@pi3.lan CONFIG_DIR=../deploy/.rendered/pi3
```

One file renders both nodes because `source_id`, the topic and the Quack token
have to agree across hosts and every mismatch is silent. Without `CONFIG_DIR`,
`make deploy` ships the generic `*.example.toml` and you edit `/etc/adsb` by
hand on the Pi. See `deploy/README.md`.

## Desktop against a real Raspberry Pi

Nothing runs locally — no broker, no feed, no recorder. **Both planes have to be
pointed at the Pi**: set `[remote].uri` (e.g. `quack:raspberrypi.local:9494`) and
`[remote].token` for history, and `[mqtt].host` to the Pi's hostname for the live
feed. Then:

```bash
make remote
```

`make remote` exports `ADSB_REMOTE_URI`/`ADSB_REMOTE_TOKEN` for history *and*
`ADSB_SOURCE_KIND=mqtt` plus the broker address for the live feed, and warns if
`mqtt.host` is still `localhost`. It used to export only the first, which is why
the "history works, live map empty" symptom below exists at all.

**The environment seeds the storage mode on first launch only.** After anything
is stored, the Settings UI wins — so if the app has run before, change it in
**Settings → History Storage** rather than expecting `make remote` to override.
That precedence is deliberate: the other way round, a leftover env var would
make the settings toggle appear dead. The live source has **no** such rule; the
environment wins every launch.

In remote mode the desktop stops recording its own history and uses a separate
local file (`adsb_local.db`) for scenarios and events of interest. The embedded
`adsb_history.db` is untouched, so switching back restores it.

## Verify without the GUI

The desktop GUI is **not drivable on macOS** — `tauri-driver` is Linux/Windows
only, and `screencapture` fails without Screen Recording permission. So check
the data plane over HTTP instead:

```bash
curl -s -X POST localhost:8787/tools/getStorageStats \
  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool

# Read a remote daemon exactly as the desktop does
cargo run -p adsb-data-engine --example remote_probe -- quack:host:9494 TOKEN
```

For verifying the desktop app itself, use the **`run-adsb-desktop`** skill —
it covers the mock feed, the merge assertions and cleanup of test rows.

## Gotchas

- **Start order is a correctness requirement.** MQTT here is QoS 0 with
  `persistence false`, so anything published before the recorder subscribes is
  gone. `make up` waits for `Subscribed to MQTT topic` in the recorder's log and
  warns if it does not appear. Never start the feed first.
- **`make down` only kills what the stack started** (PID files in `.run/`). Your
  own hand-started processes survive — and conversely, `down` will not clean up
  something you launched yourself. It *reports* anything still holding a stack
  port so you are not left guessing why the next `up` fails; `make reap` clears
  those deliberately.
- **Everything is started as a process-group leader, and stopped by group.**
  `uv run python -m adsb_agent` forks python, and `npm run tauri dev` is a tree
  of next dev, cargo and the app binary. Signalling only the recorded pid
  orphans the children, still holding their ports — which is how a stale dev
  server ends up squatting on :3000 and failing the next launch with
  `EADDRINUSE`. If you add a process to `stack.sh`, start it through `start()`;
  do not background it yourself.
- **The desktop is backgrounded, not foreground.** `make up-desktop` returns
  immediately; watch it with `make logs N=desktop` and stop it with `make down`
  or `make down-desktop`. It used to run in the foreground, which left Ctrl-C as
  the only way to stop it and orphaned the tree on any other exit.
- **Grafana and the desktop both want :3000.** The Pulsar stack's Grafana
  collides with the Next dev server; they cannot both run. `make doctor` reports
  :3000 as busy.
- **The desktop runs its own tool server, serving its own storage.** With the
  stack up, the data server already holds `storage.http_port` (8787), so the
  desktop uses `agents.desktop_tool_port` (8788) -- `make up-desktop` exports it.
  Pointed at the same port, whichever starts second fails to bind and its agent
  history tools are silently disabled, with only a WARN in the log. The two
  serve *different* databases: 8787 is what the daemon recorded, 8788 is the
  desktop's own history.
- **Duplicate processes are silently destructive.** Two `adsb-pulsar-client`s
  share one MQTT client id (derived from `source_id`), and brokers evict an
  existing session when a second client arrives with the same id — so they kick
  each other in a loop. `make doctor` counts them; `make reap` clears them.
- **A remote data server does not imply a remote live feed.** They are separate
  settings with different precedence rules (see the table above). `make remote`
  and `make client` set both; anything launched by hand sets neither.
- **The agent's tool server defaults to :8787**, which in the all-local stack
  quietly resolves to the *data server's* API rather than the desktop's. On a
  client machine there is no data server, so every agent data tool fails with
  connection-refused. `make client` exports
  `ADSB_AGENT_TOOL_SERVER_URL=http://127.0.0.1:8788` for exactly this.
- **The Quack token is printed at startup** when `share_token` is unset —
  DuckDB generates one and that log line is the only way to learn it. Grep
  `.run/logs/data-server.log` for `token:`.
- **`.run/` is disposable.** Rendered configs, PIDs, logs and the dev database.
  Delete it freely; `make up` rebuilds everything except the database.
- **Two things need doing once per checkout**: `make config` and `make skills`.
  Both are safe to re-run — neither overwrites anything.
- **A new setting must be added to the template too.** Adding it only to
  `adsb-stack.toml` means it exists on one machine and nowhere else, and the
  next person's `make config` will not produce it.
- **The agents need an LLM** (LM Studio on :1234 by default). They start without
  one and fail on first use; `make doctor` reports it when agents are enabled.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `make verify` says no new rows | Check `.run/logs/feed.log` for `Statistics: Recv: 0` — the feed is not receiving. With `dump1090.mock = false`, is dump1090 actually running on the configured port? |
| Feed running, recorder idle | Topic mismatch. Both files come from `adsb-stack.toml`, so this means `.run/` is stale: `make render`. |
| `query api not responding` in status | The recorder died. `make logs N=data-server`. A DuckDB lock error means another process holds the database. |
| `MISSING adsb-data-server` from doctor | `make build` |
| `error: adsb-stack.toml not found` | `make config` |
| A setting works here but not on another machine | It was added to `adsb-stack.toml` but not to `adsb-stack-template.toml`. `diff` them. |
| `failed to bind 127.0.0.1:8787 (agent history tools disabled)` in the desktop log | The data server owns that port. Launch via `make up-desktop`, which sets `ADSB_AGENT_TOOL_SERVER_PORT` from `agents.desktop_tool_port`. |
| Quack sharing reports `Unavailable` | The `quack` extension is downloaded on first use; needs outbound network and a writable `HOME`. |
| `EADDRINUSE :::3000` from `make up-desktop` | A previous desktop tree was orphaned. `make reap`, then retry. |
| `make down` says stopped but a port is still held | Something outside the stack owns it — `down` lists what. `make reap` if you want it gone. |
| `MQTT connection ... lost: Connection closed by peer abruptly`, repeatedly | Two clients sharing an MQTT id are evicting each other. After a few short-lived connections the log says so outright and names the id. Almost always a leftover process: `make doctor` (it counts duplicates), then `make reap`. |
| DB History panel works, live map empty | Only the history plane is pointed at the remote node. Set `[mqtt].host` to the Pi and relaunch with `make remote`, or switch **Settings → Connection → Feed Source** to MQTT. |
| Desktop shows no aircraft but `make verify` passes | The recorder is receiving and the desktop is not — they use different planes. Check the desktop's `source_kind`; with `mqtt`, check it reached the broker (`.run/logs/desktop.log`). |
| Agent chat works but every data tool errors | On a client machine, the agent is still pointed at :8787 where nothing listens. Launch via `make client`, which sets `ADSB_AGENT_TOOL_SERVER_URL`. |
| Reconnect storm right after adding a second machine | Two subscribers sharing `<source_id>-sub`. Give the desktop its own `receiver.id` — see Identity above. |
| Port 1883 busy but no broker | A system mosquitto is running: `brew services stop mosquitto`, or point `mqtt.host` at it and skip the container. |

## Files

| File | Role |
|---|---|
| `adsb-stack-template.toml` | Tracked template; `make config` copies it |
| `adsb-stack.toml` | This machine's config — the one file to edit. Gitignored |
| `scripts/render-config.py` | Expands it into `.run/*.toml` |
| `scripts/stack.sh` | Process supervision (PID files in `.run/`) |
| `Makefile` | Entry point; delegates build/deploy to `rust/Makefile` |
| `scripts/install-skills.sh` | Links `skills/` into `.claude/` |
| `deploy/fleet-template.toml` | Tracked template for a deployed fleet |
| `deploy/README.md` | The stage convention and the id rules, in full |
| `scripts/tests/test_render_config.py` | `make test-scripts` — stdlib unittest, no pytest |

## Verification status

Confirmed in the session that authored this: `doctor`, `up`, `status`, `verify`
(row_count 36 → 72 → 192), `down`, `render`, Makefile delegation to `rust/`, and
that `down` leaves foreign processes on :8000 untouched. `make up-desktop` and
`make remote` start the app correctly but their UI cannot be verified from a
shell on macOS.

`make remote`'s environment export was verified separately with `npm` stubbed:
it emits `ADSB_SOURCE_KIND=mqtt`, the broker host/port/topic and the remote
URI/token together, and prints the `mqtt.host is localhost` warning. Whether the
app then renders remote aircraft is the part that needs a human with a Pi.
