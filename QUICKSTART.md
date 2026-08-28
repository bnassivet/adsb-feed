# Quickstart

Everything is configured from **`adsb-stack.toml`** and driven from the
**`Makefile`**. Run `make` on its own to list targets.

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
make up-desktop  # ... and the desktop app
make down
```

With a real receiver, set `dump1090.mock = false` and point `[dump1090]` at it.

## 2. With the AI agents

Chat, voice and simulated trajectories. Needs an LLM endpoint — LM Studio on
`:1234` by default, configured at `agents.llm_base_url`.

```bash
make up-agents   # adds adsb-agent (:8000) and adsb-simulation-agent (:8300)
```

## 3. Desktop against a Raspberry Pi

The Pi records; this machine only displays. Set `[remote].uri` (and `token`) in
`adsb-stack.toml`, then:

```bash
make remote
```

The environment seeds the storage mode on **first launch only**; afterwards
change it in **Settings → History Storage**.

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
| 9494 | Quack (DuckDB over HTTP) |
| 3000 | Desktop dev server — **collides with Grafana** in the Pulsar stack |
| 8000 / 8300 | adsb-agent / adsb-simulation-agent |
