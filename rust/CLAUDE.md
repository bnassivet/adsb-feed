# CLAUDE.md - Rust Workspace

Cargo workspace containing the ADS-B feed client library, adsd-data-engine and Tauri desktop app.

## Workspace Members

| Crate | Path | Purpose |
|-------|------|---------|
| `adsb-pulsar-client` | `adsb-pulsar-client/` | Library + CLI for dump1090 → Pulsar forwarding. Also the home of the shared Prometheus exporter (`metrics_export`, the `adsb_build_info` identity series and the gauge/counter helpers every service uses) and, behind the `metrics` feature, a hand-rolled `/metrics` listener on `[metrics] feed_port`. Hand-rolled rather than axum because this is the binary whose size is a design constraint; **the edge targets in `Makefile` build `--no-default-features`, so they name `metrics` explicitly or the Pi has no endpoint** |
| `adsb-pulsar-client-desktop-lib` | `adsb-pulsar-client-desktop/src-tauri/` | Tauri v2 desktop app backend |
| `adsb-data-engine` | `adsb-data-engine/` | Shared SBS-1 parser, ingest pipeline, and DuckDB persistent storage for historical queries |
| `adsb-data-server` | `adsb-data-server/` | Headless recorder: MQTT ingest → DuckDB, Quack sharing, read-only HTTP query API. Also the home of `tool_service`/`server` (moved out of the Tauri crate) so desktop, agent and daemon answer queries identically. The `metrics` feature adds `/metrics` to the *daemon's* listener only, via `router_with_metrics`/`serve_with_metrics`: `router`/`serve` stay unchanged because the desktop embeds them and is deliberately not a scrape target. Storage statistics are cached and refreshed every 15 s, never queried per scrape — `get_stats` contends with the ingest lock |
| `adsb-weather-server` | `adsb-weather-server/` | Weather service: Open-Meteo winds aloft + MSL pressure on a receiver-centred grid, published as one **retained** MQTT message and republished on every ConnAck. `default-features = false` builds the payload and control-API contract types only (no reqwest/TLS); the desktop adds `features = ["client"]` for the control-API client, which does bring reqwest. `http-api` (part of `cli`) adds the axum control server and its generated OpenAPI document (`/v1/openapi.json`); `swagger-ui` (also in `cli`) serves Swagger UI at `/swagger-ui/` from **vendored** assets, so no build-time download. `openapi` alone adds only the utoipa schema derives on the contract types. `client` is a default feature so `cargo test --workspace` runs the `control_api` and `openapi` integration tests instead of silently skipping them. The `service` feature pulls reqwest with rustls/aws-lc-rs, which compiles C, so expect a slower arm64 build. `metrics` (also in `cli`) adds `/metrics` on the same listener as the control API, merged *outside* `documented_routes()` so it never enters the OpenAPI document, and needs no direct `prometheus` dependency — the projection is written against the shared exporter helpers. See `DESIGN.md` → Weather Layer |
| `adsb-opensky-server` | `adsb-opensky-server/` | OpenSky gap filler: polls OpenSky `/states/all` for the union of client watch leases (selected icao24s + areas) within the account's daily credit budget — the interval is computed (`budget::next_interval`), never configured, because a fixed 10 s poll is 8,640 credits/day against a registered user's 4,000. The allowance is configured (`feeder`, true by default → 8,000; `daily_credits` overrides), because OpenSky's replies say only what is left (`X-Rate-Limit-Remaining`, served in `/v1/credits`), never the allowance. OAuth2 client credentials only (Basic auth is gone at OpenSky); token cached, a 401 refreshed and retried once. Publishes polls **non-retained** on `<base>/opensky/states`, each fetched track **non-retained** on `<base>/opensky/tracks` (for recorders), retained status/availability. `adsb-data-server` (and an embedded desktop) record both into `opensky_states` / `opensky_tracks`, never `positions`. Features mirror the weather server (`client` for the desktop, `cli` for the binary). The rolling 24 h credit ledger (`credits.rs`, 5-min slots) is persisted; the watch list deliberately is not. See `DESIGN.md` → OpenSky Gap Filling |

## Non-Cargo Component

