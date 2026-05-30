"""MLflow tracing setup and span helpers for the ADS-B agent.

Two public functions:
- setup_tracing(): called once at startup; patches OpenAI SDK via autolog
- make_span(name): returns an MLflow span context manager, or nullcontext when disabled

All mlflow imports are lazy — importing this module never touches mlflow.
"""

from __future__ import annotations

import logging
from contextlib import nullcontext

logger = logging.getLogger("adsb_agent.tracing")


def setup_tracing() -> None:
    """Configure MLflow tracing.

    Must be called before uvicorn starts so mlflow.openai.autolog() patches
    the OpenAI SDK before the first AsyncOpenAI client is created.

    When mlflow_enabled is False this function returns immediately without
    importing mlflow — the disabled path is completely import-free.
    """
    from .config import settings

    if not settings.mlflow_enabled:
        logger.debug("MLflow tracing disabled (ADSB_AGENT_MLFLOW_ENABLED=false)")
        return

    import mlflow

    if settings.mlflow_tracking_uri:
        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        logger.info("MLflow tracking URI: %s", settings.mlflow_tracking_uri)

    mlflow.set_experiment(settings.mlflow_experiment)
    logger.info("MLflow experiment: %s", settings.mlflow_experiment)

    mlflow.openai.autolog()
    logger.info("MLflow OpenAI autolog enabled (chat completions will be traced)")


def make_span(name: str, span_type: str = "LLM"):
    """Return an MLflow span context manager, or nullcontext when disabled.

    Usage:
        with make_span("my_call") as span:
            if span is not None:
                span.set_inputs({...})
            result = await some_async_call()
            if span is not None:
                span.set_outputs({...})

    The `with` block is a sync context manager — valid inside async functions.
    The span object is None when tracing is disabled (nullcontext returns None).
    Any exception during span creation falls back to nullcontext silently.
    """
    try:
        from .config import settings
        if not settings.mlflow_enabled:
            return nullcontext()
        import mlflow
        return mlflow.start_span(name=name, span_type=span_type)
    except Exception:
        return nullcontext()
