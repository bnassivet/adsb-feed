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

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
