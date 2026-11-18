# Tool ranking with d1-omni-600m to shrink the agent's context

## Context

Every chat turn of `adsb-agent` binds all 40 tools (9 backend + 31 from the desktop).
Measured on a recent trace: tool schemas are ~24k chars against an 8k-char system
prompt — about three quarters of the ~7,250 input tokens — and a turn takes ~17 s on
`gemma-4-12b-qat`.

The idea to test: before the LLM call, ask the local decision model `d1-omni-600m`
which tools the request needs, and bind only the top-ranked ones.

Probe results (7 requests sent during planning):

- `POST /gateway/typesafe/v1/systemone` needs `"model": "d1-omni-600m"` in the body
  (without it: HTTP 400).
- One request can carry one `noul` question per tool: 40 questions return 40
  probabilities in 320–520 ms (~4k input tokens). A single question takes 25 ms and
  scores the same as in the batch, so questions are scored independently.
- Ranking quality with a naive question wording is **not good enough yet**:
  `getWindAloft` ranked 13th for a wind question, `generateSimulatedTrajectory` 8th for
  "simulate 3 helicopters", `getCurrentDateTime` 30th–37th on relative-time questions,
  and `searchLiveFlights` scored ≥0.77 on everything including "hi".

So the mechanism works and is fast; whether it is accurate enough is exactly what the
evaluation dataset has to answer, and the question wording is the main thing to tune.

Decisions taken: offline evaluation **plus** wiring behind a flag that is off by
default; dataset from real traces plus curated gap-fillers; I draft labels, you review
before upload.

## Part 1 — Evaluation harness and dataset

The harness lives inside the agent project, in `rust/adsb-agent/eval/`, behind a plain
`eval` optional extra (`mlflow>=3.18`). `mlflow-tracing` stays a base dependency.

An earlier draft of this plan used two *conflicting* extras and a second virtualenv, on
the belief that `mlflow-tracing` and full `mlflow` cannot share an environment. That is
true of older releases but not of 3.18, where the full package **depends on**
`mlflow-tracing` at the same version. So: one `.venv`, `uv sync --all-extras` still
works, and the lockfile moves the tracing SDK from 3.12 to 3.18 (matching the server).

One side effect: with full `mlflow` installed, spans opened by the unit tests are
exported to its default local store, leaving `mlflow.db` and `mlruns/` in the project.
`tests/conftest.py` points the store at a temp file store.

Follows the `agent-evaluation` skill: MLflow datasets, `@scorer` code checks,
`mlflow.genai.evaluate`, registered scorers, 5-record sanity run and 3-record dry run
before the full run. Load `instrumenting-with-mlflow-tracing` at implementation start.

Files:

- `fixtures/tool_surface.json` + `snapshot_tool_surface.py` — the 40 tool schemas as
  production actually sends them, taken from the `AsyncCompletions` span of a recent
  `adsb-agent` trace. (`tools.py` dev copies are incomplete, so they are not used.)
- `mine_traces.py` — reads experiment `adsb-agent` (id 7) over REST, keeps `chat_turn`
  traces with a real user question (drops voice, `/simulate`, `/describe` payloads and
  empty previews), groups by session so a question gets every tool called across its
  runs, de-duplicates, and writes `data/candidates.jsonl` with a draft `expected_tools`.
- `data/labels.jsonl` — the reviewed ground truth, checked in. Trace-derived rows plus
  curated ones so every tool has ≥3 questions, plus no-tool turns ("hi"), follow-ups
  ("and now?", "show it on the map") with their history, and multi-hop chains. Target
  100–150 records. **You review this file before anything is uploaded.**
- `upload_dataset.py` — `mlflow.genai.datasets.create_dataset` / `merge_records` into a
  new experiment `adsb-agent-tool-ranking`, dataset `adsb-tool-selection-v1`. Record
  shape: `inputs {question, history}`, `expectations {expected_tools}`, tag
  `source = trace | curated`.