| Component | Path | Purpose |
|-----------|------|---------|
| `adsb-agent` | `adsb-agent/` | Optional **Python** AI agent (LangGraph + FastAPI) providing AG-UI chat + voice for the desktop app. Built/run with `uv` (`uv sync --all-extras`, `uv run python -m adsb_agent`), **not** part of the Cargo workspace — `cargo` commands ignore it. Lives here as a sibling component (moved out of `adsb-pulsar-client-desktop/agent/`). Serves on **:8000**, including `/metrics` (`include_in_schema=False`, and skipped by `RequestLoggingMiddleware` — unskipped, a 15 s scrape would write the whole exposition into the log forever). |
| `adsb-simulation-agent` | `adsb-simulation-agent/` | Optional **Python** agent (LangGraph + Starlette) generating kinematically plausible simulated flight trajectories, exposed over the **A2A protocol** and called by `adsb-agent` as an A2A client. Built/run with `uv` (`uv sync --all-extras`, `uv run python -m adsb_simulation_agent`), **not** part of the Cargo workspace. Serves on **:8300**. Serves `/metrics` beside `/health`. See its `CLAUDE.md` for a2a-sdk v1.x gotchas. |

## AG-UI tool ownership (adsb-agent)

**Backend tools belong to the agent**: `adsb-agent/src/adsb_agent/server_tools.py`
(`SERVER_TOOLS`, with `SERVER_TOOL_NAMES` derived from it).

- The agent always binds them through `effective_tools()`.
- `/info` advertises them as `capabilities.tools.items`, with `clientProvided: true`.
- The desktop must **not** register them as frontend tools. AG-UI reserves
  `RunAgentInput.tools` for client tools, and `useCopilotTools.test.ts` pins this.
- They are **shown** in the chat, not executed there. `run_graph_to_agui` streams each
  server call as `TOOL_CALL_START/ARGS/END` + `TOOL_CALL_RESULT`, and CopilotKit skips
  executing any call that already has a result (`processAgentResult`). The desktop draws
  them with `useRenderTool` (five cards, plus a `"*"` chip for the rest), never
  `useFrontendTool`.
- **Only `agent`-node chunks are text.** `stream_mode="messages"` emits every node's
  messages; forwarding them all streamed each server tool's raw JSON into the reply.
  Each agent turn is its own assistant message.
- **Display-only:** `convert_agui_messages_to_lc` drops server calls and their results
  from inbound history, so the LLM never sees earlier ones (follow-ups re-query).
- Tool-call ids are fixed in `agent_node`, right after the model returns.
  `tool_call_id()` mints a new id per call, so resolving it in two places gave the call
  and its result different ids.

A schema there must match its Rust query type in `adsb-data-engine/src/types.rs`.
Serde rejects a missing non-`Option` field ("Invalid arguments: missing field")
rather than defaulting it.

Client tools still travel on every run. That is the protocol's design, not an
inefficiency to optimise away. A "register once, send a digest" scheme was rejected
as a private extension (see `docs/plans/2026-11-10-agent-owned-backend-tools.md`).

CopilotKit is on **1.85** (upgraded from 1.55.3). Thread binding changed:

- `CopilotChat` uses the **shared** registry agent and writes
  `agent.threadId = threadId` onto it. Anything that must act on the chat's
  conversation (voice auto-send in `AIChatContent.tsx`) calls
  `useAgent({ agentId: AGENT_ID })` with **no** `threadId`.
- `useAgent({ agentId, threadId })` **throws** without `runtimeAgentId`. With
  one, it registers a separate proxy agent, which is a different conversation
  from the chat's. `AIChatContent.threadId.test.tsx` pins this.
- On 1.55, `useAgent({ threadId })` ran on an unregistered per-thread clone, so
  the dev inspector (AG-UI Events / Agent tabs) never saw any event. On 1.85
  the run is on the registry agent, which is the one the inspector subscribes to.
- 1.85's `CopilotChat` calls AG-UI **`connect`** on an explicit `threadId`
  before the first run: `POST /ag-ui/agent/{id}/connect`, or `agent/connect` on
  the single endpoint. A 404 there aborts the chat with *"Could not load saved
  conversation"*. The agent stores no threads, so it answers with an **empty SSE
  stream**, which the protocol reads as "no history" (`test_connect.py`). Never
  return JSON there; the single endpoint used to return the `/info` payload.
- The dev inspector is CopilotKit's only third-party traffic: `cdn.copilotkit.ai`
  feeds, Google Fonts and Loom videos, in dev builds on localhost only.
  `NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR=true` turns it off; default unset
  means on (`src/lib/copilotkit-inspector.ts`). Stack setting:
  `[desktop] copilotkit_inspector = false`, exported only when false so a
  `.env.local` value still applies at the default.
- The chat hides 1.85's per-message "View in Inspector" wrench with
  `CopilotChat inspectorTools={false}`. A provider-level `enableInspector` takes
  priority over it (`providerEnableInspector ?? inspectorTools`), so the provider
  only ever passes `false` or nothing, **never `true`**, or the wrench comes back.
  The wrench also forced a toolbar with a dead copy button under messages that only
  carry a tool card. CopilotKit's Segment telemetry
  lives in `@copilotkit/runtime` (Node), which this app does not use.
