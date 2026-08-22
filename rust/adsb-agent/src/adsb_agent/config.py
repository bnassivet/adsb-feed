"""Agent configuration — all settings via environment variables with ADSB_AGENT_ prefix."""

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
