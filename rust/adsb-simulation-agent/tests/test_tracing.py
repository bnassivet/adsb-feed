"""Tests for adsb_simulation_agent.tracing — MLflow tracing setup.

Mirrors ``adsb-agent/tests/test_tracing.py``: mlflow is mocked via sys.modules
injection so no test needs a real MLflow server, or even an importable mlflow.

The distributed-tracing half (``tracing_scope``) is what links this service's
spans to the caller's trace, so it gets the most attention here.
"""

from __future__ import annotations

import sys
from contextlib import contextmanager
from unittest.mock import MagicMock, call

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mlflow_mock() -> MagicMock:
    """Build a minimal mlflow mock satisfying every call tracing.py makes."""
    m = MagicMock(name="mlflow")
    m.openai = MagicMock(name="mlflow.openai")
    m.openai.autolog = MagicMock()
    m.set_tracking_uri = MagicMock()
    m.set_experiment = MagicMock()
    m.update_current_trace = MagicMock()

    entered: list[dict] = []

    @contextmanager
    def _ctx(headers):
        entered.append(headers)
        yield

    m.tracing = MagicMock(name="mlflow.tracing")
    m.tracing.set_tracing_context_from_http_request_headers = MagicMock(side_effect=_ctx)
    m.tracing.get_tracing_context_headers_for_http_request = MagicMock(return_value={})
    m.tracing.entered = entered  # type: ignore[attr-defined]
    return m


def _inject(mock: MagicMock) -> None:
    sys.modules["mlflow"] = mock
    sys.modules["mlflow.openai"] = mock.openai
    sys.modules["mlflow.tracing"] = mock.tracing


def _eject() -> None:
    for name in ("mlflow", "mlflow.openai", "mlflow.tracing"):
        sys.modules.pop(name, None)


@pytest.fixture
def enabled(monkeypatch):
    """Tracing on, with a mlflow mock injected. Yields the mock."""
    from adsb_simulation_agent.config import settings

    monkeypatch.setattr(settings, "mlflow_enabled", True)
    monkeypatch.setattr(settings, "mlflow_tracking_uri", "")
    monkeypatch.setattr(settings, "mlflow_experiment", "adsb-agent")
    mock = _make_mlflow_mock()
    _inject(mock)
    yield mock
    _eject()


@pytest.fixture
def disabled(monkeypatch):
    from adsb_simulation_agent.config import settings

    monkeypatch.setattr(settings, "mlflow_enabled", False)
    yield
    _eject()


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


class TestConfigMLflowFields:
    def test_enabled_default_true(self, monkeypatch):
        monkeypatch.delenv("ADSB_SIM_AGENT_MLFLOW_ENABLED", raising=False)
        from adsb_simulation_agent.config import Settings

        assert Settings().mlflow_enabled is True

    def test_tracking_uri_default(self, monkeypatch):
        monkeypatch.delenv("ADSB_SIM_AGENT_MLFLOW_TRACKING_URI", raising=False)
        from adsb_simulation_agent.config import Settings

        assert Settings().mlflow_tracking_uri == "http://localhost:5010"

    def test_experiment_defaults_to_the_adsb_agent_experiment(self, monkeypatch):
        """Shared experiment is the whole point — both services land together."""
        monkeypatch.delenv("ADSB_SIM_AGENT_MLFLOW_EXPERIMENT", raising=False)
        from adsb_simulation_agent.config import Settings

        assert Settings().mlflow_experiment == "adsb-agent"

    def test_enabled_overridden_by_env(self, monkeypatch):
        monkeypatch.setenv("ADSB_SIM_AGENT_MLFLOW_ENABLED", "false")
        from adsb_simulation_agent.config import Settings

        assert Settings().mlflow_enabled is False

    def test_tracking_uri_overridden_by_env(self, monkeypatch):
        monkeypatch.setenv("ADSB_SIM_AGENT_MLFLOW_TRACKING_URI", "http://remote:5000")
        from adsb_simulation_agent.config import Settings

        assert Settings().mlflow_tracking_uri == "http://remote:5000"

    def test_experiment_overridden_by_env(self, monkeypatch):
        monkeypatch.setenv("ADSB_SIM_AGENT_MLFLOW_EXPERIMENT", "my-exp")
        from adsb_simulation_agent.config import Settings

        assert Settings().mlflow_experiment == "my-exp"


# ---------------------------------------------------------------------------
# setup_tracing()
# ---------------------------------------------------------------------------