- 1.85 lists `maplibre-gl@^5` as an optional peer, and the app pins 6.x for the
  map bench. The `overrides` entry in `package.json` points CopilotKit at the
  app's copy. Remove it once CopilotKit accepts 6.x.
- Without a licence key, `checkFeature("chat")` is true, so there is no
  warning. `selfManagedAgents` still logs an *Enterprise Intelligence tier*
  licence warning, so don't use it.
- `ProxiedCopilotRuntimeAgent.clone()` drops AG-UI middlewares, so attach any
  middleware to the instance that actually runs.

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
cargo test -p adsb-data-engine               # Data engine: ~126 tests (SBS parser + ingest + storage + import)
cargo test -p adsb-data-server               # Data server: ~32 tests (recorder + config layering + tool API)
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

## Edge builds (Raspberry Pi)

See `docs/DEPLOYMENT.md`. The short version:

- On **Apple Silicon this is not a cross-compile** — host `arm64` and Pi
  `aarch64` are the same architecture, so `--platform linux/arm64` builds
  natively under Docker's VM. `make feed-arm64` / `make server-arm64`.
- **`cross` does not work here**: its images are x86_64 and `rust-toolchain.toml`
  pins 1.92, so it tries to install a non-host toolchain and rustup refuses.
- **Cap build parallelism, twice over.** `codegen-units = 1` means each parallel
  rustc holds a whole crate's codegen. `JOBS = 4` for the feed client; the data
  server needs `SERVER_JOBS = 2` because DuckDB's unity-build C++ units each take
  GBs in cc1plus, and cc-rs reports the OOM kill as a bare `exit status: 1` that
  reads like a compile error. Measured: 2.1 MB / 19s (feed), 38 MB / 9m44s (server)
- **`MemoryMax` is not copyable between the two units**: 100M for the feed
  client, 512M for `adsb-data-server` (DuckDB wants >=125 MB per thread).

## Build Notes

- `cli` feature (default-enabled on `adsb-pulsar-client`) gates `clap` dependency
- Tauri crate uses `default-features = false` to exclude clap
- `[profile.release]` settings must be in this workspace root `Cargo.toml`, not member crates
- `adsb-data-server` is **aarch64/x86_64 only** (DuckDB has no 32-bit ARM support). `adsb-pulsar-client` has no such limit, which is why a mixed fleet runs the feed client everywhere and the recorder only on 64-bit nodes
- The Tauri crate now depends on `adsb-data-server` (`default-features = false`) for the shared query surface. `clap` still stays out; `rumqttc` does arrive transitively, which Phase 6's MQTT live source needs anyway
- `protoc` required at build time (Pulsar crate dependency). Building
  `adsb-pulsar-client` with `--no-default-features --features cli,mqtt` drops the `pulsar`
  crate and therefore the `protoc` requirement — the no-Pulsar edge deployment, and the
  easiest path when cross-compiling for a Raspberry Pi
- `mqtt` feature (default-enabled on `adsb-pulsar-client`) gates `rumqttc`, built with
  `default-features = false` so it does not pull a rustls TLS stack for what is a
  plain-text LAN hop
- `adsb-data-engine` uses the `duckdb` crate via C FFI — no extra system packages needed beyond the Rust toolchain; DuckDB is statically linked
- **The `duckdb` version is pinned exactly** (`=1.10505.0`, DuckDB v1.5.5). Not hygiene: the
  `quack` extension is *not* statically linked into the bundled build and is autoinstalled from
  `extensions.duckdb.org` at runtime, and extension binaries are keyed to the exact DuckDB build,
  so version drift invalidates the cached extension. The previous `"1.2"` was a caret requirement
  that had silently resolved to 1.4.4 and would have accepted the 1.105xx line on any `cargo update`.
- **`arrow` must track the major that `duckdb` depends on** (currently 58). `Statement::query_arrow`
  returns duckdb's own `RecordBatch`; a skew resolves *both* arrow versions into the lockfile and
  the types fail to unify — the giveaway is `expected RecordBatch, but it yields RecordBatch`.

## Continous improvement

Update CLAUDE.md with pertinent lessons learned especially from feature or issue implementation failures

## Tool ranking (adsb-agent, experimental, off by default)

`adsb-agent/src/adsb_agent/tool_ranker.py` asks the decision model `d1-omni-600m`
one yes/no question per tool and binds only the top-k, because tool schemas are
about three quarters of every prompt. `ADSB_AGENT_TOOL_RANKER_ENABLED`, fail-open.
Evaluation harness and versioned dataset: `adsb-agent/eval/` (see its README).

**Do not enable it yet.** Measured 2026-11-11 on `adsb-tool-selection-v1` (243
requests), share of requests with every needed tool selected:

