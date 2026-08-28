# Quickstart

Everything is configured from **`adsb-stack.toml`** and driven from the
**`Makefile`**. Run `make` on its own to list targets.

```bash
make skills    # once per checkout: link skills/ into .claude/
make build     # cargo build --release
make doctor    # check binaries, docker, ports before starting anything
```

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
| `adsb-stack.toml` | The only file you edit |
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