- `eval_ranker.py` (stage A, no LLM) — `predict_fn(question, history)` calls the
  ranker; scorers: `full_recall` (every expected tool selected), `recall`,
  `first_relevant_rank`, `token_reduction` (schema chars selected vs full),
  `ranker_latency_ms`. One MLflow run per variant: question wording × top-k × pinned
  set, logged as params so variants compare in the UI.
- `eval_agent_step.py` (stage B, real LLM) — one `model.ainvoke` with the system
  prompt and bound tools, full list vs filtered. No graph run, so no tool executes and
  nothing touches the desktop. Scorers: `first_call_expected`, `called_unbound_tool`,
  `input_tokens`, `latency_s`.

Gate for recommending the flag be turned on: `full_recall` ≥ 95% at a setting with
≥ 50% tool-schema reduction, and stage B tool choice no worse than the full list.

## Part 2 — Ranker in the agent, off by default

TDD, one red-green cycle per commit, on `feature/agent_optimizations`; commits only, no
push, no co-author trailer.

- New `rust/adsb-agent/src/adsb_agent/tool_ranker.py`
  - `rank_tools(tools, question, history, client)` — one batched systemone request, one
    `noul` question per tool; wording lives in one template so stage A can vary it.
  - `select_tools(...)` — top-k by score, plus pinned tools (`getCurrentDateTime` to
    start with), plus any tool already called in the conversation history (keeps
    follow-ups working and the chat history valid). Original list order is preserved.
  - Fail-open: disabled, timeout, HTTP error or malformed answer → the full list.
  - Wrapped in `make_span("tool_ranker", ...)` (`tracing.py`) with scores, selected
    names and the count dropped, so each `chat_turn` trace shows the decision.
- `config.py` — `tool_ranker_enabled = False`, `tool_ranker_url`, `tool_ranker_model`,
  `tool_ranker_top_k`, `tool_ranker_timeout`, `tool_ranker_pinned`; documented in
  `.env.example`.
- `llm.py::stream_llm_response` — compute `effective_tools(tools)` once, select, and
  pass the same selection to both `render_system_prompt` and `build_agent_graph`.
- `graph.py::build_agent_graph` and `system_prompt.py::render_system_prompt` — accept
  an already-resolved tool list. Execution routing keeps using the full
  `SERVER_TOOL_NAMES`, so a filtered-out backend tool is never mis-routed to the
  browser. The "What you can do" list shrinks with the selection.
- `metrics.py` — ranker latency, tools kept, fallbacks.
- Tests `tests/test_tool_ranker.py` (httpx `MockTransport`): ordering, pins, history
  tools, each fail-open path, and that the disabled path sends exactly today's tools
  and prompt.

Left out on purpose: `prompt_sections.yaml` guidelines still name tools that may be
filtered out. Stage B's `called_unbound_tool` measures whether that matters before any
guideline filtering is built.

## Verification

1. `cd rust/adsb-agent && uv sync --all-extras && uv run pytest` — existing suite plus the new ranker tests; `uv run ruff check`.
2. Dataset: `mine_traces.py` → review `labels.jsonl` → `upload_dataset.py`; confirm the
   dataset appears under experiment `adsb-agent-tool-ranking` at http://127.0.0.1:5010.
3. Stage A: sanity run on 5 records, then the full dataset across variants; read
   `full_recall` / `token_reduction` per run.
4. Stage B on the best variant: full vs filtered.
5. Live check: set `ADSB_AGENT_TOOL_RANKER_ENABLED=true`, `make restart-agents`, ask
   "how many aircraft per hour on the last 12 hours?" and "simulate 3 helicopters
   circling the port" in the desktop chat; confirm in the `chat_turn` trace that the
   `tool_ranker` span lists the selection and input tokens dropped. Then stop the
   ranker endpoint and confirm the turn still works with the full list.
6. `graphify update .`
