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
    model: str = "liquidai/lfm2.5-1.2b-instruct-mlx"
    max_tokens: int = 8192
    temperature: float = 0.1

    # Agent service
    port: int = 8000
    host: str = "0.0.0.0"

    model_config = {"env_prefix": "ADSB_AGENT_"}


settings = Settings()
