"""LFM2.5-Audio end-to-end backend — speech-in, text/tool-call out.

LFM2.5-Audio-1.5B is a small multimodal model that natively processes
audio input and can produce text responses + tool calls. It runs via
llama.cpp (GGUF) or MLX, entirely local.

Unlike Voxtral (STT-only), this backend bypasses the text LLM entirely:
audio → LFM2.5 → AG-UI events (text messages + tool calls).

This is a more experimental backend — model support for tool calling
may vary depending on the quantization and prompt format.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from ag_ui.core import (
    EventType,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)

from .audio_capture import AudioCapture
from .base import BackendInfo, TranscriptChunk, VoiceBackendStatus

logger = logging.getLogger("adsb_agent.voice.lfm2")

# Default paths
DEFAULT_MODEL_PATH = os.environ.get(
    "ADSB_AGENT_LFM2_MODEL_PATH",
    str(Path(__file__).parent.parent.parent.parent / "models" / "lfm2-audio" / "model.gguf"),
)
DEFAULT_LLAMA_SERVER = os.environ.get("ADSB_AGENT_LLAMA_SERVER", "llama-server")
DEFAULT_LLAMA_PORT = int(os.environ.get("ADSB_AGENT_LLAMA_PORT", "8081"))


class LFM2AudioBackend:
    """LFM2.5-Audio end-to-end backend — audio in, AG-UI events out.

    Uses llama-server (llama.cpp) as the inference backend, running on
    a separate port from the main LM Studio instance.
    """

    def __init__(
        self,
        model_path: str = DEFAULT_MODEL_PATH,
        llama_server: str = DEFAULT_LLAMA_SERVER,
        llama_port: int = DEFAULT_LLAMA_PORT,
    ):
        self._model_path = model_path
        self._llama_server = llama_server
        self._llama_port = llama_port
        self._server_process: asyncio.subprocess.Process | None = None
        self._capture = AudioCapture()
        self._status = VoiceBackendStatus.NOT_READY
        self._audio_buffer: list[bytes] = []
        self._collect_task: asyncio.Task | None = None
        self._check_ready()

    def _check_ready(self) -> None:
        """Check if model file exists."""
        if os.path.isfile(self._model_path):
            self._status = VoiceBackendStatus.READY
        else:
            self._status = VoiceBackendStatus.NOT_READY
            logger.warning("LFM2.5-Audio model not found: %s", self._model_path)

    @property
    def name(self) -> str:
        return "lfm2-audio"

    @property
    def supports_end_to_end(self) -> bool:
        return True

    async def _acheck_ready(self) -> None:
        """Async wrapper for _check_ready — offloads filesystem check to thread."""
        await asyncio.to_thread(self._check_ready)

    async def get_status(self) -> VoiceBackendStatus:
        return self._status

    async def get_info(self) -> BackendInfo:
        return BackendInfo(
            name="lfm2-audio",
            description="LFM2.5-Audio 1.5B — end-to-end speech understanding + tool calling",
            status=self._status,
            supports_end_to_end=True,
            model_size="~1.5B params",
            extra={
                "model_path": self._model_path,
                "llama_port": self._llama_port,
            },
        )

    async def _ensure_server(self) -> None:
        """Start llama-server if not already running."""
        if self._server_process is not None:
            return

        cmd = [
            self._llama_server,
            "--model", self._model_path,
            "--port", str(self._llama_port),
            "--ctx-size", "4096",
            "--n-gpu-layers", "99",  # Offload all layers to GPU
        ]
        logger.info("Starting llama-server: %s", " ".join(cmd))
        self._server_process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        logger.info("llama-server launched (PID %d, port %d), waiting for ready...",
                    self._server_process.pid, self._llama_port)
        await self._wait_for_server_ready()

    async def _wait_for_server_ready(self, timeout: float = 15.0) -> None:
        """Poll llama-server /health until it responds 200, with exponential backoff."""
        import httpx

        delay = 0.1
        deadline = asyncio.get_event_loop().time() + timeout
        async with httpx.AsyncClient() as client:
            while asyncio.get_event_loop().time() < deadline:
                try:
                    resp = await client.get(
                        f"http://localhost:{self._llama_port}/health",
                        timeout=1.0,
                    )
                    if resp.status_code == 200:
                        logger.info("llama-server ready")
                        return
                except (httpx.ConnectError, httpx.TimeoutException):
                    pass
                await asyncio.sleep(delay)
                delay = min(delay * 2, 2.0)
        raise RuntimeError(f"llama-server not ready after {timeout}s")

    async def start_listening(self) -> None:
        """Start audio capture. Audio is buffered until stop_listening triggers inference."""
        if self._status == VoiceBackendStatus.LISTENING:
            return
        if self._status == VoiceBackendStatus.NOT_READY:
            await self._acheck_ready()
            if self._status == VoiceBackendStatus.NOT_READY:
                raise RuntimeError(f"LFM2.5-Audio model not found: {self._model_path}")

        await self._ensure_server()
        self._audio_buffer.clear()
        await self._capture.start()

        # Collect audio in background
        self._collect_task = asyncio.create_task(self._collect_audio())
        self._status = VoiceBackendStatus.LISTENING
        logger.info("LFM2.5-Audio listening")

    async def _collect_audio(self) -> None:
        """Buffer mic audio for batch inference on stop."""
        try:
            async for chunk in self._capture.stream():
                self._audio_buffer.append(self._capture.get_pcm_bytes(chunk))
        except asyncio.CancelledError:
            pass

    async def stop_listening(self) -> None:
        """Stop capture. Call get_response_stream() after to get the inference result."""
        await self._capture.stop()
        if self._collect_task is not None:
            self._collect_task.cancel()
            try:
                await self._collect_task
            except asyncio.CancelledError:
                pass
            self._collect_task = None
        self._status = VoiceBackendStatus.READY
        logger.info("LFM2.5-Audio stopped, buffered %d chunks", len(self._audio_buffer))

    async def get_transcript_stream(self) -> AsyncIterator[TranscriptChunk]:
        """LFM2.5 is end-to-end — transcript is part of the response.

        This yields a simplified transcript from the model's text output
        for display purposes.
        """
        async for event in self.get_response_stream():
            if hasattr(event, "delta") and event.type == EventType.TEXT_MESSAGE_CONTENT:
                logger.debug("[lfm2 transcript] delta: %r", event.delta)
                yield TranscriptChunk(text=event.delta, is_final=False)

    async def get_response_stream(self) -> AsyncIterator:
        """Send buffered audio to llama-server and stream AG-UI events.

        Uses the llama.cpp /completion endpoint with audio data encoded
        as base64 in the prompt (following LFM2.5's input format).
        """
        import base64
        import httpx

        if not self._audio_buffer:
            logger.warning("No audio buffered for inference")
            return

        # Concatenate all audio chunks
        audio_pcm = b"".join(self._audio_buffer)
        duration_s = len(audio_pcm) / (16000 * 2)  # 16kHz, 16-bit (2 bytes/sample)
        logger.info("[lfm2] Audio buffered: %d bytes (%.1fs)", len(audio_pcm), duration_s)
        audio_b64 = base64.b64encode(audio_pcm).decode("ascii")
        self._audio_buffer.clear()

        message_id = str(uuid.uuid4())

        # Build prompt with audio data
        # LFM2.5-Audio expects audio in the prompt as a special token
        prompt = json.dumps({
            "audio": audio_b64,
            "sample_rate": 16000,
            "prompt": "You are an ADS-B aircraft tracking assistant. Process the audio and respond.",
        })

        yield TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id=message_id,
            role="assistant",
        )

        try:
            async with httpx.AsyncClient() as client:
                async with client.stream(
                    "POST",
                    f"http://localhost:{self._llama_port}/completion",
                    json={"prompt": prompt, "stream": True, "n_predict": 512},
                    timeout=30.0,
                ) as response:
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = json.loads(line[6:])
                        content = data.get("content", "")
                        if content:
                            yield TextMessageContentEvent(
                                type=EventType.TEXT_MESSAGE_CONTENT,
                                message_id=message_id,
                                delta=content,
                            )
                        if data.get("stop"):
                            break
        except Exception as e:
            logger.error("LFM2.5 inference error: %s", e, exc_info=True)
            yield TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=message_id,
                delta=f"[Inference error: {e}]",
            )

        yield TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id=message_id,
        )

    async def shutdown(self) -> None:
        """Kill the llama-server process."""
        if self._server_process is not None:
            self._server_process.terminate()
            try:
                await asyncio.wait_for(self._server_process.wait(), timeout=5.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                self._server_process.kill()
            self._server_process = None
            logger.info("llama-server stopped")
