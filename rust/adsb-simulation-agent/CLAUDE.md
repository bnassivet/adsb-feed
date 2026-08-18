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
| `models.py` | `RoutePlan`/`RouteLeg` (LLM-facing intent), `Waypoint`/`TrajectoryResponse` (geometry), `Violation` |
| `kinematics.py` | Per-category `KinematicProfile` table + geodesy (haversine, bearing, projection, turn radius) |
| `geometry.py` | Pattern synthesis: orbit, racetrack, transit, approach, maneuver → anchor track; leg anchoring and joining |
| `trajectory.py` | Per-leg corner rounding → resampling → phase/altitude/speed → timing |
| `validate.py` | Plausibility checks; drives the retry edge |
| `intent.py` | Free-text route hint → `RoutePlan` via a local LLM; coordinate extraction + anchor corroboration |
| `graph.py` | The LangGraph + `generate()` entry point |
| `agent_card.py` / `executor.py` / `server.py` | A2A protocol surface |
| `tracing.py` | MLflow spans + joining the caller's trace (see below) |

## The design rule that matters most

**The LLM classifies; Python computes.** `intent.py` asks the model only for a
`RoutePattern` enum plus a handful of scalars per leg. All geometry is
synthesized deterministically. This is what makes the feature reliable on a 7B
local model.

Coordinates are the single exception, and a narrow one. The model may *copy* a
latitude/longitude the user wrote, in order to say **which leg** it belongs to —
but `extract_coordinates()` reads the user's raw hint independently, and
`corroborate_anchors()` **discards any anchor it cannot match** against what was
actually written (0.02° ≈ 1 NM, enough to forgive rounding). So the model
chooses the assignment; the user's own text remains the only source of the
values. A hallucinated position never reaches geometry.

Place names are *not* resolved — no gazetteer, no geocoder. "Above Île d'Yeu"
with no numbers simply leaves the leg unanchored, continuing from wherever the
previous one ended.

## Multi-leg routes

A `RoutePlan` is a **list of `RouteLeg`s** flown in order by one aircraft, joined
into a single continuous track. Constructing a plan with the old flat scalars
(`RoutePlan(pattern=..., radius_nm=...)`) still works and means one leg, which is
what the desktop panel form and `default_plan_for()` produce.

Per leg: `pattern`, `radius_nm`, `bearing_deg`, `altitude_ft`, an
`altitude_min_ft`/`altitude_max_ft` oscillation band, `turn_count`, a
`speed_bias` (slow/normal/fast, always *within* the category envelope), and an
optional `anchor_lat`/`anchor_lng`.

Three things change once a leg can be pinned to a point:

1. **An anchored transit/approach is a route *to* that point**, not a line
   centred on it — the pattern library otherwise has no A-to-B primitive, which
   is why "coming from A ... then going towards C" was previously inexpressible.
2. **Legs are joined, not concatenated.** A pattern anchored away from the
   hand-over point gets a straight connector plus a `_line_up()` alignment
   segment, and an orbit is entered **tangentially** (`tangential_entry_angle()`)
   — a straight-in leg striking a circle side-on leaves a corner the pattern's
   own radius cannot absorb.
3. **`radius_nm` stops being a lever for that leg.** Its geometry belongs to the
   user's coordinates, so `correct_plan()` slows an anchored leg down instead
   (turn radius is `v/omega`).

Every waypoint carries a `leg_index`, which is what lets a `Violation` name the
leg that caused it — corrections are applied per leg, not to the whole route —
and lets the desktop map draw each leg as its own polyline.

### Two rounding traps, both found by the validator

- **The join point appears in both legs.** Left duplicated, the corner has a
  zero-length inbound leg, its tangent clamps to zero, and `round_corners` skips
  it entirely — emitting a sharp, unflyable turn at *every* leg boundary.
  Anchors are deduped before rounding.
- **A 180° reversal cannot be rounded in place at all.** The fly-by tangent is
  `R * tan(theta/2)`, which diverges — so the corner comes out *sharper* the
  closer it is to a true reversal. `_split_reversals()` inserts a point `2R`
  abeam, making it a procedure turn.

Formation members (`count > 1`) must offset a shared anchor **consistently**:
offsetting each leg's copy independently pulls one leg's end away from the
next's centre, leaving a stub connector and the same too-tight corner.

## Flight dynamics (DC3)

Three constraints are enforced structurally rather than checked after the fact:

1. **Turn rate implies a minimum pattern size.** A 3°/s limit at 450 kts means an
   airliner cannot turn inside ~2.4 NM. `feasible_leg_radius_nm()` enlarges
   patterns per category before geometry is built — so a requested radius is a
   *request*, not a guarantee. It adds `TURN_FEASIBILITY_MARGIN` on top: a
   pattern sized to *exactly* the minimum turns at exactly the sustained limit
   for its whole length, leaving nothing for the 8-second sampling grid.
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

### Knobs for a constrained or reasoning-heavy model

