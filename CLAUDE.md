## Running the stack

`make` from this directory lists every target. `make up` starts the local
no-Pulsar stack (broker → data server → feed), `make verify` proves rows are
actually being recorded, `make down` stops it. `make doctor` is the preflight.

Configuration is `adsb-stack.toml` — gitignored, like a `.env`. Create it with
`make config` (copies `adsb-stack-template.toml`, never overwrites). It is
expanded into `.run/*.toml` by `make render`; never edit the rendered files.
A new setting belongs in the **template** as well, or it exists on one machine
only. See QUICKSTART.md for the five supported topologies.

### Named stacks: dev and prod in parallel

`STACK=<name>` selects a configuration. **Unset resolves exactly as it always
has** — `adsb-stack.toml`, `.run/` — so nothing that predates named stacks
needs renaming.

```bash
make up                    # adsb-stack.toml       .run/        (dev)
make client STACK=prod     # adsb-stack-prod.toml  .run/prod/   (a fleet client)
make paths  STACK=prod     # which files does this resolve to?
```

| Target | Starts |
|---|---|
| `make up` | broker → recorder → feed |
| `make up-desktop` | ...and the desktop app |
| `make up-weather` | the weather service alone (`[weather] enabled = true`); `down-weather`, `restart-weather` after editing `[weather]` |
| `make up-agents` | ...and the AI agents |
| `make restart-agents` | just the two AI agents, without touching the stack (also starts them if down); `down-agents` stops them |
| `make client` | desktop + agents ONLY — for a machine whose data lives elsewhere |
| `make up-opensky` | the OpenSky gap filler alone (`[opensky] enabled = true`); `down-opensky`, `restart-opensky`, `opensky-status`, `opensky-credits` |
| `make receivers` | receivers in the database and where each one is (`receiver-history R=id`, `receiver ARGS=...` to edit) |

Keyed by the stack name: rendered configs, PIDs, logs, the DuckDB file, the
docker compose project, the desktop's own app-data directory
(`<app-data>/<stack>/`) and its Cargo target dir. **Ports are not** — they come
from each stack's config, where a person can see and choose them, and
`make doctor STACK=<name>` reports collisions. A stack whose `mqtt.host` is not
local starts no broker and `down` will not stop one.

Skills live in `skills/` and are symlinked into `.claude/` by `make skills`
(once per checkout). The `run-adsb-stack` skill covers this for agents.

## Transports

The stack's live path is **MQTT**, not Pulsar: `adsb-pulsar-client` publishes raw
SBS-1 to a broker, and `adsb-data-server` and the desktop app subscribe. Pulsar
is an optional *extra* fan-out leg for the Spark/Delta pipeline
(`pulsar.enabled = true`), never a replacement — the crate name predates the
split. History travels separately, over Quack (DuckDB attached across HTTP).

A second topic rides the same bus. The weather service (`[weather]`, off by
default) publishes one **retained** snapshot to `adsb/<stage>/weather/grid`,
derived from the feed topic by the same rule in `render-config.py` and
`Config::weather_topic` — change both or neither. The desktop subscribes to it on
its live-feed connection, so weather needs `source_kind = mqtt`. Any client that
subscribes to it needs a packet limit above rumqttc's 10 KiB default, or the
retained message becomes a reconnect storm. See DESIGN.md → Weather Layer.

Beside the grid, the weather service publishes retained `status` and
`availability` (`online`, or `offline` as its last will), all three derived by
`WeatherTopics::from_grid_topic`, which both ends call. It takes enable/disable
over HTTP (`[weather] http_port`, loopback by default, no auth), documented by a
generated OpenAPI document at `/v1/openapi.json` with Swagger UI at `/swagger-ui/`. Commands never
write status: the desktop's *Fetch weather* switch sends `PUT /v1/enabled` and
waits for the status topic to confirm. `make weather-status | weather-enable |
weather-disable`. DESIGN.md → Control and status.

The desktop therefore has two independently configured planes: `source_kind`
(`socket` | `mqtt`) for live aircraft, and the storage mode (embedded | remote)
for history. Env wins every launch for the first, first launch only for the
second. Setting one and not the other gives a working DB History panel over an
empty map — see QUICKSTART.md topology 3.

**Receivers and their locations.** With `[mqtt] per_receiver_topic` a feed
publishes to `<topic>/<source_id>`; subscribers listen on both `<topic>` and
`<topic>/+`, and the recorder stores each line under the receiver whose topic it
came on (`<topic>` itself = the recorder's own id). `mqtt.topic` stays the *base*:
weather and every subscription derive from it, so do not append the id to it.
Each feed also publishes its position, retained, to `adsb/<stage>/receiver/<id>`.
Positions live in the database as dated periods (`receiver_locations`, SCD2):
the recorder adds its `[receiver]` at startup, `make receivers` /
`receiver-history` / `receiver ARGS=...` read and edit them. Feeds also publish
retained `online` / `offline` (last will) on `.../receiver/<id>/availability`;
the weather service uses it to fetch a grid around each active receiver, on
`adsb/<stage>/weather/grid/<id>` (its own grid stays on the shared topic too). Writes over Quack
must run server-side (`quack_query_by_name`): through the attached catalog only a
plain INSERT works. DESIGN.md → Receivers & Location History.

**OpenSky gap filling** (`[opensky]`, off by default) is a third service on the
bus: `adsb-opensky-server` polls OpenSky for what desktops ask (aircraft
the user *follows* -- explicitly, never by selecting -- once the receiver has
lost them, and drawn areas) and publishes each poll, **not
retained**, to `adsb/<stage>/opensky/states`, beside retained `status` and
`availability`. Topic rule `Config::opensky_topic` / `opensky_topic()` in
`render-config.py` — change both or neither. The watch list is a **lease**
(`PUT /v1/watch/{client_id}`, 60 s, renewed every 20 s), held in memory only;
the 24 h credit ledger is persisted (`state_path`). Credentials reach the
process as environment variables from a subshell in `stack.sh` — never in
`.run/opensky.toml`, argv or `--print-config`. What it fetches is recorded
(`[opensky] record`, on by default) in `opensky_states` / `opensky_tracks` only,
never in `positions`: each fetched track is published non-retained on
`<base>/opensky/tracks`, and the recorder and an embedded desktop store both
topics through `adsb_data_server::opensky`. They read them with
`with_aux_stream`, not `with_aux_topic`, whose latest-wins drops records. A
stored, settled past flight is served without spending credits. DESIGN.md →
OpenSky Gap Filling → Storage.

Design detail:
`rust/adsb-pulsar-client-desktop/docs/DESIGN.md` §27 (Message Sources & the MQTT
Broker). Pi deployment: `rust/docs/DEPLOYMENT.md`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- **`graph.json` must stay under GitHub's 100 MB file limit.** graphify's built-in skip list only matches `.next` and `target` by exact name. The variants `.next-dev`, `.next-bench` and `target-*` are excluded by `.graphifyignore`; add any new build or output dir there. Unexcluded, they were 97k of 108k nodes and made the push fail at 116 MB. `update` never evicts nodes from files it no longer indexes. So after widening the ignore list, prune `graph.json` by `source_file`, then run `graphify cluster-only .`. `--force` doesn't help here.