| Wording (`eval/wordings.py`) | top-10 | top-15 | k for 95% |
|---|---|---|---|
| `baseline` (shipped) | 71% | 80% | 28 |
| `baseline-short` | 69% | 82% | 26 |
| `match` | 64% | 75% | 30 |
| `capability-short` | 54% | 72% | 30 |
| `capability` | 44% | 55% | 38 |

The bar is 95% at a k that still halves the schemas. Rewording moved the result
down, not up, and per-tool score calibration (mean-centring, z-scoring) made it
worse. Rarely used tools (scenario management, `setWeatherLayer`, `setFilters`) rank
worst when they are the answer; `searchLiveFlights` scores ~0.8 on everything.

Also unmeasured and possibly decisive: with the full list the LLM answered in ~2 s
in a 3-record check, against ~17 s in recorded traces, so the model server appears
to reuse a cached prompt prefix. A tool list that changes every turn would defeat
that. Compare latency, not only tokens (`eval/eval_agent_step.py`).

### Later results on the same dataset (2026-11-11 to 13)

Share of requests keeping every needed tool, unless stated:

| Selector | Result |
|---|---|
| Embedding (`embeddinggemma-300m`) of tool-family descriptions, top-4 of 10 families | **97%**, 54% of schemas removed, ~13 ms |
| Decision model, one `choice` over the 10 families, top-4 | 89%, ~320 ms |
| Decision model, one `choice` over the 39 tool names, top-15 | 91% |
| Decision model, yes/no per family, top-4 | 75% |
| Decision model classifying the request as UI action / simple question / multi-step (`eval_classify.py`, dataset v3: clock + one tool counts as simple) | 67% accuracy, best wording; 59–62% with generic wordings. Multi-step recall 32% at best |

- A `choice` question must fit in **512 tokens** (HTTP 500 "input is too large"); 39
  tools with descriptions do not. `mlflow.genai.evaluate` averages over the records
  whose prediction succeeded, so a failing subset silently flatters the mean.
- Stage B (one real LLM call, 60 requests): the embedding family selector kept tool
  choice at the full list's 87% with 46% fewer input tokens, but **no filtered run
  was faster** (13 s full vs 19 s per-tool top-10, measured unloaded). Cause not
  confirmed; a changing tool list defeating the prompt-prefix cache is the suspect.
- The classifier leans to "simple question". When it does say "UI action" it is
  right 92% of the time, but it finds only 52% of them.
- Tool families live in `adsb-agent/eval/groups.py`; nothing but the per-tool yes/no
  ranker is wired into the agent.

### Desktop fast path for direct UI commands (evaluated 2026-11-13, not built)

Idea: a gate sends direct UI commands to a small model on the desktop, which has
only the 15 browser-side UI tools (`eval/fastpath_agent/eval_route.py::DIRECT_TOOLS`) plus
`handOffToAgent`; everything else goes to the agent. Dataset v4 (`route` label).

- **Gate** (`eval_route.py`): the embedding margin (best direct tool minus best
  other tool), thresholds cross-fitted for 95% precision. Over 25 half/half splits:
  precision median 93% (worst 84%), recall median 53% (43-67%). A single split is
  noisy with 60 positives -- an early figure of 67% recall was a lucky one, and the
  split used to depend on server record order. The decision model: 17% recall.
- **Executor** (`eval_executor.py`, LM Studio direct, reasoning off; dataset v5,
  argument VALUES checked against `expected_calls` by `call_matching.py`):

  | | `gemma-4-e2b` | `lfm2.5-1.2b` |
  |---|---|---|
  | Direct commands done exactly right (of 60, ungated) | 55 | 29 |
  | Right tool, wrong arguments | 5 | 19 |
  | Agent requests it declined via hand-off (of 213, ungated) | 42 | 1 |
  | Pipeline with gate: done on desktop (of 60) | 30 | 18 |
  | Pipeline with gate: wrong actions (of 273) | 2 | 12 |
  | Latency (median) | 0.41 s | 0.25 s |

  A schema-only check had scored gemma 60/60 and lfm 48/60: a schema-valid call can
  still carry the wrong value (`setMapTheme(light)` for "night mode").

- **The small model cannot be its own gate.** Ungated, `gemma-4-e2b` acted on 73 of
  213 agent requests (e.g. `startFeed` for unrelated questions). The hand-off tool
  alone does not make the design safe; the independent gate does.
- **Treat "no tool call" as a hand-off.** Both models often answer in text when
  they should decline; forward those rather than showing them.
- `gemma-4-e2b` needs `reasoning_effort: "none"`, or it spends its whole token
  budget thinking and returns an empty reply.

