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

# Default paths — llama-liquid-audio-server (LiquidAI custom build with audio support)
DEFAULT_MODEL_DIR = os.environ.get(
    "ADSB_AGENT_LFM2_MODEL_DIR",
    str(Path.cwd() / "models" / "LFM2.5-Audio"),
)
DEFAULT_QUANT = os.environ.get("ADSB_AGENT_LFM2_QUANT", "Q4_0")
DEFAULT_LLAMA_SERVER = os.environ.get(
    "ADSB_AGENT_LLAMA_SERVER",
    str(Path(DEFAULT_MODEL_DIR) / "bin" / "llama-liquid-audio-macos-arm64" / "llama-liquid-audio-server"),
)
DEFAULT_LLAMA_PORT = int(os.environ.get("ADSB_AGENT_LLAMA_PORT", "2026"))


class LFM2AudioBackend:
    """LFM2.5-Audio end-to-end backend — audio in, AG-UI events out.

    Uses llama-server (llama.cpp) as the inference backend, running on
    a separate port from the main LM Studio instance.
    """

    def __init__(
        self,
        model_dir: str = DEFAULT_MODEL_DIR,
        quant: str = DEFAULT_QUANT,
        llama_server: str = DEFAULT_LLAMA_SERVER,
        llama_port: int = DEFAULT_LLAMA_PORT,
    ):
        self._model_dir = Path(model_dir)
        self._quant = quant
        self._model_path = str(self._model_dir / f"LFM2.5-Audio-1.5B-{quant}.gguf")
        self._mmproj_path = str(self._model_dir / f"mmproj-LFM2.5-Audio-1.5B-{quant}.gguf")
        self._vocoder_path = str(self._model_dir / f"vocoder-LFM2.5-Audio-1.5B-{quant}.gguf")
        self._tokenizer_path = str(self._model_dir / f"tokenizer-LFM2.5-Audio-1.5B-{quant}.gguf")
        self._llama_server = llama_server
        self._llama_port = llama_port
        self._server_process: asyncio.subprocess.Process | None = None
        self._capture = AudioCapture()
        self._status = VoiceBackendStatus.NOT_READY
        self._audio_buffer: list[bytes] = []
        self._collect_task: asyncio.Task | None = None
        self._last_transcript: str | None = None
        # Set when not recording; cleared on start, set again on stop so that
        # get_transcript_stream() can idle safely during capture.
        self._stopped_event = asyncio.Event()
        self._stopped_event.set()
        self._check_ready()

    def _check_ready(self) -> None:
        """Check that all 4 model files exist."""
        missing = [
            p for p in [self._model_path, self._mmproj_path, self._vocoder_path, self._tokenizer_path]
            if not os.path.isfile(p)
        ]
        if missing:
            self._status = VoiceBackendStatus.NOT_READY
            logger.warning("LFM2.5-Audio model files not found: %s", missing)
        else:
            self._status = VoiceBackendStatus.READY

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
                "model_dir": str(self._model_dir),
                "quant": self._quant,
                "llama_port": self._llama_port,
            },
        )

    async def _ensure_server(self) -> None:
        """Start llama-server if not already running."""
        if self._server_process is not None:
            return

        cmd = [
            self._llama_server,
            "-m", self._model_path,
            "-mm", self._mmproj_path,
            "-mv", self._vocoder_path,
            "--tts-speaker-file", self._tokenizer_path,
            "--host", "0.0.0.0",
            "--port", str(self._llama_port),
        ]
        logger.info("Starting llama-liquid-audio-server: %s", " ".join(cmd))
        try:
            self._server_process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            raise RuntimeError(
                f"llama-liquid-audio-server binary not found: {self._llama_server!r}. "
                "Download from HuggingFace: LiquidAI/LFM2.5-Audio-1.5B-GGUF runners/macos-arm64/ "
                "and set ADSB_AGENT_LLAMA_SERVER or ADSB_AGENT_LFM2_MODEL_DIR."
            )
        logger.info("llama-server launched (PID %d, port %d), waiting for ready...",
                    self._server_process.pid, self._llama_port)
        await self._wait_for_server_ready()

    async def _wait_for_server_ready(self, timeout: float = 15.0) -> None:
        """Poll until llama-liquid-audio-server accepts connections.

        llama-liquid-audio-server has no /health endpoint — any HTTP response
        (including 404) means the server is up and ready to accept requests.
        """
        import httpx

        delay = 0.1
        deadline = asyncio.get_event_loop().time() + timeout
        async with httpx.AsyncClient() as client:
            while asyncio.get_event_loop().time() < deadline:
                if self._server_process is not None and self._server_process.returncode is not None:
                    stderr_bytes = await self._server_process.stderr.read()
                    stderr_text = stderr_bytes.decode(errors="replace").strip()
                    raise RuntimeError(
                        f"llama-server exited (code {self._server_process.returncode}): {stderr_text}"
                    )
                try:
                    resp = await client.get(
                        f"http://localhost:{self._llama_port}/health",
                        timeout=1.0,
                    )
                    # Any HTTP response means the server is accepting connections.
                    logger.info("llama-liquid-audio-server ready (HTTP %d)", resp.status_code)
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
                raise RuntimeError(f"LFM2.5-Audio model files not found in: {self._model_dir}")

        await self._ensure_server()
        self._audio_buffer.clear()
        self._stopped_event.clear()  # Gate: blocks get_transcript_stream() until stop
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
        """Stop capture, transcribe buffered audio, set _last_transcript.

        Transcription runs synchronously here so that POST /voice/stop returns
        the result (same pattern as VoxtralBackend.stop_listening).
        Typical latency: 2–15s depending on audio length.
        """
        await self._capture.stop()
        if self._collect_task is not None:
            self._collect_task.cancel()
            try:
                await self._collect_task
            except asyncio.CancelledError:
                pass
            self._collect_task = None

        logger.info("LFM2.5-Audio stopped, buffered %d chunks", len(self._audio_buffer))
        self._last_transcript = await self._transcribe()

        self._status = VoiceBackendStatus.READY
        self._stopped_event.set()  # Unblocks get_transcript_stream()
        logger.info("LFM2.5-Audio transcript: %r", self._last_transcript)

    async def _transcribe(self) -> str | None:
        """Send buffered PCM audio to llama-liquid-audio-server and return the transcript.

        Uses /v1/chat/completions (streaming) with system prompt "Perform ASR."
        and the audio encoded as base64 WAV in the user content array.
        """
        import base64
        import io
        import wave
        import httpx
        from adsb_agent.tracing import make_span

        if not self._audio_buffer:
            logger.warning("LFM2 transcribe: no audio buffered — nothing to send")
            return None

        audio_pcm = b"".join(self._audio_buffer)
        self._audio_buffer.clear()
        duration_s = len(audio_pcm) / (self._capture.sample_rate * 2)
        logger.info("[lfm2] Transcribing %.1fs of audio (%d bytes)", duration_s, len(audio_pcm))

        # Wrap raw PCM in a WAV container (server needs the header for sample rate / depth)
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)   # int16
            wf.setframerate(self._capture.sample_rate)
            wf.writeframes(audio_pcm)
        wav_b64 = base64.b64encode(wav_buf.getvalue()).decode()
        audio_bytes = len(wav_buf.getvalue())

        payload = {
            "model": "lfm2",
            "stream": True,
            "messages": [
                {"role": "system", "content": "Perform ASR."},
                {"role": "user", "content": [
                    {"type": "input_audio", "input_audio": {"data": wav_b64, "format": "wav"}},
                ]},
            ],
        }

        with make_span("lfm2_audio_transcribe") as span:
            if span is not None:
                from mlflow.tracing.attachments import Attachment
                span.set_inputs({
                    "model": "lfm2",
                    "duration_s": round(duration_s, 2),
                    "audio_bytes": audio_bytes,
                    "audio": Attachment(
                        content_type="audio/wav",
                        content_bytes=wav_buf.getvalue(),
                    ),
                })

            try:
                parts: list[str] = []
                async with httpx.AsyncClient() as client:
                    async with client.stream(
                        "POST",
                        f"http://localhost:{self._llama_port}/v1/chat/completions",
                        json=payload,
                        timeout=60.0,
                    ) as response:
                        if response.status_code != 200:
                            body = await response.aread()
                            logger.error(
                                "[lfm2] Transcription error %d: %s",
                                response.status_code,
                                body.decode(errors="replace")[:500],
                            )
                            if span is not None:
                                span.set_outputs({"transcript": None, "error": response.status_code})
                            return None
                        async for line in response.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            raw = line[6:]
                            if raw == "[DONE]":
                                break
                            try:
                                chunk = json.loads(raw)
                                delta = chunk["choices"][0]["delta"].get("content", "")
                                if delta:
                                    parts.append(delta)
                            except (json.JSONDecodeError, KeyError, IndexError):
                                pass
                text = "".join(parts).strip()
                logger.info("[lfm2] Transcript: %r", text)
                if span is not None:
                    span.set_outputs({"transcript": text or None})
                return text or None
            except Exception as e:
                logger.error("[lfm2] Transcription request failed: %s", e, exc_info=True)
                return None

    async def get_transcript_stream(self) -> AsyncIterator[TranscriptChunk]:
        """LFM2 is batch: no real-time transcript during capture.

        The SSE stays open (idle) while recording. Inference runs inside
        stop_listening(), and the final transcript is returned by POST /voice/stop
        via _last_transcript (same as Voxtral). Nothing is yielded here — the
        stream just needs to stay alive until the client closes it.
        """
        while not self._stopped_event.is_set():
            await asyncio.sleep(0.2)
        # Transcript delivered via _last_transcript, not the SSE stream.
        if False:  # pragma: no cover — makes this function an async generator
            yield TranscriptChunk(text="")

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
