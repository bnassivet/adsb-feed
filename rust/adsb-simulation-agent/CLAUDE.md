# CLAUDE.md - ADS-B Simulation Agent (Python / A2A)

Standalone Python service that generates kinematically plausible simulated
aircraft trajectories for the desktop tracker's demo mode. Exposed over the
**A2A protocol**; consumed by `adsb-agent` acting as an A2A client.

Not part of the Cargo workspace — `cargo` commands ignore it. Built and run
with `uv`, like its sibling `adsb-agent/`.

## Why this exists

The desktop app's original demo flights (`simulation-data.ts`) are 20 hardcoded
routes with static altitude/speed and looping linear interpolation. This service
generates routes on demand from natural language, with speeds and altitudes
derived from actual flight-dynamics limits rather than decoration.

## Architecture

```
adsb-agent (LangGraph)  --A2A JSON-RPC-->  adsb-simulation-agent  :8300
                                                   |
                                    parse_intent (LLM classify only)
                                                   v
                                    plan_route -> apply_kinematics -> validate
                                                   ^                     |
                                                   +---(violations)------+
```

| Module | Role |
|--------|------|
| `models.py` | `RoutePlan` (LLM-facing intent), `Waypoint`/`TrajectoryResponse` (geometry), `Violation` |
| `kinematics.py` | Per-category `KinematicProfile` table + geodesy (haversine, bearing, projection, turn radius) |
| `geometry.py` | Pattern synthesis: orbit, racetrack, transit, approach, maneuver → anchor track |
| `trajectory.py` | Corner rounding → resampling → phase/altitude/speed → timing |
| `validate.py` | Plausibility checks; drives the retry edge |
| `intent.py` | Free-text route hint → `RoutePlan` via a local LLM |
| `graph.py` | The LangGraph + `generate()` entry point |
| `agent_card.py` / `executor.py` / `server.py` | A2A protocol surface |
| `tracing.py` | MLflow spans + joining the caller's trace (see below) |

## The design rule that matters most

**The LLM classifies; Python computes.** `intent.py` asks the model only for a
`RoutePattern` enum plus four scalars. It is *never* asked for coordinates, and
any it volunteers are discarded. All geometry is synthesized deterministically.
This is what makes the feature reliable on a 7B local model.

## Flight dynamics (DC3)

Three constraints are enforced structurally rather than checked after the fact:

1. **Turn rate implies a minimum pattern size.** A 3°/s limit at 450 kts means an
   airliner cannot turn inside ~2.4 NM. `feasible_radius_nm()` enlarges patterns
   per category before geometry is built — so a requested radius is a *request*,
   not a guarantee.
2. **Corner rounding enforces the turn rate.** `round_corners()` replaces polyline
   vertices with true circular arcs of radius `v/ω`; flying them at `v` yields
   exactly `ω`. This is why generated output validates clean and the retry edge
   rarely fires.
3. **Altitude comes from available time.** Descending 5000 ft at 700 fpm needs
   ~7 min; a 6 NM final at 100 kts lasts ~4. `_working_altitude()` caps altitude
   to what the route affords; an explicitly requested altitude instead *stretches
   the route* (up to `MAX_ROUTE_STRETCH`, 12×).

## a2a-sdk v1.x gotchas

The SDK changed substantially at 1.0. Pre-1.0 examples found online **will not
work**:

- `A2AStarletteApplication` / `A2AFastApiApplication` were **removed**. Use the
  route factories: `create_agent_card_routes()` + `create_jsonrpc_routes()`
  composed into a plain Starlette app.
- Types are **Protobuf**, not Pydantic — no arbitrary attribute assignment,
  enums are `TaskState.TASK_STATE_COMPLETED` style, `TextPart`/`DataPart` are
  gone (use `Part(text=...)` / `a2a.helpers.new_data_part()`).
- `AgentCard.url` was replaced by `supported_interfaces=[AgentInterface(...)]`.
- `DefaultRequestHandler` now **requires** `agent_card`.
- The well-known path is `/.well-known/agent-card.json` (was `agent.json`).
- JSON-RPC method names are gRPC-style PascalCase: **`SendMessage`**, not
  `message/send` (the old names need `enable_v0_3_compat=True`).
- **Clients must send the `A2A-Version: 1.0` header.** Omitting it means "0.3"
  and the server rejects the call with `VERSION_NOT_SUPPORTED`. This is the most
  likely integration failure for a client written from older examples.
- Executors must enqueue a **Task first**, then update events. Mixing Message
  and Task events raises `InvalidAgentResponseError`.

Response shape is `result.task`, with the trajectory in
`task.artifacts[0].parts[0].data`.

## Setup and run

```bash
cd adsb-feed/rust/adsb-simulation-agent
uv sync --all-extras
uv run python -m adsb_simulation_agent      # serves on :8300
```

Configuration is via `ADSB_SIM_AGENT_`-prefixed env vars (see `config.py`):
`PORT`, `LLM_BASE_URL`, `MODEL`, `MAX_RETRIES`, …

