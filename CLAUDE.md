## Running the stack

`make` from this directory lists every target. `make up` starts the local
no-Pulsar stack (broker → data server → feed), `make verify` proves rows are
actually being recorded, `make down` stops it. `make doctor` is the preflight.

Configuration is `adsb-stack.toml` — gitignored, like a `.env`. Create it with
`make config` (copies `adsb-stack-template.toml`, never overwrites). It is
expanded into `.run/*.toml` by `make render`; never edit the rendered files.
A new setting belongs in the **template** as well, or it exists on one machine
only. See QUICKSTART.md for the three supported topologies.

Skills live in `skills/` and are symlinked into `.claude/` by `make skills`
(once per checkout). The `run-adsb-stack` skill covers this for agents.

## Transports

The stack's live path is **MQTT**, not Pulsar: `adsb-pulsar-client` publishes raw
SBS-1 to a broker, and `adsb-data-server` and the desktop app subscribe. Pulsar
is an optional *extra* fan-out leg for the Spark/Delta pipeline
(`pulsar.enabled = true`), never a replacement — the crate name predates the
split. History travels separately, over Quack (DuckDB attached across HTTP).

The desktop therefore has two independently configured planes: `source_kind`
(`socket` | `mqtt`) for live aircraft, and the storage mode (embedded | remote)
for history. Env wins every launch for the first, first launch only for the
second. Setting one and not the other gives a working DB History panel over an
empty map — see QUICKSTART.md topology 3.

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
