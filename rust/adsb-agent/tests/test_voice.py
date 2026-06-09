"""Tests for voice subsystem — backend protocol, audio capture, Voxtral, LFM2.5."""

from __future__ import annotations

import pytest

from unittest.mock import AsyncMock, MagicMock, patch

from adsb_agent.voice.audio_capture import AudioCapture
from adsb_agent.voice.base import (
    BackendInfo,
    TranscriptChunk,
    VoiceBackendStatus,
)
from adsb_agent.voice.voxtral import VoxtralBackend
from adsb_agent.voice.lfm2_audio import LFM2AudioBackend


# ---------------------------------------------------------------------------
# TranscriptChunk dataclass
# ---------------------------------------------------------------------------
class TestTranscriptChunk:
    def test_defaults(self):
        chunk = TranscriptChunk(text="hello")
        assert chunk.text == "hello"
        assert chunk.is_final is False
        assert chunk.confidence is None

    def test_final_chunk(self):
        chunk = TranscriptChunk(text="done.", is_final=True, confidence=0.95)
        assert chunk.is_final is True
        assert chunk.confidence == 0.95


# ---------------------------------------------------------------------------
# BackendInfo dataclass
# ---------------------------------------------------------------------------
class TestBackendInfo:
    def test_creation(self):
        info = BackendInfo(
            name="test",
            description="Test backend",
            status=VoiceBackendStatus.READY,
            supports_end_to_end=False,
        )
        assert info.name == "test"
        assert info.status == VoiceBackendStatus.READY
        assert info.extra == {}

    def test_with_extras(self):
        info = BackendInfo(
            name="test",
            description="Test",
            status=VoiceBackendStatus.NOT_READY,
            supports_end_to_end=True,
            model_size="1.5B",
            extra={"port": 8081},
        )
        assert info.model_size == "1.5B"
        assert info.extra["port"] == 8081


# ---------------------------------------------------------------------------
# VoiceBackendStatus enum
# ---------------------------------------------------------------------------
class TestVoiceBackendStatus:
    def test_values(self):
        assert VoiceBackendStatus.NOT_READY.value == "not_ready"
        assert VoiceBackendStatus.READY.value == "ready"
        assert VoiceBackendStatus.LISTENING.value == "listening"
        assert VoiceBackendStatus.ERROR.value == "error"


# ---------------------------------------------------------------------------
# VoxtralBackend
# ---------------------------------------------------------------------------
class TestVoxtralBackend:
    def test_not_ready_when_binary_missing(self):
        backend = VoxtralBackend(
            binary_path="/nonexistent/voxtral",
            model_dir="/nonexistent/model",
        )
        assert backend.name == "voxtral"
        assert not backend.supports_end_to_end

    @pytest.mark.asyncio
    async def test_get_status_not_ready(self):
        backend = VoxtralBackend(
            binary_path="/nonexistent/voxtral",
            model_dir="/nonexistent/model",
        )
        status = await backend.get_status()
        assert status == VoiceBackendStatus.NOT_READY

    @pytest.mark.asyncio
    async def test_get_info(self):
        backend = VoxtralBackend(
            binary_path="/nonexistent/voxtral",
            model_dir="/nonexistent/model",
        )
        info = await backend.get_info()
        assert info.name == "voxtral"
        assert info.supports_end_to_end is False
        assert "8.9 GB" in info.model_size

    @pytest.mark.asyncio
    async def test_start_listening_raises_when_not_ready(self):
        backend = VoxtralBackend(
            binary_path="/nonexistent/voxtral",
            model_dir="/nonexistent/model",
        )
        with pytest.raises(RuntimeError, match="not ready"):
            await backend.start_listening()

    @pytest.mark.asyncio
    async def test_stop_listening_when_not_started(self):
        backend = VoxtralBackend(
            binary_path="/nonexistent/voxtral",
            model_dir="/nonexistent/model",
        )
        # Should not raise
        await backend.stop_listening()

    @pytest.mark.asyncio
    async def test_start_listening_clears_stale_last_transcript(self):
        """start_listening must wipe any prior recording's transcript so it
        cannot leak into the next /voice/stop response — even when start
        fails because the backend is not ready."""
        backend = VoxtralBackend(
            binary_path="/nonexistent/voxtral",
            model_dir="/nonexistent/model",
        )
        # Simulate prior recording's residue
        backend._last_transcript = "stale-from-previous-recording"
        with pytest.raises(RuntimeError, match="not ready"):
            await backend.start_listening()
        assert backend._last_transcript is None

    @pytest.mark.asyncio
    async def test_reader_done_event_lifecycle(self):
        """_reader_done event should be set initially and after stream ends."""
        backend = VoxtralBackend(
            binary_path="/nonexistent/voxtral",
            model_dir="/nonexistent/model",
        )
        # Initially set (no reader active)
        assert backend._reader_done.is_set()

        # After stop_listening (no process), should still be set
        await backend.stop_listening()
        assert backend._reader_done.is_set()


