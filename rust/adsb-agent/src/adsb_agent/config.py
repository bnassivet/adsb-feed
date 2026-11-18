"""Agent configuration — all settings via environment variables with ADSB_AGENT_ prefix."""

from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Settings for the ADS-B AG-UI agent service.

    All fields can be overridden via environment variables prefixed with ADSB_AGENT_.
    Example: ADSB_AGENT_LLM_BASE_URL=http://localhost:11434/v1  (for Ollama)
    """

    # LLM endpoint (OpenAI-compatible)
    llm_base_url: str = "http://localhost:1234/v1"
    llm_api_key: str = "lm-studio"
    # A capable, tool-calling local model is required for reliable multi-hop
    # reasoning. The 1.2B model used previously cannot plan/chain tool calls.
    # Override with ADSB_AGENT_MODEL for low-resource devices.
    model: str = "qwen2.5-7b-instruct"
    max_tokens: int = 8192
    temperature: float = 0.1

    # Reasoning control. Defaults to OFF because reasoning tokens are charged
    # against `max_tokens`: a model that deliberates can spend the entire budget
    # thinking and return EMPTY content, which the caller experiences as a
    # timeout rather than as an error. Set ADSB_AGENT_REASONING_EFFORT=on to
    # restore the model's own default, or a graded level (minimal/low/medium/
    # high) for providers that offer a dial rather than a toggle.
    reasoning_effort: str | None = "off"
    reasoning_max_tokens: int | None = None
    """Hard cap on reasoning tokens, for providers that accept one.

    Sent as ``reasoning: {max_tokens: N}``. Same caveat as ``reasoning_effort``:
    it is a request, not an enforcement."""

    # Server-side tool plane: the Tauri localhost tool server that executes the
    # read-only DuckDB data tools the agent chains internally. Must match
    # ADSB_AGENT_TOOL_SERVER_PORT on the Rust side (default 8787).
    tool_server_url: str = "http://127.0.0.1:8787"
    tool_server_timeout: float = 30.0
    # Max agent loop steps (LangGraph recursion limit) — caps tool-call hops.
    agent_recursion_limit: int = 25

    # Simulation agent: a separate Python service (adsb-simulation-agent) that
    # generates simulated flight trajectories, reached over the A2A protocol.
    # Optional — if it isn't running, the tool reports a readable error and the
    # rest of the agent is unaffected.
    simulation_agent_url: str = "http://127.0.0.1:8300"
    # Generation runs an LLM classification hop plus geometry, so it is slower
    # than the DuckDB data tools.
    simulation_agent_timeout: float = 60.0

    # Scenario description: one short summarisation call, no tools and no graph
    # hops, so it is far cheaper than a chat turn. Stated explicitly rather than
    # left to the client default — an unstated caller/callee timeout mismatch
    # has previously surfaced as an unreadable "could not reach ... ()" error.
    describe_timeout: float = 60.0

    # Where the ambient UI state (RunAgentInput.context) goes in the prompt.
    # "user" (default): on the latest user message, so the system prompt and
    # tool schemas are identical on every turn and the model server can reuse
    # them. Measured time to first token after one state value changed: 0.4 s,
    # against 17.2 s for "system". Tool choice and use of the state were equal.
    # "system": near the top of the system prompt (the original layout).
    context_placement: Literal["system", "user"] = "user"

    # Tool ranking (experimental, off by default). Before the LLM call, a small
    # decision model scores every tool against the request and only the best
    # are bound, because tool schemas were ~3/4 of every prompt. Any failure
    # falls back to the full list. See tool_ranker.py and eval/.
    tool_ranker_enabled: bool = False
    tool_ranker_url: str = "http://localhost:5010/gateway/typesafe/v1/systemone"
    tool_ranker_model: str = "d1-omni-600m"
    # How many tools to keep by score. Pinned tools and tools already called in
    # the conversation are kept on top of this.
    tool_ranker_top_k: int = 10
    # One batched request for ~40 tools measured 320-520 ms. Generous, but well
    # short of the seconds the full tool list costs the LLM.
    tool_ranker_timeout: float = 3.0
    # Always bound. getCurrentDateTime is needed by any relative-time question
    # ("last hour") yet scores near the bottom: nothing in such a question says
    # "clock". Env form is JSON: ADSB_AGENT_TOOL_RANKER_PINNED='["a","b"]'.
    tool_ranker_pinned: list[str] = ["getCurrentDateTime"]

    # Desktop fast path. A direct display command ("switch to night mode") is
    # carried out by a small model before the main agent is involved: about
    # 0.3 s instead of several seconds, with the same correctness (measured in
    # eval/fastpath_agent/FAST_PATH_EXPERIMENT.md). Three checks, in order; any "no" or
    # any failure sends the request to the main agent exactly as before:
    #   0. question form   the latest message does not read as a question
    #   1. embedding gate  the request is closer to a direct display tool than
    #                      to any other tool, by at least the margin below
    #   2. veto            the decision model calls it a display command
    #   3. executor        the small model makes a schema-valid call
    # False turns the whole fast path off: every request goes to the main agent.
    fast_path_enabled: bool = True
    # A message that starts with a question word or an auxiliary ("is the
    # sidebar open?"), ends with "?", or opens with a negation ("don't stop the
    # feed") goes to the main agent without any model call. The embedding gate
    # matches by topic and passed such requests on fresh data. Measured
    # 2026-11-18 on 449 requests: 20 -> 5 agent requests pass the gate, 1 of 141
    # commands lost (polite commands such as "can you ..." go to the agent).
    fast_path_question_check_enabled: bool = True
    # The veto costs one decision-model request (~0.1 s) on requests that pass
    # the gate. Off: about 6 more commands in 60 are handled fast, and requests
    # that only resemble a command ("pan to the selected aircraft") reach the
    # small model -- 4 wrong actions in 273 requests, against 0 with the veto.
    fast_path_veto_enabled: bool = True
    # The veto drops a request whose probability of being a display command is
    # under this. 0.75 and 0.9 were measured too: they only lose commands.
    fast_path_veto_below: float = 0.5
    # Minimum embedding margin (best direct tool minus best other tool). Fitted
    # for 95% precision on the 273 evaluation requests. It belongs to this
    # embedding model AND the packaged descriptions (fast_path_descriptions.json):
    # change either and refit with eval/fastpath_agent/eval_fast_path_service.py --fit.
    fast_path_embed_threshold: float = 0.0605
    # The small executor model, on an OpenAI-compatible server.
    fast_path_model: str = "mistralai/ministral-3-3b"
    fast_path_base_url: str = "http://localhost:1234/v1"
    fast_path_api_key: str = "lm-studio"
    # "none" turns reasoning off (a thinking model otherwise returns an empty
    # reply). Set empty for a server that rejects the field.
    fast_path_reasoning_effort: str = "none"
    # Embeddings for the gate (OpenAI-compatible /embeddings).
    fast_path_embed_url: str = "http://localhost:5010/gateway/openai/v1/embeddings"
    fast_path_embed_model: str = "lmstudio-embeddinggemma-300m"
    # The veto uses the decision endpoint and model of the tool ranker
    # (tool_ranker_url, tool_ranker_model above).
    # Past these the request falls through to the main agent. Kept short: when
    # a model is not loaded, every request waits this long first.
    fast_path_gate_timeout: float = 2.0
    fast_path_executor_timeout: float = 5.0
    # The reply after a fast-path action, sent without any model call.
    fast_path_confirmation: str = "Done."

    # MLflow tracing
    mlflow_enabled: bool = True
    mlflow_tracking_uri: str = "http://localhost:5010"
    mlflow_experiment: str = "adsb-agent"

    # Agent service
    port: int = 8000
    host: str = "0.0.0.0"
    # SSE heartbeat: emit a keep-alive comment if no event is produced within
    # this many seconds, so long silent LLM steps don't trip client/proxy idle
    # timeouts and abort the stream. Keep well under typical 30–60s idle limits.
    sse_heartbeat_seconds: float = 15.0

    model_config = {"env_prefix": "ADSB_AGENT_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
