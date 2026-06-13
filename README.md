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
| `adsb-pulsar-client-desktop/` | Tauri v2 desktop app (Rust backend + Next.js 15 frontend) |
| `adsb-agent/` | AI agent layer (LangGraph ReAct loop, voice/audio models) |

See [`rust/README.md`](rust/README.md) for detailed setup, build commands, and crate documentation.

### `graphify-out/`

A navigable knowledge graph of this codebase produced by [graphify](https://github.com/safishamsi/graphify)
(`GRAPH_REPORT.md`, `graph.json`, `graph.html`). The committed outputs and the semantic extraction
cache (`cache/semantic/`) are tracked. The **AST cache (`cache/ast/`) is git-ignored** — it is large,
churns on every code edit, and regenerates deterministically for free.

**Regenerating the AST cache** (after cloning, or any time it is missing):

```bash
cd adsb-feed
# AST-only refresh — re-parses changed code, repopulates cache/ast/, no LLM/API cost
graphify update .
```

This rebuilds `cache/ast/`, `graph.json`, and `GRAPH_REPORT.md` from the current source.
To rebuild the semantic layer as well (requires an LLM backend — cloud key or a local
endpoint such as Ollama/LM Studio via `OLLAMA_BASE_URL`), run the full pipeline with `/graphify .`.