# ---------------------------------------------------------------------------
# LFM2AudioBackend
# ---------------------------------------------------------------------------
class TestLFM2AudioBackend:
    def test_not_ready_when_model_missing(self):
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        assert backend.name == "lfm2-audio"
        assert backend.supports_end_to_end is True

    @pytest.mark.asyncio
    async def test_get_status_not_ready(self):
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        status = await backend.get_status()
        assert status == VoiceBackendStatus.NOT_READY

    @pytest.mark.asyncio
    async def test_get_info(self):
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        info = await backend.get_info()
        assert info.name == "lfm2-audio"
        assert info.supports_end_to_end is True

    @pytest.mark.asyncio
    async def test_start_listening_raises_when_not_ready(self):
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        with pytest.raises(RuntimeError, match="not found"):
            await backend.start_listening()

    @pytest.mark.asyncio
    async def test_start_listening_clears_stale_last_transcript(self):
        """start_listening must wipe any prior recording's transcript so it
        cannot leak into the next /voice/stop response."""
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        backend._last_transcript = "stale-from-previous-recording"
        with pytest.raises(RuntimeError, match="not found"):
            await backend.start_listening()
        assert backend._last_transcript is None

    @pytest.mark.asyncio
    async def test_ensure_server_uses_liquid_audio_flags(self):
        """_ensure_server() must pass all 4 model files to llama-liquid-audio-server."""
        import asyncio

        backend = LFM2AudioBackend(model_dir="/fake/lfm2", quant="Q4_0")
        captured_cmd: list[str] = []

        async def mock_create_subprocess(*cmd, **kwargs):
            captured_cmd.extend(cmd)
            proc = AsyncMock()
            proc.returncode = None
            return proc

        with patch.object(asyncio, "create_subprocess_exec", side_effect=mock_create_subprocess), \
             patch.object(backend, "_wait_for_server_ready", AsyncMock()):
            await backend._ensure_server()

        assert "-m" in captured_cmd
        assert "-mm" in captured_cmd
        assert "-mv" in captured_cmd
        assert "--tts-speaker-file" in captured_cmd
        assert "--port" in captured_cmd
        assert any("LFM2.5-Audio-1.5B-Q4_0.gguf" in arg for arg in captured_cmd)
        assert any("mmproj-" in arg for arg in captured_cmd)
        assert any("vocoder-" in arg for arg in captured_cmd)
        assert any("tokenizer-" in arg for arg in captured_cmd)


