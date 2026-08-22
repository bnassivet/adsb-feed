"""MLflow tracing for the simulation agent, linked to the caller's trace.

Mirrors ``adsb-agent/src/adsb_agent/tracing.py`` — same guarded style, same
lazy imports — plus the distributed-tracing half that makes this service's
spans appear *inside* the calling agent's trace rather than beside it.

Public surface:

- ``setup_tracing()`` — once at startup, before any LLM client is built.
- ``make_span(name, span_type)`` — guarded ``mlflow.start_span``.
- ``tracing_scope(headers)`` — join the caller's trace for the request.
- ``is_linked()`` / ``tag_root_trace(...)`` — trace-level metadata, safely.

Every mlflow import is lazy and every failure degrades to a no-op: tracing is
observability, and must never be able to fail a trajectory generation.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Mapping
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar

logger = logging.getLogger("adsb_simulation_agent.tracing")

TRACEPARENT = "traceparent"
"""W3C TraceContext header MLflow uses to stitch traces across services."""


class SpanType:
    """String constants mirroring ``mlflow.entities.SpanType``.

    Deliberately not the real enum: importing it would drag mlflow into
    ``graph.py`` and ``executor.py`` at module-import time, defeating the lazy
    imports that make the disabled path free. ``test_tracing.py`` asserts these
    stay equal to mlflow's own values, so the shortcut can't silently drift.
    """

    AGENT = "AGENT"
    CHAIN = "CHAIN"
    PARSER = "PARSER"
    TOOL = "TOOL"


# Whether the current request joined a caller's trace. Set by `tracing_scope`;
# read by `tag_root_trace`. A ContextVar rather than a global because a2a-sdk
# runs each executor in its own asyncio task — tasks copy the context at
# creation, so the value follows the request without being shared across
# concurrent ones.
_linked: ContextVar[bool] = ContextVar("adsb_sim_trace_linked", default=False)

# Inbound trace headers, stashed by the HTTP layer for the executor to pick up.
# Same ContextVar propagation as above.
_headers: ContextVar[dict[str, str] | None] = ContextVar("adsb_sim_trace_headers", default=None)


def capture_trace_headers(headers: Mapping[str, str]) -> None:
    """Stash inbound trace headers for whatever later handles this request.

    Deliberately split from :func:`tracing_scope`, which is what actually joins
    the trace. ``DefaultRequestHandler`` runs the executor in a *detached* task
    (``asyncio.create_task``) whose completion is not awaited before the HTTP
    response is returned — so a scope opened in middleware can exit while the
    executor's span is still open, and that span is then dropped on export.
    Capturing here and joining inside the executor makes the scope's lifetime
    match the span's exactly.
    """
    _headers.set({k: v for k, v in headers.items()})


def captured_trace_headers() -> dict[str, str]:
    """Trace headers stashed for this request, or ``{}``."""
    return _headers.get() or {}


def setup_tracing() -> None:
    """Configure MLflow tracing. Call once, before building the LLM client.

    Ordering is load-bearing: ``openai.autolog()`` patches the OpenAI SDK, so it
    must run before ``ChatOpenAI`` constructs its client, or LLM calls go
    untraced.

    When disabled this returns without importing mlflow at all.
    """
    from .config import settings

    if not settings.mlflow_enabled:
        logger.debug("MLflow tracing disabled (ADSB_SIM_AGENT_MLFLOW_ENABLED=false)")
        return

    import mlflow

    if settings.mlflow_tracking_uri:
        mlflow.set_tracking_uri(settings.mlflow_tracking_uri)
        logger.info("MLflow tracking URI: %s", settings.mlflow_tracking_uri)

    mlflow.set_experiment(settings.mlflow_experiment)
    logger.info("MLflow experiment: %s", settings.mlflow_experiment)

    # As in adsb-agent, `mlflow.langchain.autolog()` is deliberately NOT enabled
    # even though this is a LangGraph service. LangChain's tracer parents spans
    # through an internal run_id map and disables contextvar attachment, so its
    # callback tree does not interleave with MLflow's fluent tree — mixing the
    # two yields detached and duplicated spans. The graph is instrumented by
    # hand instead (see graph.py), and OpenAI autolog supplies the LLM span,
    # which nests correctly under our `parse_intent` span.
    mlflow.openai.autolog()
    logger.info("MLflow OpenAI autolog enabled")


def make_span(name: str, span_type: str = SpanType.CHAIN):
    """Return an MLflow span context manager, or ``nullcontext()`` when off.

    The span is ``None`` inside the ``with`` block when tracing is unavailable,
    so every call site must guard::

        with make_span("plan_route") as span:
            if span is not None:
                span.set_inputs({...})

    Synchronous context manager — valid inside ``async def``.
    """
    try:
        from .config import settings

        if not settings.mlflow_enabled:
            return nullcontext()
        import mlflow

        return mlflow.start_span(name=name, span_type=span_type)
    except Exception:  # noqa: BLE001 — tracing must never break generation
        return nullcontext()


@contextmanager
def tracing_scope(headers: Mapping[str, str]) -> Iterator[None]:
    """Join the caller's trace for the duration of the block.

    MLflow follows W3C TraceContext, so a ``traceparent`` header from
    ``adsb-agent`` is all that's needed: spans opened inside this block become
    children of the caller's span instead of roots of a separate trace.

    A missing header is normal, not an error — it means this service was called
    directly (or the caller has tracing off), and it becomes its own root.
    """
    if not _has_traceparent(headers):
        yield
        return

    try:
        from .config import settings

        if not settings.mlflow_enabled:
            yield
            return
        from mlflow.tracing import set_tracing_context_from_http_request_headers
    except Exception:
        logger.debug("MLflow unavailable; running unlinked", exc_info=True)
        yield
        return

    # Only *entering* the context is guarded. Wrapping the `yield` in the same
    # try/except would swallow the request's own exceptions and then yield a
    # second time, which raises "generator didn't stop after throw()".
    try:
        scope = set_tracing_context_from_http_request_headers(dict(headers))
        scope.__enter__()
    except Exception:
        # A malformed traceparent must not fail the request; run unlinked.
        logger.debug("Could not join caller trace; continuing unlinked", exc_info=True)
        yield
        return

    token = _linked.set(True)
    try:
        yield
    finally:
        _linked.reset(token)
        flush_spans()
        try:
            scope.__exit__(None, None, None)
        except Exception:
            logger.debug("Failed to detach trace context", exc_info=True)


def flush_spans() -> None:
    """Export queued spans now, while the trace is still resolvable.

    Not an optimisation — required for correctness. MLflow's
    ``set_tracing_context_from_http_request_headers`` registers a placeholder
    trace on entry and calls ``pop_trace`` in its ``finally``. Spans still
    sitting in the OpenTelemetry batch processor at that moment can no longer
    be matched to a trace, so the exporter skips them **silently**.

    In practice that cost us the outermost span of every linked request — it
    ends last, so it was always the one still queued — leaving every child span
    orphaned. Flushing before the scope closes keeps the trace registered until
    the spans are on their way. (MLflow's own documented client/server example
    has the same gap; verified against MLflow 3.15.)
    """
    try:
        from .config import settings

        if not settings.mlflow_enabled:
            return
        import mlflow

        mlflow.flush_trace_async_logging()
    except Exception:
        logger.debug("Failed to flush spans", exc_info=True)


def is_linked() -> bool:
    """True when this request joined a caller's trace."""
    return _linked.get()


def tag_root_trace(**fields: str) -> None:
    """Set trace-level metadata, but only when we own the trace.

    ``mlflow.update_current_trace`` mutates the *whole trace*, not the current
    span. When linked to ``adsb-agent`` there is only one trace, and tagging it
    here would overwrite the chat turn's ``session_id`` and tags. So this is a
    deliberate no-op whenever :func:`is_linked` is true — per-request detail
    belongs on span attributes instead.

    ``client_request_id`` is passed through as MLflow's first-class field; every
    other keyword becomes a plain trace tag.
    """
    if is_linked():
        return
    try:
        from .config import settings

        if not settings.mlflow_enabled:
            return
        import mlflow

        client_request_id = fields.pop("client_request_id", None)
        kwargs: dict = {}
        if client_request_id is not None:
            kwargs["client_request_id"] = client_request_id
        if fields:
            kwargs["tags"] = dict(fields)
        if kwargs:
            mlflow.update_current_trace(**kwargs)
    except Exception:
        logger.debug("Could not tag trace", exc_info=True)


def _has_traceparent(headers: Mapping[str, str]) -> bool:
    """HTTP headers are case-insensitive; ASGI may hand us either casing."""
    return any(key.lower() == TRACEPARENT for key in headers)