Prompt tokens and answer tokens share one `MAX_TOKENS` budget, so a long prompt
on a model that reasons can leave nothing to answer with — the reply comes back
empty with `finish_reason='length'`, which looks exactly like a model ignoring
the prompt.

| Var | Values | What it does |
|-----|--------|--------------|
| `PROMPT_STYLE` | `full` (default), `compact` | `compact` is 45% the size: same schema, no teaching. An unknown value warns and falls back to `full`. |
| `REASONING_EFFORT` | `off`/`none`/`on`, or `minimal`…`high` | Sent only when set. Native `ChatOpenAI` field. On a **toggle-style** model only `none` does anything — the off synonyms all map to it, and `on` sends nothing. |
| `REASONING_MAX_TOKENS` | int | Sent as `extra_body: {reasoning: {max_tokens: N}}`. |

Both reasoning knobs are **requests, not guarantees** — support varies by
provider, and an endpoint that doesn't understand them ignores them. Measured on
`gemma-4-12b-qat` (a reasoning variant): the full prompt spent its *entire*
budget thinking and returned nothing at 512/1024/2048/8192 tokens, while
`PROMPT_STYLE=compact` classified the three-leg Île d'Yeu request correctly.
Prompt size was the binding constraint, not the token budget.

**Reasoning is a toggle on this model, not a dial** — and turning it off is the
single biggest win available. Measured on the compact prompt:

| control | time | completion tokens |
|---------|------|-------------------|
| reasoning on (default) | 23 s | 1083 |
| **`reasoning_effort=none`** | **4 s** | **162** |
| `reasoning={enabled:false}` | 22 s | ignored |
| `chat_template_kwargs={enable_thinking:false}` | 23 s | ignored |

Same answer in every case. `minimal`/`low` are likewise accepted and ignored, so
the graded values are worthless here — which is why `_REASONING_OFF` maps
`off`/`false`/`no`/`disabled`/`none` onto the one value that works, and `on`
sends nothing (already the default). End to end this took the three-leg Île
d'Yeu request from **172 s to 5 s**, and let `LLM_TIMEOUT_S` drop 180 → 45 and
the caller's budget 380 → 120.

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

## Timeout budgets (the invariant that broke)

The caller must allow **more** time than the callee can take. It did not, and
the symptom pointed at the wrong thing entirely:

| Knob | Where | Was | Effect |
|------|-------|-----|--------|
| `simulation_agent_timeout` | `adsb-agent` | 60 s | caller gives up |
| `llm_timeout_s` | here | 300 s | one classification attempt |
| `ChatOpenAI(max_retries=...)` | here | **2 (default)** | ×3 attempts → 900 s worst case |

So the callee was entitled to spend 15× the caller's budget, and `httpx`
reported the resulting `ReadTimeout` — whose `str()` is **empty** — as
"could not reach the simulation agent at http://127.0.0.1:8300 (). Is it
running?" while the agent was up and answering. Fixed on both sides:
`max_retries=0` here (the only retry worth making is `parse_route_hint`'s, with
a *bigger* budget), and a distinct timeout branch in `a2a_client.py` that names
the budget and never says "is it running".

**`RETRY_MAX_TOKENS` is a floor, not the budget.** `max_tokens` is configurable,
so a deployment setting it to 8192 made the "retry with a larger budget" ask for
4096 — half the room for a problem that had already proved too big. Use
`retry_token_budget()`.

**A reasoning model cannot do this job.** `gemma-4-12b-qat:2` returns
`finish_reason='length'` with empty content and `reasoning_tokens` equal to the
entire budget — measured at 512, 1024, 2048 and 8192 tokens, it thinks until it
runs out and never writes an answer. Raising `max_tokens` only makes it slower.
`_reasoning_exhaustion_note()` says so in the log when the provider reports the
detail. Pick a non-reasoning model (or a lower reasoning effort) for
`ADSB_SIM_AGENT_MODEL`.

## Testing

TDD is mandatory (Red → Green → Refactor), per repo convention.

```bash
uv run pytest                       # ~563 tests
uv run pytest tests/test_trajectory.py -q
uv run ruff check . && uv run ruff format --check .
```

| Test file | Covers |
|-----------|--------|
| `test_kinematics.py` | Profile sanity, geodesy round-trips, turn-radius formula |
| `test_geometry.py` | Each pattern's geometric contract; leg anchoring, continuity, tangential entry |
| `test_trajectory.py` | Corner rounding, phases, **turn/climb-rate limits**, timing-from-geometry |
| `test_validate.py` | Violation detection; leg attribution; **generator output validates clean** for all 20 pattern×category combos *and* for realistic multi-leg routes |
| `test_models.py` | The intent schema, and the flat-scalars-mean-one-leg contract |
| `test_intent.py` | Messy-LLM-output robustness (fences, prose, quoted numbers, bad enums); coordinate extraction and **anchor corroboration** |
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