- **Broader scope tried and rejected (2026-11-14, dataset v6, `--scope ui`)**: "UI
  action vs other" with a UI model holding all 25 browser-side action tools
  (scenario and event edits included). It is worse on both halves:
  - Gate: embedding margin 88% precision / 16% recall (decision model 86% / 6%),
    against 93% / 53% for the direct scope. The false positives are mostly
    *questions* about scenarios and events ("list my scenarios"), which sit next to
    the scenario and event tools.
  - Executor (`gemma-4-e2b`): picks the right tool for 21 of the 22 added scenario
    and event commands, but invents what it cannot know: `scenarioId: "active"`, a
    scenario's name passed as its id, `latitude: 0, longitude: 0`. Those records
    have no `expected_calls`, so the script scores them "done"; read them.
  - Ungated it acted on 87 of 191 agent requests, 48 of them plain questions.
  Scenario and event edits need ids and positions looked up first; they are not
  one-shot commands. Keep the fast path to the direct scope.

- **`apple_fm` (MLflow gateway endpoint, Apple's on-device model) as executor,
  2026-11-14, direct scope, 273 requests:**
  - It emits **no tool calls** (text only: "I will switch...", "Should I proceed?")
    and `tool_choice: required` fails with "An unsupported generation guide was
    used". It does honour `response_format` JSON schema, so
    `eval_executor.py --call-style json` asks for two constrained replies: pick the
    tool, then fill its arguments.
  - Requests must send `"stream": false` explicitly (else 502 from the gateway) and
    must not send `reasoning_effort` (400).
  - Ungated: 31 of 60 direct commands exactly right (23 wrong arguments), but it
    **declines 174 of 213 agent requests** (gemma-4-e2b: 42). 20 requests errored:
    10 timeouts and 10 "safety guardrails were triggered", the latter on harmless
    text such as "select aircraft 4CA7B2".
  - Behind the embedding gate: 23 done, 10 wrong actions (gemma-4-e2b: 30 and 2).
  - Its argument errors are mostly unrequested extras (`setEventFilter` with
    `timeRangeStartMs: 0`, extra layers on `setLayerVisibility`) and reading "show
    history" as a 4-hour history window. Median 0.88 s (two calls).
  So: a better judge of scope than gemma-4-e2b, a worse executor.

- **`lfm3-omni-2b` as executor (LM Studio, 2026-11-14, direct scope, 273 requests):**
  ungated 46 of 60 exactly right, 13 wrong arguments, 1 wrong tool, and it acted
  on 94 of 213 agent requests (worse than gemma-4-e2b's 73). Behind the gate:
  28 done, 5 wrong actions, median 0.31 s. Between `lfm2.5-1.2b` and
  `gemma-4-e2b`; gemma-4-e2b (30 done, 2 wrong, 0.41 s) stays the best executor.

- **`gemma-4-e4b` and `ministral-3-3b` as executors (same date, same 273 requests):**

  | | `gemma-4-e4b` | `ministral-3-3b` |
  |---|---|---|
  | Direct commands exactly right, ungated (of 60) | 54 | 48 |
  | Agent requests it acted on, ungated (of 213) | 34 | 46 |
  | With the gate: done / wrong actions | 31 / 1 | 24 / 10 |
  | Median latency | 0.64 s | 0.28 s |

  `gemma-4-e4b` is the most accurate and the best judge of scope among the tool-
  calling models, at 1.5x gemma-4-e2b's latency. `ministral-3-3b` often omits the
  argument (`toggleSidebar({})` for "hide the sidebar").
- **Mistral's chat template rejects two user messages in a row**: HTTP 500 from LM
  Studio ("While executing CallExpression at line 46") for all 83 records with
  history. Run it with `eval_executor.py --history-style alternate`. The first
  ministral run looked like a weak model; it was 83 rejected requests. The
  per-record file now keeps the error text.

### Rewritten direct-tool descriptions (2026-11-15, eval only, not in the desktop)

`adsb-agent/eval/fastpath_agent/fixtures/tool_overrides_v1.json`, applied over the tool surface
when `ADSB_EVAL_TOOL_OVERRIDES` names it (`common.py::tool_overrides`). Each of
the 15 direct tools now opens with "Display command:", lists the phrasings users
type, and says it "only changes the display".

| 273 requests, 60 direct commands | Original | Rewritten |
|---|---|---|
| Gate precision, median (worst of 25 splits) | 93% (84%) | 94% (89%) |
| Gate recall, median (range) | 53% (43-67%) | 80% (70-82%) |
| `gemma-4-e4b` pipeline: done / wrong actions | 31 / 1 | 42 / 4 |
| `gemma-4-e2b` pipeline: done / wrong actions | 30 / 2 | 40 / 6 |
| `gemma-4-e4b` ungated: exact / acted on agent requests | 54 / 34 | 58 / 22 |

- Written from failures in one half of the requests only (sha1 of the question,
  even = development). On the **held-out** half the gate gain holds (14 -> 20 of
  29 commands pass), but wrong actions rise from 1 to 4-5. A wider gate lets more
  of the executor's existing mistakes through; that is most of the increase.
- The "set ONLY the fields the user mentions" instructions overfit: they fixed
  unrequested extras in the development half and caused omissions in the other
  ("show the wind layer at FL100 with particles" lost `enabled: true`).
- The held-out half has now been read, so a second rewrite needs new requests to
  be validated honestly.
- **v2** (`tool_overrides_v2.json`): only `startFeed`/`stopFeed` reworded, because
  v1 had pushed "start the feed" under the gate threshold. Lead with the command
  itself ("Start the feed: ..."); a trailing "does not report whether the feed is
  running" pulled feed *questions* toward the tool and was removed. Result: the
  gate passes 48 of 60 commands (v1: 44); `gemma-4-e4b` 45 done / 5 wrong,
  `gemma-4-e2b` 44 done / 6 wrong. The gate threshold is refitted on every run,
  so rewording one tool moves which other requests pass.
- **Main agent's tool choice with v2** (stage B, `gemma-4-12b-qat`, all 273
  requests, `--context-placement user`, every request answered in both runs):

  | First tool call is a needed one | Original | v2 |
  |---|---|---|
  | All 273 | 235 (86.1%) | 233 (85.3%) |
  | 60 direct commands | 60 | 59 |
  | 204 requests needing other tools | 164 | 163 |
  | 9 needing no tool | 9 | 9 |
  | Input tokens, mean | 7,091 | 7,768 |
  | Latency, mean | 6.9 s | 7.2 s |

  10 requests change verdict, 4 for the better and 6 for the worse; that is
  within noise. Most of the 10 involve tools whose description did not change
  ("simulate 2 helicopters over the port" -> `getEventsOfInterest`), so they are
  the model reacting to a different prompt, not to a specific wording.
  The main agent already picks the right direct tool with the original
  descriptions, so the rewrite has nothing to gain there and costs ~680 tokens
  per turn. **Port them only together with a fast path**, which is where they
  help. Not measured: argument correctness of the main agent with v2.

### All executors and the decision model with the rewritten descriptions (2026-11-15)

Same 273 requests (60 direct commands), `tool_overrides_v2.json`, embedding gate
passing 48 of 60 commands. Executor behind the gate, done / wrong actions:

| Executor | Original | Rewritten | Rewritten + decision veto | Median latency |
|---|---|---|---|---|
| `ministral-3-3b` (`--history-style alternate`) | 24 / 10 | 46 / 6 | 40 / 2 | 0.29 s |
| `gemma-4-e4b` | 31 / 1 | 45 / 5 | 40 / 2 | 0.64 s |
| `gemma-4-e2b` | 30 / 2 | 44 / 6 | 38 / 4 | 0.41 s |
| `lfm3-omni-2b` | 28 / 5 | 38 / 13 | 33 / 9 | 0.30 s |
| `apple_fm` (`--call-style json`) | 23 / 10 | 32 / 16 | 27 / 15 | 1.08 s |
| `lfm2.5-1.2b` | 18 / 12 | 25 / 25 | 21 / 20 | 0.26 s |

- `ministral-3-3b` gains most: its failure was omitted arguments, which the
  "'...' -> arg=value" examples in the descriptions fix. Ungated it now declines
  176 of 213 agent requests (`gemma-4-e2b`: about a third).
- **Decision model `d1-omni-600m` reading the descriptions**
  (`eval/fastpath_agent/decision_gate.py`, `eval/fastpath_agent/eval_decision_gate.py`). One request, six
  independent `choice` questions, ~100 ms, ~970 input tokens: kind of message
  (display command / question / simulation / other), family of commands, and one
  tool choice per family with the tools' full descriptions (four tools fit the
  512-token question; fifteen do not).

  | Gate (95% precision target, median of 25 splits) | Precision | Recall |
  |---|---|---|
  | Old single question (`D1_WORDING`) | 87% | 17% |
  | New: P(display command) | 90% | 32% |
  | New: command x family x tool | 90% | 23% |
  | Embedding margin | 94% | 80% |
  | Embedding margin, then veto when P(display command) < 0.5 | 98% | 70% |

  - Alone it is still a weak gate, and the tool it names is right for only 32 of
    60 commands (with the original descriptions: 33). Long descriptions do not
    help a 600M model choose; the family summaries carry it.
  - **Its use is the veto.** It removes 4 of the embedding gate's 5 false
    positives ("show it on the map", "pan to the selected aircraft", a question
    about the theme) and costs 6 commands ("select aircraft 4CA7B2", "color the
    tracks by altitude"). The 0.5 is not fitted. 60 positives: one split's
    counts move by a few either way.
  - **`noul` is unreliable on this model; use `choice`.** "Is the message a
    question?" scored 0.00-0.30 on "what is the wind at FL350?", and a yes/no per
    tool ranked unrelated tools first. The same judgement as a `choice` between
    described options separated commands from questions almost perfectly.
  - Send the request as a plain string `state`; `{"inputs": {"question": ...}}`
    gave noisier answers. No "none of these" option (docs.typesafe.ai: it
    competes with the real options; ask a companion question instead).
  - Choice `confidence` is `(p_max - 1/n) / (1 - 1/n)`: a rescaled top
    probability, not a separate signal. Threshold the probability of the option
    you act on.

### Agent alone against the fast path (2026-11-15, `eval_fast_path_compare.py`)

Full record: `adsb-agent/eval/fastpath_agent/FAST_PATH_EXPERIMENT.md`. On the 60 direct
commands the agent alone carries out 57 exactly (3 wrong actions, median 3.83 s
to the tool call); the fast path with `ministral-3-3b`, embedding gate and
decision veto gives 58 / 2 with 42 handled on the desktop at a median 0.29 s,
and 0 wrong actions on the 213 agent requests (4 without the veto). **The fast
path buys time, not correctness.**

- **Stage B noise floor: two identical runs differ on the first tool for 10 of
  271 requests** (235 and 231 of 273). Do not read a difference of 4 as an effect.
- Judge the agent's reply to a direct command with `eval_executor.outcome`, the
  same rule as the executors, or the two columns are not comparable.

### Fast path built (2026-11-15): `adsb-agent/src/adsb_agent/fast_path.py`

On by default (`ADSB_AGENT_FAST_PATH_ENABLED`), veto on by default
(`ADSB_AGENT_FAST_PATH_VETO_ENABLED`). Runs at the top of
`llm.py::stream_llm_response`, before the tool ranker and the graph. Documented in
`adsb-agent/README.md` (Desktop fast path) and `.env.example`.

- **The closing run is recognised by the call id** (`fp-` prefix), not by server
  state: the desktop re-runs the agent with the tool result, and that run gets a
  fixed "Done." with no model call. A tool result carrying an error goes to the
  main agent instead.
- **Tests must not inherit the default.** `tests/conftest.py` turns the fast path
  off for every test; fast-path tests turn it on with their own `MockTransport`.
  Without that, every existing `stream_llm_response` test would call three model
  endpoints.
- **Embed the tool descriptions with their own, longer timeout.** The first run
  embeds ~40 descriptions in one request, possibly while the embedding model
  loads. Under the 2 s per-request gate timeout that batch timed out, nothing was
  cached, and every later run would retry and fail the same way.
- **The fixed threshold (0.0605) belongs to the embedding model and the packaged
  descriptions.** Refit with `eval/fastpath_agent/eval_fast_path_service.py --fit` after changing
  either. The margins are tight: negatives reach 0.08, a fifth of the commands
  sit under 0.06.
- The eval scripts import `DIRECT_TOOLS`, the hand-off tool, the executor prompt,
  `args_valid` and the veto question from `fast_path.py`. Change them there.
- `ruff format eval src` reformats a dozen unrelated files in this project. Format
  only the files you touched.

### Fast path on fresh requests (2026-11-15): the gate overfitted

`adsb-agent/eval/fastpath_agent/data/validation_labels.jsonl` (176 requests: 21 from traces,
155 authored blind; `ADSB_EVAL_LABELS=... --data labels`). Full record in
`FAST_PATH_EXPERIMENT.md` → Validation on fresh requests.

| Fixed threshold 0.0605, veto on | Main set | Fresh |
|---|---|---|
| Commands passing the embedding gate | 80% | 62% |
| Agent requests passing the embedding gate | 0.5% | 20% |
| Margin AUC | 0.99 | 0.80 |
| Agent requests answered with an action | 0 of 213 | 7 of 95 |

- What passes is **questions and remarks about what a direct tool controls**
  ("which mode am I in?" switches to live mode and says "Done."). The main set
  had almost none, so a gate fitted there looked perfect. Ordinary questions,
  lookups, edits and simulations are still rejected (0 of 46).
- No threshold fixes it; the margins overlap. The veto stops about half.
- The speed gain holds: 0.40 s against 5.17 s for the 56% of commands handled.
- **A cross-fitted split of one set is not a held-out test** once descriptions
  were written from that set's failures. Write the adversarial negatives first.
- The validation set is spent for anything changed because of it. The default
  (on) has not been changed; that decision is open.

### Question-form check and the holdout (2026-11-18)

`fast_path.reads_as_question` (`ADSB_AGENT_FAST_PATH_QUESTION_CHECK_ENABLED`,
on): question word or auxiliary first, "?" last, or a negation first → agent,
no model call. Kept on by default by the user's decision.

| Veto off, `ministral-3-3b` | Wrong action on an agent request |
|---|---|
| Validation (95), no check / check | 10 / 3 |
| Holdout (83), no check / check | 16 / 4 |
| Holdout (83), check + veto on | 1 (20 of 54 commands handled) |

- **The embedding gate keeps degrading on each new set**: AUC 0.99 (main),
  0.80 (validation), **0.59** (holdout). Topic similarity cannot tell "is the
  sidebar open?" from "close the sidebar". "Asking about" documents per tool
  (0.80 → 0.85) and dropping the earlier turns (no gain) were not adopted.
- What the check cannot see: remarks ("That heatmap looks great.") and
  negations not at the start ("Leave the sidebar alone.").
- The holdout is spent. Record: `FAST_PATH_EXPERIMENT.md` → Gate fixes.

## Agent turn latency is prompt-cache misses, not prompt size (measured 2026-11-14)

`adsb-agent/eval/cache_experiment.py`, `gemma-4-12b-qat` on LM Studio, time to first
token of a request sent right after a primer request (5 trials, medians):

| What differs from the previous request | Prompt tokens | First token |
|---|---|---|
| Everything (cold) | 7,114 | 17.2 s |
| Nothing | 7,079 | 0.21 s |
| Only the user message | 7,078 | 0.33 s |
| One UI-state value in the system prompt (**today's layout**) | 7,078 | 17.2 s |
| A different 10-tool subset (per-turn tool ranking) | 2,806 | 6.5 s |
| UI state moved to the final user message, and changed | 7,073 | 0.37 s |

- The server reuses the previous prompt up to the first difference. The ambient
  UI state sits near the top of the system prompt (`system_prompt.md.j2`), so any
  change to it -- a track count is enough -- reprocesses all ~7k tokens. That is
  the 17 s turn.
- This is why per-turn tool filtering made turns slower: a third of the tokens,
  but none of them cached.
- **Do not put anything that changes between turns ahead of the tools and the
  static instructions.** Volatile state goes last.

### Fix shipped: `context_placement = "user"` (default since 2026-11-14)

`attach_context` (`system_prompt.py`) puts the UI state on the **latest user
message**; the system prompt then carries nothing that changes between turns.
`ADSB_AGENT_CONTEXT_PLACEMENT=system` restores the old layout. Checked on
`gemma-4-12b-qat` before flipping the default:

| Check | `system` | `user` |
|---|---|---|
| First token after a UI-state change | 17.2 s | 0.42 s |
| First token on a conversation's second turn | -- | 1.1 s |
| Uses the state (`eval_context_use.py`, 24 probes) | 23 | 23 |
| First tool call expected (stage B, 60 requests, state present) | 52 | 50 |
| Live agent via the MLflow gateway, first token after a state change (8 turns) | 18-22 s | 2.2-3.0 s |

- Only the latest user message carries state, and it is the last *user* message,
  not the last message (a client tool result re-enters as a run ending in a tool
  message). Earlier turns stay bare so the history remains a reusable prefix.
- With no user message the state stays in the system prompt; it is never dropped.
- The eval scripts read the agent's `.env` from the working directory: run them
  from `rust/adsb-agent`, or they fall back to the default model name and fail
  with "Invalid model identifier".
- `asyncio.run` per LLM call breaks on the second call ("Event loop is closed"):
  the OpenAI client's connection pool outlives the loop. Use one loop per script.
- The two stage B disagreements are borderline first steps (`setLayerVisibility`
  alone before `setEventFilter`; `listScenarios` before simulating). Sampling
  noise at this size, not a regression.
- Not measured: models other than `gemma-4-12b-qat`.

**Every stage B figure recorded before 2026-11-14 covers about half of its
records.** `eval_agent_step.py` called `asyncio.run` per request; the OpenAI
client's shared connection pool then belonged to a closed loop and every second
call died with "Event loop is closed". `mlflow.genai.evaluate` drops failed
records from the means without a word, so "60 requests" was ~30 (a first pass
of this very comparison read 90% / 90%). The script now runs one loop on its own
thread, writes its own per-record file and prints how many requests answered.
The earlier comparisons (full 87% vs family selector 87%, latencies) should be
rerun before anyone relies on them. General rule: **count the replies yourself;
never trust an evaluation mean without its denominator.**
