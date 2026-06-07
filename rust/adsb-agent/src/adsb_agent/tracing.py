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

    # We deliberately do NOT enable `mlflow.langchain.autolog()`. LangChain's
    # tracer parents its spans through an internal run_id map and disables
    # contextvar attachment during graph execution (it warns that "ContextVar is
    # not correctly propagated" across LangChain's thread/async boundaries). That
    # callback tree does not interleave with MLflow's fluent contextvar tree, so
    # mixing it with our manual `make_span()` spans (the `chat_turn` root, the
    # graph nodes, and `tool.*`) produced detached/duplicate spans.
    #
    # Instead we instrument the graph manually (see graph.py) and rely on OpenAI
    # autolog for the LLM call. openai-autolog spans parent via the fluent
    # context, so each `AsyncCompletions` nests cleanly under its `agent` node
    # span — one tracing model, correct nesting.
    mlflow.openai.autolog()
    logger.info("MLflow OpenAI autolog enabled (chat completions will be traced)")


def set_session_tag(thread_id: str, **extra: str) -> None:
    """Attach the chat session id (AG-UI ``thread_id``) to the active trace.

    Uses MLflow 3.11+ ``session_id=`` parameter on ``update_current_trace`` —
    this is what feeds the MLflow Sessions view. Extra keyword args are
    forwarded as plain trace tags (useful for ``run_id``, etc.).

    Safe to call when MLflow is disabled, the mlflow package is unimportable,
    or no trace is currently active — all failure paths are swallowed.
    """
    try:
        from .config import settings
        if not settings.mlflow_enabled:
            return
        import mlflow
        if extra:
            mlflow.update_current_trace(session_id=thread_id, tags=dict(extra))
        else:
            mlflow.update_current_trace(session_id=thread_id)
    except Exception:
        # Tagging is observability, not application logic — never raise.
        pass


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