# ---------------------------------------------------------------------------
# AudioCapture — async wrapping of sounddevice
# ---------------------------------------------------------------------------
class TestAudioCapture:
    @pytest.mark.asyncio
    async def test_start_offloads_to_thread(self):
        """AudioCapture.start() should offload stream open+start to a thread."""
        import asyncio
        capture = AudioCapture()
        calls = []

        async def spy_to_thread(fn, *args, **kwargs):
            calls.append(fn)
            return fn(*args, **kwargs)

        mock_stream = MagicMock()
        with patch.object(asyncio, "to_thread", side_effect=spy_to_thread), \
             patch("sounddevice.InputStream", return_value=mock_stream):
            await capture.start()
        assert len(calls) == 1, f"Expected 1 to_thread call, got {len(calls)}"
        # The stream should have been started
        mock_stream.start.assert_called_once()
        await capture.stop()

    @pytest.mark.asyncio
    async def test_stop_offloads_to_thread(self):
        """AudioCapture.stop() should offload stream stop+close to a thread."""
        import asyncio
        capture = AudioCapture()
        mock_stream = MagicMock()
        capture._stream = mock_stream
        capture._running = True
        calls = []

        async def spy_to_thread(fn, *args, **kwargs):
            calls.append(fn)
            return fn(*args, **kwargs)

        with patch.object(asyncio, "to_thread", side_effect=spy_to_thread):
            await capture.stop()
        assert len(calls) == 1, f"Expected 1 to_thread call, got {len(calls)}"
        mock_stream.stop.assert_called_once()
        mock_stream.close.assert_called_once()


    @pytest.mark.asyncio
    async def test_start_drains_stale_queue_from_previous_session(self):
        """REGRESSION: leftover audio chunks and the None sentinel from a prior
        stop() must not survive into the next start() — otherwise the next
        recording's _collect_audio reads stale audio and exits early on None,
        leaking the prior recording's audio into the new transcription."""
        import numpy as np

        capture = AudioCapture()
        # Simulate residue from a previous stop(): a couple of audio chunks
        # plus the None end-of-stream sentinel.
        stale_chunk_a = np.zeros(1600, dtype=np.int16)
        stale_chunk_b = np.ones(1600, dtype=np.int16)
        capture._queue.put_nowait(stale_chunk_a)
        capture._queue.put_nowait(stale_chunk_b)
        capture._queue.put_nowait(None)
        assert capture._queue.qsize() == 3

        mock_stream = MagicMock()
        with patch("sounddevice.InputStream", return_value=mock_stream):
            await capture.start()

        # After start(), the queue must be empty so that the new session's
        # _collect_audio only sees fresh audio.
        assert capture._queue.empty(), (
            f"queue should be empty after start(), got qsize={capture._queue.qsize()}"
        )

        await capture.stop()


# ---------------------------------------------------------------------------
# Async _check_ready
# ---------------------------------------------------------------------------
class TestAsyncCheckReady:
    @pytest.mark.asyncio
    async def test_voxtral_start_uses_async_check(self):
        """Voxtral start_listening should use async _acheck_ready."""
        import asyncio
        backend = VoxtralBackend(
            binary_path="/nonexistent/voxtral",
            model_dir="/nonexistent/model",
        )
        calls = []
        original_to_thread = asyncio.to_thread

        async def spy_to_thread(fn, *args, **kwargs):
            calls.append(fn.__name__ if hasattr(fn, '__name__') else str(fn))
            return await original_to_thread(fn, *args, **kwargs)

        with patch.object(asyncio, "to_thread", side_effect=spy_to_thread):
            # Will still raise (not ready) but should go through async path
            with pytest.raises(RuntimeError):
                await backend.start_listening()
        assert "_check_ready" in calls

    @pytest.mark.asyncio
    async def test_lfm2_start_uses_async_check(self):
        """LFM2 start_listening should use async _acheck_ready."""
        import asyncio
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        calls = []
        original_to_thread = asyncio.to_thread

        async def spy_to_thread(fn, *args, **kwargs):
            calls.append(fn.__name__ if hasattr(fn, '__name__') else str(fn))
            return await original_to_thread(fn, *args, **kwargs)

        with patch.object(asyncio, "to_thread", side_effect=spy_to_thread):
            with pytest.raises(RuntimeError):
                await backend.start_listening()
        assert "_check_ready" in calls


