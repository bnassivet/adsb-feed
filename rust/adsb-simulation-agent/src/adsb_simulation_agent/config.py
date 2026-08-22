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

    max_tokens: int = 4096
    """A RoutePlan is only a handful of scalars, but reasoning models spend
    hundreds of tokens thinking before emitting any content — `gemma-4-12b-qat`
    needs ~430 for a clear request. Effort scales with how *vague* the hint is,
    not its length: a bare "downtown" costs ~1450. Too small a budget yields
    ``finish_reason='length'`` with an EMPTY string, which looks exactly like a
    model that ignored the prompt. `intent.py` retries once on truncation, so
    this only needs to cover the common case comfortably."""

    llm_timeout_s: float = 120.0

    prompt_style: str = "full"
    """Which classification prompt to send: ``full`` or ``compact``.

    The full prompt teaches the schema properly and classifies best. The compact
    one is about a third the size, keeping the field list and dropping the
    explanation — for models where prompt length is the binding constraint.
    Prompt tokens and answer tokens share one budget, so on a small or
    reasoning-heavy model a long prompt can leave no room to reply: the answer
    comes back empty with ``finish_reason='length'``. Measured on
    ``gemma-4-12b-qat``, a short prompt answered in ~2 s with no reasoning
    tokens at all, where the full prompt spent its entire budget thinking."""

    reasoning_effort: str | None = None
    """Reasoning effort to request, e.g. ``minimal``, ``low``, ``medium``, ``high``.

    Sent only when set. Reasoning tokens are charged against ``max_tokens``, so
    a model that thinks hard can consume the whole budget and return nothing —
    this is the knob that asks it not to. Support varies by provider and model;
    an endpoint that does not understand it ignores it (verified: the MLflow
    gateway accepts it with HTTP 200 either way), so setting it is safe but not
    a guarantee."""

    reasoning_max_tokens: int | None = None
    """Hard cap on reasoning tokens, for providers that accept one.

    Sent as ``reasoning: {max_tokens: N}``. Same caveat as ``reasoning_effort``:
    it is a request, not an enforcement. The reliable lever remains choosing a
    model that does not reason, or shortening the prompt."""

    # Generation
    max_retries: int = 2
    """Attempts the validate -> plan_route edge may take before giving up and
    returning the best-effort trajectory with its violations attached."""

    # MLflow tracing
    mlflow_enabled: bool = True
    mlflow_tracking_uri: str = "http://localhost:5010"

    mlflow_experiment: str = "adsb-agent"
    """Deliberately the *same* experiment as ``adsb-agent``. Spans from both
    services stitch into one trace via W3C traceparent propagation, and a trace
    lives in exactly one experiment — so these must agree or the link breaks."""

    # Service — 8300 avoids adsb-agent (8000) and the Tauri tool server (8787).
    port: int = 8300
    host: str = "0.0.0.0"

    model_config = {"env_prefix": "ADSB_SIM_AGENT_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