class TestSetupTracingDisabled:
    def test_does_not_import_mlflow(self, monkeypatch):
        from adsb_simulation_agent.config import settings

        monkeypatch.setattr(settings, "mlflow_enabled", False)
        poison = MagicMock(side_effect=ImportError("must not be imported"))
        sys.modules["mlflow"] = poison  # type: ignore[assignment]
        try:
            from adsb_simulation_agent.tracing import setup_tracing

            assert setup_tracing() is None
            poison.set_experiment.assert_not_called()
            poison.openai.autolog.assert_not_called()
        finally:
            _eject()


class TestSetupTracingEnabled:
    def test_calls_openai_autolog(self, enabled):
        from adsb_simulation_agent.tracing import setup_tracing

        setup_tracing()
        enabled.openai.autolog.assert_called_once()

    def test_does_not_enable_langchain_autolog(self, enabled):
        """Deliberate: LangChain's callback-based span tree fights fluent spans.

        See adsb-agent/tracing.py for the full rationale — this service has the
        same LangGraph + ChatOpenAI shape, so it inherits the decision.
        """
        from adsb_simulation_agent.tracing import setup_tracing

        setup_tracing()
        enabled.langchain.autolog.assert_not_called()

    def test_sets_experiment(self, enabled, monkeypatch):
        from adsb_simulation_agent.config import settings

        monkeypatch.setattr(settings, "mlflow_experiment", "custom-exp")
        from adsb_simulation_agent.tracing import setup_tracing

        setup_tracing()
        enabled.set_experiment.assert_called_once_with("custom-exp")

    def test_empty_tracking_uri_is_skipped(self, enabled):
        from adsb_simulation_agent.tracing import setup_tracing

        setup_tracing()
        enabled.set_tracking_uri.assert_not_called()

    def test_call_order_uri_then_experiment_then_autolog(self, enabled, monkeypatch):
        from adsb_simulation_agent.config import settings

        monkeypatch.setattr(settings, "mlflow_tracking_uri", "http://localhost:5010")
        manager = MagicMock()
        enabled.set_tracking_uri = manager.set_tracking_uri
        enabled.set_experiment = manager.set_experiment
        enabled.openai.autolog = manager.autolog

        from adsb_simulation_agent.tracing import setup_tracing

        setup_tracing()
        assert manager.mock_calls == [
            call.set_tracking_uri("http://localhost:5010"),
            call.set_experiment("adsb-agent"),
            call.autolog(),
        ]


# ---------------------------------------------------------------------------
# make_span()
# ---------------------------------------------------------------------------


class TestMakeSpan:
    def test_disabled_yields_none(self, disabled):
        from adsb_simulation_agent.tracing import make_span

        with make_span("x") as span:
            assert span is None

    def test_enabled_delegates_to_start_span(self, enabled):
        from adsb_simulation_agent.tracing import SpanType, make_span

        make_span("plan_route", SpanType.CHAIN)
        enabled.start_span.assert_called_once_with(name="plan_route", span_type="CHAIN")

    def test_span_creation_failure_degrades_to_nullcontext(self, enabled):
        """A broken tracer must never break trajectory generation."""
        enabled.start_span.side_effect = RuntimeError("tracer exploded")
        from adsb_simulation_agent.tracing import make_span

        with make_span("plan_route") as span:
            assert span is None


class TestSpanTypeConstants:
    """Our constants are plain strings so hot modules never import mlflow.

    This test is the guard against that decision drifting: the values must stay
    identical to mlflow's own enum.
    """

    def test_match_mlflow_span_type_enum(self):
        _eject()
        mlflow_entities = pytest.importorskip("mlflow.entities")
        from adsb_simulation_agent.tracing import SpanType

        for name in ("AGENT", "CHAIN", "PARSER", "TOOL"):
            assert getattr(SpanType, name) == getattr(mlflow_entities.SpanType, name)


# ---------------------------------------------------------------------------
# tracing_scope() — the distributed-tracing link
# ---------------------------------------------------------------------------


class TestTracingScope:
    def test_disabled_is_a_noop(self, disabled):
        from adsb_simulation_agent.tracing import tracing_scope

        with tracing_scope({"traceparent": "00-abc-def-01"}):
            pass  # must not raise

    def test_without_traceparent_does_not_call_mlflow(self, enabled):
        """No inbound context means this service is the root of its own trace."""
        from adsb_simulation_agent.tracing import tracing_scope

        with tracing_scope({"content-type": "application/json"}):
            pass
        enabled.tracing.set_tracing_context_from_http_request_headers.assert_not_called()

    def test_with_traceparent_enters_the_mlflow_context(self, enabled):
        from adsb_simulation_agent.tracing import tracing_scope

        headers = {"traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"}
        with tracing_scope(headers):
            pass
        assert enabled.tracing.entered == [headers]

    def test_traceparent_header_match_is_case_insensitive(self, enabled):
        """HTTP headers are case-insensitive; ASGI may hand us either form."""
        from adsb_simulation_agent.tracing import tracing_scope

        with tracing_scope({"TraceParent": "00-abc-def-01"}):
            pass
        enabled.tracing.set_tracing_context_from_http_request_headers.assert_called_once()

    def test_mlflow_failure_degrades_to_noop(self, enabled):
        from adsb_simulation_agent.tracing import tracing_scope

        enabled.tracing.set_tracing_context_from_http_request_headers.side_effect = RuntimeError(
            "bad traceparent"
        )
        with tracing_scope({"traceparent": "garbage"}):
            pass  # must not raise