# ---------------------------------------------------------------------------
# LFM2AudioBackend — health-check polling
# ---------------------------------------------------------------------------
class TestLFM2HealthCheck:
    @pytest.mark.asyncio
    async def test_wait_for_server_polls_health(self):
        """_wait_for_server_ready should poll /health and return on any HTTP response.
        llama-liquid-audio-server has no /health endpoint (returns 404), so any
        HTTP response (not ConnectError) means the server is up."""
        import httpx

        backend = LFM2AudioBackend(model_dir="/nonexistent")
        call_count = 0

        async def mock_get(url, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise httpx.ConnectError("not ready")
            resp = MagicMock()
            resp.status_code = 404  # llama-liquid-audio-server returns 404 for /health
            return resp

        with patch("httpx.AsyncClient") as mock_client_cls:
            instance = AsyncMock()
            instance.get = mock_get
            instance.__aenter__ = AsyncMock(return_value=instance)
            instance.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = instance

            await backend._wait_for_server_ready(timeout=5.0)
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_wait_for_server_timeout_raises(self):
        """_wait_for_server_ready should raise RuntimeError on timeout."""
        import httpx

        backend = LFM2AudioBackend(model_dir="/nonexistent")

        async def mock_get(url, **kwargs):
            raise httpx.ConnectError("not ready")

        with patch("httpx.AsyncClient") as mock_client_cls:
            instance = AsyncMock()
            instance.get = mock_get
            instance.__aenter__ = AsyncMock(return_value=instance)
            instance.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = instance

            with pytest.raises(RuntimeError, match="not ready after"):
                await backend._wait_for_server_ready(timeout=0.3)


# ---------------------------------------------------------------------------
# Voice endpoint tests (FastAPI)
# ---------------------------------------------------------------------------
class TestLifespan:
    @pytest.mark.asyncio
    async def test_lifespan_initializes_backends(self):
        """Lifespan context manager should populate _voice_backends."""
        import adsb_agent.main as main_mod
        from adsb_agent.main import app, lifespan

        # Clear any leftover state
        main_mod._voice_backends.clear()
        assert len(main_mod._voice_backends) == 0

        async with lifespan(app):
            assert "voxtral" in main_mod._voice_backends
            assert "lfm2-audio" in main_mod._voice_backends

        # After shutdown, backends are cleared
        assert len(main_mod._voice_backends) == 0

    @pytest.mark.asyncio
    async def test_lifespan_shutdown_stops_active_backend(self):
        """Lifespan shutdown should stop any active voice backend."""
        import adsb_agent.main as main_mod
        from adsb_agent.main import app, lifespan

        main_mod._voice_backends.clear()

        async with lifespan(app):
            # Simulate an active backend
            mock_backend = AsyncMock()
            mock_backend.stop_listening = AsyncMock()
            main_mod._active_voice_backend = mock_backend

        mock_backend.stop_listening.assert_called_once()
        assert main_mod._active_voice_backend is None

    @pytest.mark.asyncio
    async def test_lifespan_sets_shutdown_event(self):
        """_shutdown_event must be set during lifespan teardown so SSE generators can exit."""
        import adsb_agent.main as main_mod
        from adsb_agent.main import app, lifespan

        main_mod._voice_backends.clear()

        async with lifespan(app):
            # During startup the event must exist and NOT be set
            assert main_mod._shutdown_event is not None
            assert not main_mod._shutdown_event.is_set()

        # After shutdown it must be set
        assert main_mod._shutdown_event.is_set()


class TestVoiceEndpoints:
    @pytest.fixture
    def client(self):
        from httpx import ASGITransport, AsyncClient
        from adsb_agent.main import app
        import adsb_agent.main as main_mod
        # Manually init backends (ASGITransport doesn't trigger lifespan)
        if not main_mod._voice_backends:
            main_mod._voice_backends["voxtral"] = VoxtralBackend()
            main_mod._voice_backends["lfm2-audio"] = LFM2AudioBackend()
        transport = ASGITransport(app=app)
        return AsyncClient(transport=transport, base_url="http://test")

    @pytest.mark.asyncio
    async def test_list_backends(self, client):
        response = await client.get("/voice/backends")
        assert response.status_code == 200
        data = response.json()
        assert "backends" in data
        assert "voxtral" in data["backends"]
        assert "lfm2-audio" in data["backends"]

    @pytest.mark.asyncio
    async def test_voice_status(self, client):
        response = await client.get("/voice/status")
        assert response.status_code == 200
        data = response.json()
        assert "active_backend" in data
        assert "backends" in data

    @pytest.mark.asyncio
    async def test_start_unknown_backend(self, client):
        response = await client.post(
            "/voice/start",
            json={"backend": "nonexistent"},
        )
        # VoiceStartRequest uses Literal["voxtral", "lfm2-audio"] — Pydantic rejects
        # invalid values before the handler runs, so FastAPI returns 422
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_stop_when_not_listening(self, client):
        response = await client.post("/voice/stop")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "not_listening"


# ---------------------------------------------------------------------------
# Error handling: unhandled exceptions surface as VoiceErrorResponse
# ---------------------------------------------------------------------------
class TestTranscriptSSEContract:
    """Verify /voice/transcript always returns a proper SSE stream."""

    @pytest.mark.asyncio
    async def test_transcript_stream_no_backend_returns_sse_error(self):
        """GET /voice/transcript with no active backend must return text/event-stream,
        not a JSON dict. A bare dict causes EventSource to error immediately."""
        from httpx import ASGITransport, AsyncClient
        from adsb_agent.main import app
        import adsb_agent.main as main_mod

        saved = main_mod._active_voice_backend
        main_mod._active_voice_backend = None
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.get("/voice/transcript")
        finally:
            main_mod._active_voice_backend = saved

        assert response.status_code == 200
        assert "text/event-stream" in response.headers.get("content-type", "")
        assert "error" in response.text

    @pytest.mark.asyncio
    async def test_lfm2_transcribe_calls_chat_completions_endpoint(self):
        """_transcribe() must use /v1/chat/completions (streaming) with ASR system
        prompt and input_audio content, returning the concatenated delta text."""
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        backend._audio_buffer = [b"\x00\x01" * 800] * 10

        # Build SSE lines a real server would emit
        sse_lines = [
            'data: {"choices":[{"index":0,"delta":{"content":"hello "},"finish_reason":null}]}',
            'data: {"choices":[{"index":0,"delta":{"content":"from lfm2"},"finish_reason":null}]}',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
        ]

        async def fake_aiter_lines():
            for line in sse_lines:
                yield line

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.aiter_lines = fake_aiter_lines
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_stream = MagicMock()
        mock_stream.return_value = mock_response

        with patch("httpx.AsyncClient") as mock_client_cls:
            instance = MagicMock()
            instance.stream = mock_stream
            instance.__aenter__ = AsyncMock(return_value=instance)
            instance.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = instance

            result = await backend._transcribe()

        assert result == "hello from lfm2"
        assert backend._audio_buffer == [], "Buffer should be cleared after transcription"
        # Verify the correct endpoint and payload
        call_args = mock_stream.call_args
        assert call_args.args[1].endswith("/v1/chat/completions")
        payload = call_args.kwargs["json"]
        assert payload["stream"] is True
        assert payload["messages"][0]["content"] == "Perform ASR."
        assert payload["messages"][1]["content"][0]["type"] == "input_audio"

    @pytest.mark.asyncio
    async def test_lfm2_transcribe_logs_error_on_non_200(self):
        """_transcribe() returns None and reads the error body on non-200 responses."""
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        backend._audio_buffer = [b"\x00\x01" * 800]

        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.aread = AsyncMock(return_value=b'{"error": "audio format not supported"}')
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_stream = MagicMock()
        mock_stream.return_value = mock_response

        with patch("httpx.AsyncClient") as mock_client_cls:
            instance = MagicMock()
            instance.stream = mock_stream
            instance.__aenter__ = AsyncMock(return_value=instance)
            instance.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = instance

            result = await backend._transcribe()

        assert result is None

    @pytest.mark.asyncio
    async def test_lfm2_transcript_stream_idle_while_recording(self):
        """LFM2 get_transcript_stream() must not yield immediately during recording.
        It should block (idle) until _stopped_event is set by stop_listening().
        Regression for: SSE closing immediately → onerror → button goes off."""
        import asyncio

        backend = LFM2AudioBackend(model_dir="/nonexistent")
        backend._status = VoiceBackendStatus.LISTENING
        backend._stopped_event.clear()  # Simulate active recording

        chunks: list = []

        async def collect():
            async for chunk in backend.get_transcript_stream():
                chunks.append(chunk)

        task = asyncio.create_task(collect())
        # Short wait: if the stream returned immediately (old bug), chunks would
        # already be populated; if idle (correct), chunks stay empty.
        await asyncio.sleep(0.1)
        assert chunks == [], "LFM2 transcript stream must not yield during recording"

        # Unblock: simulate stop_listening() signalling completion
        backend._stopped_event.set()
        await asyncio.wait_for(task, timeout=1.0)
        # Stream exits cleanly with no chunks (transcript comes via _last_transcript)
        assert chunks == []


class TestVoiceErrorHandling:
    """Verify that non-RuntimeError exceptions from voice backends are returned
    as VoiceErrorResponse (not unhandled 500s)."""

    def _make_ready_backend(self) -> LFM2AudioBackend:
        """Create an LFM2AudioBackend whose status is already READY."""
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        backend._status = VoiceBackendStatus.READY
        return backend

    @pytest.mark.asyncio
    async def test_start_voice_sounddevice_portaudio_error(self):
        """OSError (e.g. PortAudioError 'load failed') from AudioCapture.start
        must be returned as VoiceErrorResponse, not cause a 500."""
        from httpx import ASGITransport, AsyncClient
        from adsb_agent.main import app
        import adsb_agent.main as main_mod

        fresh = self._make_ready_backend()
        saved = main_mod._voice_backends.get("lfm2-audio")
        main_mod._voice_backends["lfm2-audio"] = fresh

        try:
            with patch.object(LFM2AudioBackend, "_ensure_server", AsyncMock()), \
                 patch.object(AudioCapture, "start", AsyncMock(side_effect=OSError("load failed"))):
                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as client:
                    response = await client.post("/voice/start", json={"backend": "lfm2-audio"})
        finally:
            if saved is not None:
                main_mod._voice_backends["lfm2-audio"] = saved

        assert response.status_code == 200
        data = response.json()
        assert "error" in data
        assert "load failed" in data["error"]

    @pytest.mark.asyncio
    async def test_start_voice_llama_server_not_found(self):
        """FileNotFoundError from missing llama-server binary must be returned
        as VoiceErrorResponse, not cause a 500."""
        from httpx import ASGITransport, AsyncClient
        from adsb_agent.main import app
        import adsb_agent.main as main_mod

        fresh = self._make_ready_backend()
        saved = main_mod._voice_backends.get("lfm2-audio")
        main_mod._voice_backends["lfm2-audio"] = fresh

        try:
            with patch.object(
                LFM2AudioBackend,
                "_ensure_server",
                AsyncMock(side_effect=FileNotFoundError("No such file or directory: 'llama-server'")),
            ):
                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as client:
                    response = await client.post("/voice/start", json={"backend": "lfm2-audio"})
        finally:
            if saved is not None:
                main_mod._voice_backends["lfm2-audio"] = saved

        assert response.status_code == 200
        data = response.json()
        assert "error" in data

    @pytest.mark.asyncio
    async def test_wait_for_server_early_exit(self):
        """_wait_for_server_ready must detect a crashed process immediately
        (returncode set) instead of waiting for the full timeout."""
        import httpx

        backend = LFM2AudioBackend(model_dir="/nonexistent")
        mock_process = MagicMock()
        mock_process.returncode = 1
        mock_process.stderr.read = AsyncMock(return_value=b"load failed: model not found")
        backend._server_process = mock_process

        with patch("httpx.AsyncClient") as mock_client_cls:
            instance = AsyncMock()
            instance.get = AsyncMock(side_effect=httpx.ConnectError("not ready"))
            instance.__aenter__ = AsyncMock(return_value=instance)
            instance.__aexit__ = AsyncMock(return_value=False)
            mock_client_cls.return_value = instance

            with pytest.raises(RuntimeError, match="llama-server exited"):
                # Use a generous timeout — the fix must raise before it expires
                await backend._wait_for_server_ready(timeout=5.0)


# ---------------------------------------------------------------------------
# MLflow audio attachment logging — LFM2.5-Audio
# ---------------------------------------------------------------------------

class TestLFM2AttachmentLogging:
    """Verify _transcribe() attaches WAV audio to the MLflow span inputs."""

    def _make_sse_mock(self, lines: list[str]):
        """Return (mock_client_cls, mock_stream) wired to emit given SSE lines."""
        async def fake_aiter_lines():
            for line in lines:
                yield line

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.aiter_lines = fake_aiter_lines
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=False)

        mock_stream = MagicMock()
        mock_stream.return_value = mock_response

        mock_client_cls = MagicMock()
        instance = MagicMock()
        instance.stream = mock_stream
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = instance
        return mock_client_cls, mock_stream

    @pytest.mark.asyncio
    async def test_transcribe_logs_audio_attachment_when_tracing_enabled(self):
        """span.set_inputs() must include an audio/wav Attachment when a span is active."""
        from mlflow.tracing.attachments import Attachment

        backend = LFM2AudioBackend(model_dir="/nonexistent")
        backend._audio_buffer = [b"\x00\x01" * 800] * 5

        sse_lines = [
            'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
            "data: [DONE]",
        ]
        mock_client_cls, _ = self._make_sse_mock(sse_lines)

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)

        with patch("httpx.AsyncClient", mock_client_cls), \
             patch("adsb_agent.tracing.make_span", return_value=mock_span):
            result = await backend._transcribe()

        assert result == "hello"
        mock_span.set_inputs.assert_called_once()
        inputs = mock_span.set_inputs.call_args[0][0]
        assert "audio" in inputs, "span.set_inputs() must include 'audio' key"
        assert isinstance(inputs["audio"], Attachment)
        assert inputs["audio"].content_type == "audio/wav"
        assert len(inputs["audio"].content_bytes) > 44  # WAV header alone is 44 bytes

    @pytest.mark.asyncio
    async def test_transcribe_includes_metadata_alongside_attachment(self):
        """span.set_inputs() must still include model and duration_s alongside audio."""
        backend = LFM2AudioBackend(model_dir="/nonexistent")
        backend._audio_buffer = [b"\x00\x00" * 1600]  # 100ms of silence

        sse_lines = ["data: [DONE]"]
        mock_client_cls, _ = self._make_sse_mock(sse_lines)

        mock_span = MagicMock()
        mock_span.__enter__ = MagicMock(return_value=mock_span)
        mock_span.__exit__ = MagicMock(return_value=False)

        with patch("httpx.AsyncClient", mock_client_cls), \
             patch("adsb_agent.tracing.make_span", return_value=mock_span):
            await backend._transcribe()

        inputs = mock_span.set_inputs.call_args[0][0]
        assert "model" in inputs
        assert inputs["model"] == "lfm2"
        assert "duration_s" in inputs
        assert "audio_bytes" in inputs


