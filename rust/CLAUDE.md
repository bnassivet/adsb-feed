# CLAUDE.md - Rust Workspace

Cargo workspace containing the ADS-B feed client library, adsd-data-engine and Tauri desktop app.

## Workspace Members

| Crate | Path | Purpose |
|-------|------|---------|
| `adsb-pulsar-client` | `adsb-pulsar-client/` | Library + CLI for dump1090 → Pulsar forwarding |
| `adsb-pulsar-client-desktop-lib` | `adsb-pulsar-client-desktop/src-tauri/` | Tauri v2 desktop app backend |
| `adsb-data-engine` | `adsb-data-engine/` | Shared SBS-1 parser + DuckDB persistent storage for historical queries |

## Non-Cargo Component

| Component | Path | Purpose |
|-----------|------|---------|
| `adsb-agent` | `adsb-agent/` | Optional **Python** AI agent (LangGraph + FastAPI) providing AG-UI chat + voice for the desktop app. Built/run with `uv` (`uv sync --all-extras`, `uv run python -m adsb_agent`), **not** part of the Cargo workspace — `cargo` commands ignore it. Lives here as a sibling component (moved out of `adsb-pulsar-client-desktop/agent/`). Serves on **:8000**. |
| `adsb-simulation-agent` | `adsb-simulation-agent/` | Optional **Python** agent (LangGraph + Starlette) generating kinematically plausible simulated flight trajectories, exposed over the **A2A protocol** and called by `adsb-agent` as an A2A client. Built/run with `uv` (`uv sync --all-extras`, `uv run python -m adsb_simulation_agent`), **not** part of the Cargo workspace. Serves on **:8300**. See its `CLAUDE.md` for a2a-sdk v1.x gotchas. |

## AG-UI run lifecycle (adsb-agent)

`RUN_ERROR` is **terminal**: CopilotKit rejects anything after it with
*"Cannot send event type 'RUN_FINISHED': the run has already errored"*, which
masks the real failure behind a protocol error.

The agent fails in two different ways, and only one of them raises:

| Failure | Path | How `_produce` sees it |
|---------|------|------------------------|
| Exception escapes `stream_llm_response` | `except` clause in `main.py` | sets `errored` |
| `llm.py` / `graph.py` **yield** a `RunErrorEvent` | ordinary event in the stream | must be detected while forwarding |

The second is the common one — `run_graph_to_agui` deliberately reports failures
as an event so it can forward already-computed tool calls first (a stalled
narration turn must not discard a generated trajectory). `_produce` therefore
sets `errored` when it *sees* a `RUN_ERROR` event, not only when it catches an
exception. Covered by `tests/test_run_lifecycle.py`, including the
tool-call-then-error ordering.

### The `'id'` RUN_ERROR (MLflow gateway, not us)

A chat turn can die with a red box whose entire message is `'id'`. That is a
`KeyError('id')` **three components upstream**:

```
LM Studio streams a chunk with no `id`
  -> mlflow/gateway/providers/openai_compatible.py:114  `id=resp["id"]`  KeyError
  -> gateway relays it as an SSE `error` event
  -> openai SDK re-raises it as APIError('id')  (_streaming.py:205)
  -> run_graph_to_agui reports str(e) -> "'id'"
```

Confirmed from the container: `docker logs mlflow-server | grep -A20 "Error
during streaming response"`. Intermittent — 1 turn in 4 in the observed log, and
it only affects the **streaming** path, so `adsb-simulation-agent` (which uses
`ainvoke`) is immune.

Nothing to fix here; `describe_run_error()` now names the exception type and the
LLM endpoint and says the failure is upstream, so the next occurrence points at
the gateway instead of looking like a bug in this agent. Workarounds, if it
becomes annoying: point `ADSB_AGENT_LLM_BASE_URL` at LM Studio directly
(`http://localhost:1234/v1` — note the model must then be the **full** name
`google/gemma-4-12b-qat`; the bare name only resolves through the gateway), or
patch `resp["id"]` to `resp.get("id")` in the container.

**Debugging note:** the agent logs the full traceback via `logger.error(...,
exc_info=True)`, so run it with output redirected (`... 2>&1 | tee
/tmp/adsb-agent.log`). Two separate investigations stalled because it was only
on a tty.

## Testing

### TDD Workflow

All changes follow Test-Driven Development (Red → Green → Refactor). No code lands without a test.

### Run All Tests

```bash
# From this directory (adsb-feed/rust/)
cargo test --workspace                    # ~227 tests (unit + integration + doc-tests)
cargo clippy --workspace -- -D warnings   # Lint
cargo fmt --all --check             # Format check
```

### Run by Crate

```bash
cargo test -p adsb-pulsar-client              # Library: ~65 tests (unit + integration + doc)
cargo test -p adsb-pulsar-client-desktop-lib  # Tauri: ~19 tests (unit)
cargo test -p adsb-data-engine               # Data engine: ~113 tests (SBS parser + storage + import)
```

### Run Specific Tests

```bash
cargo test --workspace test_parse_msg3       # By test name substring
cargo test --workspace config::tests         # By module path
cargo test --workspace -- --nocapture        # Show stdout
```

### CI Gate

```bash
cargo test --workspace && cargo clippy --workspace -- -D warnings && cargo fmt --all --check
```

### Documentation

Save new feature development plan in adsb-pulsar-client-desktop/docs/plans before starting implementation.
Update Design documentation (DESIGN.md, DOCUMENTATION.md) before proposing to commit a new feature implementation.

## Build Notes

- `cli` feature (default-enabled on `adsb-pulsar-client`) gates `clap` dependency
- Tauri crate uses `default-features = false` to exclude clap
- `[profile.release]` settings must be in this workspace root `Cargo.toml`, not member crates
- `protoc` required at build time (Pulsar crate dependency)
- `adsb-data-engine` uses `duckdb` crate (DuckDB 1.2) via C FFI — no extra system packages needed beyond Rust toolchain; DuckDB is statically linked

## Continous improvement

Update CLAUDE.md with pertinent lessons learned especially from feature or issue implementation failures
