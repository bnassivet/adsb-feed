## Repository Structure

### `infrastructure/`

Deployment and operational tooling for the supporting services:

| Path | Description |
|------|-------------|
| `docker-compose.yml` | Docker Compose stack for local Pulsar broker |
| `DockerCompose/pulsar/` | Pulsar consumer test scripts |
| `Grafana/dashboards/` | Pre-built Grafana dashboard definitions |
| `Spark/` | Dockerfile for Spark + Delta Lake experimentation |
| `kubernetes/` | Kubernetes manifest for production deployment |
| `prometheus/` | Prometheus scrape configuration |
| `pulsar/` | Pulsar setup scripts (standalone broker, topic config, monitoring) |

### `rust/`

Higher-performance and desktop components (Cargo workspace):

| Crate / Directory | Description |
|-------------------|-------------|
| `adsb-pulsar-client/` | Rust Pulsar client library + CLI binary (~5 MB, ~50k msg/s) |
| `adsb-data-engine/` | Shared SBS-1 parser, geo utilities, and DuckDB local storage |
| `adsb-pulsar-client-desktop/` | Tauri v2 desktop app (Rust backend + Next.js 16 / React 19 frontend) |
| `adsb-agent/` | AI agent layer (LangGraph ReAct loop, AG-UI chat, voice/audio models) — Python, not a Cargo member |
| `adsb-simulation-agent/` | A2A agent generating kinematically plausible simulated trajectories — Python, not a Cargo member |

See [`rust/README.md`](rust/README.md) for detailed setup, build commands, and crate documentation.

### Flight simulation

The desktop app can fly **simulated aircraft** described in plain language
("police helicopter circling the old port", "airliner on final into runway 27").

```
chat or Simulation panel
   └─ adsb-agent (:8000) ──A2A──► adsb-simulation-agent (:8300) ──► timed waypoints
                                                                       │
                                      desktop playback engine ◄────────┘
```

- **The LLM only classifies.** It returns a route-pattern enum plus four scalars;
  every coordinate is computed in Python. Any coordinates the model volunteers are
  discarded — which is what makes this reliable on a small local model, and why the
  feature degrades to seeded default plans when no LLM endpoint is reachable.
- **Flight dynamics are structural, not checked after the fact.** Patterns are
  enlarged per aircraft category to respect turn radius (`v/ω`), polyline corners are
  replaced by true circular arcs, and altitude profiles are derived from the time the
  route actually takes rather than clipped.
- **Playback is per aircraft** — start / pause / resume / stop plus a time scrubber,
  each with its own clock. The renderer is stateless (the trail is derived from the
  route, not accumulated), so the timeline can be dragged backwards.
- **Scenarios** save a named collection of trajectories with their waypoints verbatim,
  so they replay offline after a restart with no Python service running.
- Both Python services are **optional**: without them the app keeps live tracking, the
  built-in demo-flight layer, and saved scenarios.

Details: [`rust/adsb-simulation-agent/README.md`](rust/adsb-simulation-agent/README.md)
and the [desktop app README](rust/adsb-pulsar-client-desktop/README.md).

### `graphify-out/`

A navigable knowledge graph of this codebase produced by [graphify](https://github.com/safishamsi/graphify).

**Only the non-regeneratable sources are tracked** — `graph.json`, the semantic extraction
cache (`cache/semantic/`), `manifest.json` (the incremental-update baseline),
`.graphify_labels.json`, and `cost.json`. Everything that regenerates for free is **git-ignored**:
the AST cache (`cache/ast/`), the derived views (`graph.html`, `GRAPH_TREE.html`, `GRAPH_REPORT.md`),
per-session query `memory/`, and machine-local dotfiles.

**Regenerating the ignored files** (after cloning, or any time they are missing):

```bash
cd adsb-feed
# AST cache + graph.json + GRAPH_REPORT.md — re-parses changed code, no LLM/API cost
graphify update .
# Derived HTML views from the existing graph.json
graphify export html
```

`graphify update .` diffs against the tracked `manifest.json`, so it only re-extracts changed
files. To rebuild the semantic layer from scratch (requires an LLM backend — a cloud key or a
local endpoint such as Ollama/LM Studio via `OLLAMA_BASE_URL`), run the full pipeline with `/graphify .`.

