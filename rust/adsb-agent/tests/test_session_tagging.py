"""Tests for MLflow session tagging — every agent run tags its trace with
``mlflow.trace.session`` set to the AG-UI ``thread_id``.

Mocking strategy mirrors test_tracing.py: ``mlflow`` is injected into
``sys.modules`` so the tests never require a real MLflow server.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mlflow_mock() -> MagicMock:
    """Build a minimal mlflow mock satisfying tracing.py + session tagging."""
    m = MagicMock(name="mlflow")
    m.openai = MagicMock(name="mlflow.openai")
    m.openai.autolog = MagicMock()
    m.set_tracking_uri = MagicMock()
    m.set_experiment = MagicMock()
    m.update_current_trace = MagicMock()
    # start_span must work as a sync context manager
    span_cm = MagicMock(name="span_cm")
    span_cm.__enter__ = MagicMock(return_value=MagicMock(name="span"))
    span_cm.__exit__ = MagicMock(return_value=False)
    m.start_span = MagicMock(return_value=span_cm)
    return m


def _inject(mock: MagicMock) -> None:
    sys.modules["mlflow"] = mock
    sys.modules["mlflow.openai"] = mock.openai


def _eject() -> None:
    sys.modules.pop("mlflow", None)
    sys.modules.pop("mlflow.openai", None)
    sys.modules.pop("adsb_agent.tracing", None)


# ---------------------------------------------------------------------------
# Unit tests — set_session_tag helper
# ---------------------------------------------------------------------------

class TestSetSessionTagDisabled:
    def setup_method(self):
        _eject()

    def teardown_method(self):
        _eject()

    def test_disabled_does_not_import_mlflow(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", False)

        poison = MagicMock(side_effect=ImportError("must not be imported"))
        sys.modules["mlflow"] = poison  # type: ignore[assignment]

        from adsb_agent.tracing import set_session_tag
        set_session_tag("any-thread")  # must not raise

        poison.update_current_trace.assert_not_called()

    def test_disabled_returns_none(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", False)

        from adsb_agent.tracing import set_session_tag
        assert set_session_tag("any-thread") is None


class TestSetSessionTagEnabled:
    def setup_method(self):
        _eject()

    def teardown_method(self):
        _eject()

    def test_tags_session_from_thread_id(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.tracing import set_session_tag
        set_session_tag("thread-abc")

        mock.update_current_trace.assert_called_once_with(session_id="thread-abc")

    def test_extra_tags_merged(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)

        mock = _make_mlflow_mock()
        _inject(mock)

        from adsb_agent.tracing import set_session_tag
        set_session_tag("thread-abc", run_id="run-xyz")

        mock.update_current_trace.assert_called_once_with(
            session_id="thread-abc", tags={"run_id": "run-xyz"}
        )

    def test_exception_in_mlflow_is_swallowed(self, monkeypatch):
        from adsb_agent.config import settings
        monkeypatch.setattr(settings, "mlflow_enabled", True)

        mock = _make_mlflow_mock()
        mock.update_current_trace.side_effect = RuntimeError("boom")
        _inject(mock)

        from adsb_agent.tracing import set_session_tag
        # Must not raise — tagging is non-fatal
        set_session_tag("thread-abc")


# ---------------------------------------------------------------------------
# Integration test — /ag-ui/chat tags the trace
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    from adsb_agent.main import app
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


async def test_chat_endpoint_tags_trace_with_thread_id(client: AsyncClient, monkeypatch):
    """POST /ag-ui/chat with explicit thread_id → trace tagged with that thread_id."""
    from adsb_agent.config import settings
    monkeypatch.setattr(settings, "mlflow_enabled", True)

    mock = _make_mlflow_mock()
    _inject(mock)
    # Force tracing module to re-bind to fresh mlflow mock
    sys.modules.pop("adsb_agent.tracing", None)

    import adsb_agent.main as main_mod
    from ag_ui.core import (
        EventType,
        TextMessageContentEvent,
        TextMessageEndEvent,
        TextMessageStartEvent,
    )

    async def mock_stream(*args, **kwargs):
        yield TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id="m",
            role="assistant",
        )
        yield TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id="m",
            delta="hi",
        )
        yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id="m")

    monkeypatch.setattr(main_mod, "stream_llm_response", mock_stream)

    resp = await client.post(
        "/ag-ui/chat",
        json={
            "threadId": "thread-fixed",
            "runId": "run-fixed",
            "messages": [{"id": "m1", "role": "user", "content": "hi"}],
            "tools": [],
            "context": [],
            "state": {},
            "forwardedProps": {},
        },
    )

    assert resp.status_code == 200
    # Drain the stream so the generator runs to completion
    _ = resp.text

    mock.update_current_trace.assert_called_once()
    kwargs = mock.update_current_trace.call_args.kwargs
    assert kwargs["session_id"] == "thread-fixed"
    assert kwargs["tags"]["run_id"] == "run-fixed"

    # And the root span was created and had inputs/outputs attached so the
    # trace's Request/Response columns are populated.
    mock.start_span.assert_called_once()
    span_kwargs = mock.start_span.call_args.kwargs
    assert span_kwargs.get("name") == "chat_turn"

    span_obj = mock.start_span.return_value.__enter__.return_value
    span_obj.set_inputs.assert_called_once()
    inputs = span_obj.set_inputs.call_args.args[0]
    assert inputs["thread_id"] == "thread-fixed"
    assert inputs["run_id"] == "run-fixed"
    assert inputs["messages"] == [{"role": "user", "content": "hi"}]

    span_obj.set_outputs.assert_called_once()
    outputs = span_obj.set_outputs.call_args.args[0]
    assert outputs["text"] == "hi"
    assert outputs["errored"] is False

    _eject()


# ---------------------------------------------------------------------------
# Voice — /voice/start forwards session_id to the backend instance, which the
# transcribe spans then pass to set_session_tag.
# ---------------------------------------------------------------------------

async def test_voice_start_sets_session_id_on_backend(client: AsyncClient):
    """POST /voice/start {session_id} → active backend.session_id is populated.

    The actual MLflow tagging happens inside the transcribe span at /voice/stop
    time; this test pins the wiring contract.
    """
    import adsb_agent.main as main_mod
    from unittest.mock import AsyncMock, MagicMock

    fake = MagicMock()
    fake.start_listening = AsyncMock()
    fake.stop_listening = AsyncMock()
    fake.session_id = None
    main_mod._voice_backends["voxtral"] = fake
    main_mod._active_voice_backend = None

    try:
        resp = await client.post(
            "/voice/start",
            json={"backend": "voxtral", "session_id": "thread-voice"},
        )
        assert resp.status_code == 200
        assert fake.session_id == "thread-voice"
        fake.start_listening.assert_awaited_once()
    finally:
        main_mod._active_voice_backend = None


async def test_voice_start_without_session_id_clears_backend_field(client: AsyncClient):
    import adsb_agent.main as main_mod
    from unittest.mock import AsyncMock, MagicMock

    fake = MagicMock()
    fake.start_listening = AsyncMock()
    fake.stop_listening = AsyncMock()
    fake.session_id = "stale-from-previous-run"
    main_mod._voice_backends["voxtral"] = fake
    main_mod._active_voice_backend = None

    try:
        resp = await client.post("/voice/start", json={"backend": "voxtral"})
        assert resp.status_code == 200
        # session_id defaults to None and must overwrite any stale value
        assert fake.session_id is None
    finally:
        main_mod._active_voice_backend = None


def test_voxtral_backend_has_session_id_attribute():
    from adsb_agent.voice.voxtral import VoxtralBackend

    backend = VoxtralBackend()
    assert hasattr(backend, "session_id")
    assert backend.session_id is None


def test_lfm2_backend_has_session_id_attribute():
    from adsb_agent.voice.lfm2_audio import LFM2AudioBackend

    backend = LFM2AudioBackend(model_dir="/nonexistent")
    assert hasattr(backend, "session_id")
    assert backend.session_id is None
