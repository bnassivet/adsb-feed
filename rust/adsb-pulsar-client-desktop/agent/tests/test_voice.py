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
        backend = LFM2AudioBackend(model_path="/nonexistent/model.gguf")
        assert backend.name == "lfm2-audio"
        assert backend.supports_end_to_end is True

    @pytest.mark.asyncio
    async def test_get_status_not_ready(self):
        backend = LFM2AudioBackend(model_path="/nonexistent/model.gguf")
        status = await backend.get_status()
        assert status == VoiceBackendStatus.NOT_READY

    @pytest.mark.asyncio
    async def test_get_info(self):
        backend = LFM2AudioBackend(model_path="/nonexistent/model.gguf")
        info = await backend.get_info()
        assert info.name == "lfm2-audio"
        assert info.supports_end_to_end is True

    @pytest.mark.asyncio
    async def test_start_listening_raises_when_not_ready(self):
        backend = LFM2AudioBackend(model_path="/nonexistent/model.gguf")
        with pytest.raises(RuntimeError, match="not found"):
            await backend.start_listening()


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
        backend = LFM2AudioBackend(model_path="/nonexistent/model.gguf")
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
        """_wait_for_server_ready should poll /health and return on 200."""
        import httpx

        backend = LFM2AudioBackend(model_path="/nonexistent/model.gguf")
        call_count = 0

        async def mock_get(url, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise httpx.ConnectError("not ready")
            resp = MagicMock()
            resp.status_code = 200
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

        backend = LFM2AudioBackend(model_path="/nonexistent/model.gguf")

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
        assert response.status_code == 200
        data = response.json()
        assert "error" in data

    @pytest.mark.asyncio
    async def test_stop_when_not_listening(self, client):
        response = await client.post("/voice/stop")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "not_listening"
