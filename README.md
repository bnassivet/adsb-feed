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

