"""Propagating this agent's trace context to the simulation agent.

MLflow follows W3C TraceContext, so linking the two services is header
propagation on the one outgoing A2A call. Without this, a chat turn that
generates trajectories produces two unrelated traces instead of one.
"""

from __future__ import annotations

import httpx
import pytest

from adsb_agent.a2a_client import A2A_VERSION, A2A_VERSION_HEADER, call_simulation_agent

ARGS = {"originLat": 45.5, "originLng": -73.6, "category": "ga"}

TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"


def _completed_task_response() -> dict:
    return {
        "jsonrpc": "2.0",
        "id": "1",
        "result": {
            "task": {
                "status": {"state": "TASK_STATE_COMPLETED"},
                "artifacts": [
                    {"parts": [{"data": {"aircraft": [], "summary": "0 aircraft generated"}}]}
                ],
            }
        },
    }


@pytest.fixture
def sent():
    """An httpx client that records the request instead of sending it."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_completed_task_response())

    transport = httpx.MockTransport(handler)
    return seen, httpx.AsyncClient(transport=transport)


@pytest.fixture
def with_headers(monkeypatch):
    """Pretend an active trace exists, yielding a traceparent."""
    import mlflow.tracing

    from adsb_agent.config import settings

    monkeypatch.setattr(settings, "mlflow_enabled", True)
    monkeypatch.setattr(
        mlflow.tracing,
        "get_tracing_context_headers_for_http_request",
        lambda: {"traceparent": TRACEPARENT},
    )


class TestPanelPathRootSpan:
    """`POST /simulate/trajectory` bypasses the chat pipeline entirely.

    Without a root span here there would be no active trace, so no traceparent
    to propagate — and panel-initiated generations would produce orphan traces
    even though the chat path is fully linked.
    """

    @pytest.fixture
    def spans(self, monkeypatch):
        import mlflow

        from adsb_agent.config import settings

        monkeypatch.setattr(settings, "mlflow_enabled", True)
        opened: list[tuple[str, str]] = []

        class _Span:
            def set_inputs(self, _v): ...
            def set_outputs(self, _v): ...
            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

        def _start(name, span_type):
            opened.append((name, span_type))
            return _Span()

        monkeypatch.setattr(mlflow, "start_span", _start)
        return opened

    @pytest.fixture
    def api(self, monkeypatch):
        from fastapi.testclient import TestClient

        import adsb_agent.main as main_module
        from adsb_agent.a2a_client import TrajectoryResult

        async def fake_call(_args, _client):
            return TrajectoryResult(
                ok=True, summary="1 aircraft generated", data={"aircraft": [{}], "violations": []}
            )

        monkeypatch.setattr(main_module, "call_simulation_agent", fake_call)
        return TestClient(main_module.app)

    def test_opens_a_root_span(self, api, spans):
        response = api.post(
            "/simulate/trajectory",
            json={"category": "ga", "originLat": 45.5, "originLng": -73.6},
        )
        assert response.status_code == 200
        assert ("simulate_trajectory_request", "CHAIN") in spans


class TestTracingHeaders:
    def test_returns_the_current_trace_context(self, with_headers):
        from adsb_agent.tracing import tracing_headers

        assert tracing_headers() == {"traceparent": TRACEPARENT}

    def test_empty_when_disabled(self, monkeypatch, with_headers):
        from adsb_agent.config import settings

        monkeypatch.setattr(settings, "mlflow_enabled", False)
        from adsb_agent.tracing import tracing_headers

        assert tracing_headers() == {}

    def test_empty_when_mlflow_raises(self, monkeypatch):
        """No active trace is the normal case outside a request, not an error."""
        import mlflow.tracing

        from adsb_agent.config import settings

        monkeypatch.setattr(settings, "mlflow_enabled", True)

        def _boom():
            raise RuntimeError("no active trace")

        monkeypatch.setattr(
            mlflow.tracing, "get_tracing_context_headers_for_http_request", _boom
        )
        from adsb_agent.tracing import tracing_headers

        assert tracing_headers() == {}


class TestA2ACallHeaders:
    async def test_sends_the_traceparent(self, sent, with_headers):
        seen, client = sent
        async with client:
            await call_simulation_agent(ARGS, client)
        assert seen[0].headers["traceparent"] == TRACEPARENT

    async def test_keeps_the_a2a_version_header(self, sent, with_headers):
        """Non-negotiable: without it the server rejects the call outright."""
        seen, client = sent
        async with client:
            await call_simulation_agent(ARGS, client)
        assert seen[0].headers[A2A_VERSION_HEADER] == A2A_VERSION

    async def test_no_traceparent_when_tracing_is_off(self, sent, monkeypatch):
        from adsb_agent.config import settings

        monkeypatch.setattr(settings, "mlflow_enabled", False)
        seen, client = sent
        async with client:
            await call_simulation_agent(ARGS, client)
        assert "traceparent" not in seen[0].headers
        assert seen[0].headers[A2A_VERSION_HEADER] == A2A_VERSION

    async def test_call_still_succeeds(self, sent, with_headers):
        """Propagation must be invisible to the result."""
        seen, client = sent
        async with client:
            result = await call_simulation_agent(ARGS, client)
        assert result.ok
