---
name: run-adsb-stack
description: Configure, launch, verify and stop the local ADS-B stack (MQTT broker, feed client, data server, desktop app, AI agents). Use when asked to run, start, bring up, launch, restart, stop, or smoke-test the stack or the system end to end, to check whether data is flowing, or to point the desktop app at a remote data server on a Raspberry Pi.
---

# Running the ADS-B stack

The no-Pulsar path is four processes: an MQTT broker, `adsb-pulsar-client`
(dump1090 → MQTT), `adsb-data-server` (MQTT → DuckDB, served over Quack), and
the desktop app. Two optional Python agents add chat and simulated flights.

**All paths below are relative to the repo root (`adsb-feed/`).**

## First: is the stack already configured?

```bash
make doctor
```

Checks binaries, the Docker daemon, port availability, skill links, and — when
agents are enabled — the LLM endpoint. Fix whatever it reports before `make up`.

## Run it

```bash
make up          # broker -> recorder -> feed
make status      # what is running
make verify      # PROVES data is being recorded, not just that processes exist
make logs N=feed # tail one process; omit N for all
make down
```

`make verify` samples `row_count` twice six seconds apart and fails if it has
not moved. That distinction matters: every process can be "running" while
nothing is recorded — see the ordering gotcha below.

Add the desktop with `make up-desktop`, or the agents with `make up-agents`.

## Configuration

**Edit `adsb-stack.toml`. Nothing else.** `make render` expands it into
`.run/feed.toml` and `.run/data-server.toml`, which carry a DO-NOT-EDIT header
because the next render overwrites them.

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

## Desktop against a real Raspberry Pi

```bash
# Set [remote].uri (e.g. quack:raspberrypi.local:9494) and token, then:
make remote
```

**The environment seeds the mode on first launch only.** After anything is
stored, the Settings UI wins — so if the app has run before, change it in
**Settings → History Storage** rather than expecting `make remote` to override.
That precedence is deliberate: the other way round, a leftover env var would
make the settings toggle appear dead.

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
  something you launched yourself.
- **Grafana and the desktop both want :3000.** The Pulsar stack's Grafana
  collides with the Next dev server; they cannot both run. `make doctor` reports
  :3000 as busy.
- **The Quack token is printed at startup** when `share_token` is unset —
  DuckDB generates one and that log line is the only way to learn it. Grep
  `.run/logs/data-server.log` for `token:`.
- **`.run/` is disposable.** Rendered configs, PIDs, logs and the dev database.
  Delete it freely; `make up` rebuilds everything except the database.
- **Skills need installing once per checkout**: `make skills`. They are tracked
  in `skills/` and symlinked into `.claude/`, which is gitignored.
- **The agents need an LLM** (LM Studio on :1234 by default). They start without
  one and fail on first use; `make doctor` reports it when agents are enabled.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `make verify` says no new rows | Check `.run/logs/feed.log` for `Statistics: Recv: 0` — the feed is not receiving. With `dump1090.mock = false`, is dump1090 actually running on the configured port? |
| Feed running, recorder idle | Topic mismatch. Both files come from `adsb-stack.toml`, so this means `.run/` is stale: `make render`. |
| `query api not responding` in status | The recorder died. `make logs N=data-server`. A DuckDB lock error means another process holds the database. |
| `MISSING adsb-data-server` from doctor | `make build` |
| Quack sharing reports `Unavailable` | The `quack` extension is downloaded on first use; needs outbound network and a writable `HOME`. |
| Port 1883 busy but no broker | A system mosquitto is running: `brew services stop mosquitto`, or point `mqtt.host` at it and skip the container. |

## Files

| File | Role |
|---|---|
| `adsb-stack.toml` | The one file to edit |
| `scripts/render-config.py` | Expands it into `.run/*.toml` |
| `scripts/stack.sh` | Process supervision (PID files in `.run/`) |
| `Makefile` | Entry point; delegates build/deploy to `rust/Makefile` |
| `scripts/install-skills.sh` | Links `skills/` into `.claude/` |

## Verification status

Confirmed in the session that authored this: `doctor`, `up`, `status`, `verify`
(row_count 36 → 72 → 192), `down`, `render`, Makefile delegation to `rust/`, and
that `down` leaves foreign processes on :8000 untouched. `make up-desktop` and
`make remote` start the app correctly but their UI cannot be verified from a
shell on macOS.