class TestSpanFlushing:
    """Regression: linked requests silently lost their outermost span.

    MLflow's `set_tracing_context_from_http_request_headers` calls `pop_trace`
    in its `finally`. Spans still queued in the OTel batch processor at that
    moment can no longer be resolved to a trace, and the exporter drops them
    without a word — always the outermost span, since it ends last, orphaning
    every child. So the flush must happen *inside* the scope.
    """

    def test_flushes_before_leaving_the_scope(self, enabled):
        order: list[str] = []
        enabled.flush_trace_async_logging.side_effect = lambda: order.append("flush")

        from adsb_simulation_agent.tracing import tracing_scope

        original = enabled.tracing.set_tracing_context_from_http_request_headers

        @contextmanager
        def _tracked(headers):
            with original(headers):
                yield
            order.append("scope-exit")

        enabled.tracing.set_tracing_context_from_http_request_headers = _tracked

        with tracing_scope({"traceparent": "00-abc-def-01"}):
            order.append("work")

        assert order == ["work", "flush", "scope-exit"]

    def test_no_flush_when_unlinked(self, enabled):
        """Nothing to rescue: an unlinked trace is popped by its own root span."""
        from adsb_simulation_agent.tracing import tracing_scope

        with tracing_scope({}):
            pass
        enabled.flush_trace_async_logging.assert_not_called()

    def test_flush_failure_is_swallowed(self, enabled):
        from adsb_simulation_agent.tracing import tracing_scope

        enabled.flush_trace_async_logging.side_effect = RuntimeError("exporter down")
        with tracing_scope({"traceparent": "00-abc-def-01"}):
            pass  # must not raise

    def test_disabled_does_not_flush(self, disabled):
        from adsb_simulation_agent.tracing import flush_spans

        flush_spans()  # must not raise, must not import mlflow


class TestIsLinked:
    """Whether we joined a caller's trace decides if trace-level tagging is safe.

    ``update_current_trace`` mutates the WHOLE trace — calling it while linked
    would clobber the caller's session_id and tags.
    """

    def test_false_by_default(self):
        from adsb_simulation_agent.tracing import is_linked

        assert is_linked() is False

    def test_true_inside_a_linked_scope(self, enabled):
        from adsb_simulation_agent.tracing import is_linked, tracing_scope

        with tracing_scope({"traceparent": "00-abc-def-01"}):
            assert is_linked() is True

    def test_false_inside_an_unlinked_scope(self, enabled):
        from adsb_simulation_agent.tracing import is_linked, tracing_scope

        with tracing_scope({}):
            assert is_linked() is False

    def test_resets_after_the_scope_exits(self, enabled):
        from adsb_simulation_agent.tracing import is_linked, tracing_scope

        with tracing_scope({"traceparent": "00-abc-def-01"}):
            pass
        assert is_linked() is False


class TestTagRootTrace:
    def test_tags_when_not_linked(self, enabled):
        from adsb_simulation_agent.tracing import tag_root_trace

        tag_root_trace(client_request_id="task-1", agent="adsb-simulation-agent")
        enabled.update_current_trace.assert_called_once_with(
            client_request_id="task-1",
            tags={"agent": "adsb-simulation-agent"},
        )

    def test_silent_when_linked(self, enabled):
        """The caller owns the trace's identity; we must not overwrite it."""
        from adsb_simulation_agent.tracing import tag_root_trace, tracing_scope

        with tracing_scope({"traceparent": "00-abc-def-01"}):
            tag_root_trace(client_request_id="task-1", agent="adsb-simulation-agent")
        enabled.update_current_trace.assert_not_called()

    def test_disabled_is_a_noop(self, disabled):
        from adsb_simulation_agent.tracing import tag_root_trace

        tag_root_trace(client_request_id="task-1")  # must not raise

    def test_failure_is_swallowed(self, enabled):
        from adsb_simulation_agent.tracing import tag_root_trace

        enabled.update_current_trace.side_effect = RuntimeError("no active trace")
        tag_root_trace(client_request_id="task-1")  # must not raise
