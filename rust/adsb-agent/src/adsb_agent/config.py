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

    # Server-side tool plane: the Tauri localhost tool server that executes the
    # read-only DuckDB data tools the agent chains internally. Must match
    # ADSB_AGENT_TOOL_SERVER_PORT on the Rust side (default 8787).
    tool_server_url: str = "http://127.0.0.1:8787"
    tool_server_timeout: float = 30.0
    # Max agent loop steps (LangGraph recursion limit) — caps tool-call hops.
    agent_recursion_limit: int = 25

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