# ---------------------------------------------------------------------------
# MLflow audio attachment logging — Voxtral
# ---------------------------------------------------------------------------

class TestVoxtralAttachmentLogging:
    """Verify Voxtral buffers and logs WAV audio in MLflow spans."""

    def test_trace_buffer_initially_empty(self):
        backend = VoxtralBackend(binary_path="/fake", model_dir="/fake")
        assert backend._trace_audio_buffer == []
        assert backend._trace_enabled is False

    def test_build_trace_attachment_returns_valid_wav(self):
        """_build_trace_attachment() wraps buffered PCM in a proper WAV file."""
        import io
        import wave
        from mlflow.tracing.attachments import Attachment

        backend = VoxtralBackend(binary_path="/fake", model_dir="/fake")
        backend._trace_audio_buffer = [b"\x00\x00" * 1600]  # 100ms silence at 16kHz

        attachment = backend._build_trace_attachment()

        assert attachment is not None
        assert isinstance(attachment, Attachment)
        assert attachment.content_type == "audio/wav"
        assert len(attachment.content_bytes) > 44  # WAV header is 44 bytes min
        with wave.open(io.BytesIO(attachment.content_bytes), "rb") as wf:
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2
            assert wf.getframerate() == 16000

    def test_build_trace_attachment_returns_none_when_empty(self):
        backend = VoxtralBackend(binary_path="/fake", model_dir="/fake")
        assert backend._build_trace_attachment() is None

    def test_trace_buffer_cleared_after_build(self):
        """_build_trace_attachment() does NOT clear the buffer — caller is responsible."""
        backend = VoxtralBackend(binary_path="/fake", model_dir="/fake")
        backend._trace_audio_buffer = [b"\x00\x01" * 100]
        backend._build_trace_attachment()
        # Buffer should still be populated — clearing is stop_listening()'s responsibility
        assert len(backend._trace_audio_buffer) == 1