**LM Studio is optional.** Without it, route hints are ignored and seeded default
plans are used. A dead LLM degrades the feature; it never breaks a request.

## Tracing (MLflow)

Instrumented into the **same MLflow experiment as `adsb-agent`** (`adsb-agent`,
tracking server `:5010`), and linked so a chat turn that generates trajectories
is **one trace**, not two:

```
chat_turn (adsb-agent)
└─ tool.generateSimulatedTrajectory
   └─ simulate_trajectory (AGENT)          <- this service
      ├─ parse_intent (PARSER) └─ Completions (LLM, via autolog)
      ├─ plan_route (CHAIN)
      ├─ apply_kinematics (CHAIN)
      └─ validate (CHAIN)                   <- repeats when the retry edge fires
```

How the link works — MLflow follows **W3C TraceContext**, so it is header
propagation and nothing more:

| Side | API | Where |
|------|-----|-------|
| caller | `get_tracing_context_headers_for_http_request()` | `adsb-agent/a2a_client.py`, merged with `A2A-Version` |
| callee | `set_tracing_context_from_http_request_headers(headers)` | `TracingContextMiddleware` in `server.py` |

Middleware works because `DefaultRequestHandler` starts the executor with
`asyncio.create_task` *during* request handling — a task copies the context at
creation, so the trace context reaches the executor without being threaded
through a2a-sdk.

### The MLflow trap that cost the outermost span

`set_tracing_context_from_http_request_headers` registers a placeholder trace on
entry and calls **`pop_trace` in its `finally`**. The OTel batch processor
exports asynchronously, so any span still queued when the scope closes can no
longer be resolved to a trace — and the exporter **drops it silently**.

That always cost exactly `simulate_trajectory`: it ends last, so it was always
the one still queued, leaving every child span orphaned under a parent id that
was never persisted. MLflow's own documented client/server example has the same
gap (reproduced cross-process: it lost *both* server spans).

Hence `flush_spans()` inside `tracing_scope`, before the scope exits. It is
correctness, not tuning — `test_tracing.py::TestSpanFlushing` pins the ordering.

Two related requirements, both learned the same way:

- **`boto3` is a runtime dependency**, and `MLFLOW_S3_ENDPOINT_URL` +
  `AWS_*` must match `adsb-agent/.env`. Without them trace export fails on
  artifact upload.
- Debugging this needs `logging.getLogger("mlflow").setLevel(DEBUG)`; the drop
  path itself logs nothing at all.

Rules worth keeping:

- **`update_current_trace` is trace-scoped, not span-scoped.** When linked there
  is one trace, shared with the caller — tagging it here would overwrite the
  chat turn's `session_id`. Hence `tag_root_trace()`, which is a no-op whenever
  `is_linked()`. Per-request detail goes on **span attributes**.
- **`parse_intent` is a `PARSER` span, not `LLM`.** OpenAI autolog emits the real
  `LLM` span inside it; typing the wrapper `LLM` too would double-count.
- **`mlflow.openai.autolog()`, never `mlflow.langchain.autolog()`** — same reason
  as `adsb-agent`: LangChain's callback span tree doesn't interleave with
  MLflow's fluent tree, producing detached and duplicated spans.
- **Waypoints never become span I/O.** Summary and counts only, for the same
  reason they never enter the caller's LLM context.
- Every mlflow import is lazy and every failure degrades to a no-op. Disable with
  `ADSB_SIM_AGENT_MLFLOW_ENABLED=false`; the service is unaffected.

## Testing

TDD is mandatory (Red → Green → Refactor), per repo convention.

```bash
uv run pytest                       # ~409 tests
uv run pytest tests/test_trajectory.py -q
uv run ruff check . && uv run ruff format --check .
```

| Test file | Covers |
|-----------|--------|
| `test_kinematics.py` | Profile sanity, geodesy round-trips, turn-radius formula |
| `test_geometry.py` | Each pattern's geometric contract |
| `test_trajectory.py` | Corner rounding, phases, **turn/climb-rate limits**, timing-from-geometry |
| `test_validate.py` | Violation detection; **generator output validates clean** for all 20 pattern×category combos |
| `test_intent.py` | Messy-LLM-output robustness (fences, prose, quoted numbers, bad enums) |
| `test_graph.py` | Node wiring, retry edge, budget cap, graceful degradation |
| `test_agent_card.py` / `test_executor.py` / `test_server_integration.py` | A2A protocol surface |

### CI gate

```bash
uv run pytest && uv run ruff check . && uv run ruff format --check .
```

## Gotchas

- **`uvicorn` is a runtime dep**, needed by `__main__.py` — easy to miss since
  tests use `httpx.ASGITransport` and never bind a port.
- Angle assertions must compare *angular* difference — bearing 0 comes back as
  359.9999, which is angularly correct but numerically far from 0.
- A 2-lap helicopter orbit is ~240 waypoints. Callers must use
  `TrajectoryResponse.summary()` for anything that enters an LLM's context; the
  full payload is for the frontend only.
