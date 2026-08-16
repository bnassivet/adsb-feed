"""Service configuration — all settings via ADSB_SIM_AGENT_-prefixed env vars.

The LLM defaults mirror ``adsb-agent``'s: a local OpenAI-compatible endpoint
(LM Studio by default). This project is local-first — nothing here should
require a cloud API key to run.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Settings for the ADS-B simulation agent.

    Override any field with ``ADSB_SIM_AGENT_<FIELD>``, e.g.
    ``ADSB_SIM_AGENT_PORT=8301``.
    """

    # LLM endpoint (OpenAI-compatible). Only used to classify a free-text route
    # hint into a RoutePlan — never to produce coordinates.
    llm_base_url: str = "http://localhost:1234/v1"
    llm_api_key: str = "lm-studio"
    model: str = "qwen2.5-7b-instruct"
    temperature: float = 0.0
    """Zero: this is a classification task, not a creative one."""

    max_tokens: int = 2048
    """A RoutePlan is only a handful of scalars, but reasoning models spend
    hundreds of tokens thinking before emitting any content — `gemma-4-12b-qat`
    needs ~430 for a clear request. Effort scales with how *vague* the hint is,
    not its length: a bare "downtown" costs ~1450. Too small a budget yields
    ``finish_reason='length'`` with an EMPTY string, which looks exactly like a
    model that ignored the prompt. `intent.py` retries once on truncation, so
    this only needs to cover the common case comfortably."""

    llm_timeout_s: float = 30.0

    # Generation
    max_retries: int = 2
    """Attempts the validate -> plan_route edge may take before giving up and
    returning the best-effort trajectory with its violations attached."""

    # Service — 8300 avoids adsb-agent (8000) and the Tauri tool server (8787).
    port: int = 8300
    host: str = "0.0.0.0"

    model_config = {"env_prefix": "ADSB_SIM_AGENT_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
