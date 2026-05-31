"""Voxtral STT backend — manages voxtral.c as a subprocess.

Voxtral.c reads 16 kHz PCM from stdin and outputs streaming transcription
tokens to stdout. This backend:
1. Starts voxtral.c with the model directory
2. Pipes microphone PCM audio to its stdin
3. Reads transcript tokens from stdout
4. Yields TranscriptChunks for the agent to forward as text to the LLM

The transcribed text is sent through the existing FastAPI → LM Studio pipeline
(this is an STT-only backend, not end-to-end).

See: https://github.com/antirez/voxtral.c
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from collections.abc import AsyncIterator
from pathlib import Path

from .audio_capture import AudioCapture
from .base import BackendInfo, TranscriptChunk, VoiceBackendStatus

logger = logging.getLogger("adsb_agent.voice.voxtral")

# Default paths — can be overridden via env vars
DEFAULT_VOXTRAL_BINARY = os.environ.get(
    "ADSB_AGENT_VOXTRAL_BINARY", "voxtral"
)
DEFAULT_MODEL_DIR = os.environ.get(
    "ADSB_AGENT_VOXTRAL_MODEL_DIR",
    str(Path(__file__).parent.parent.parent.parent / "models" / "voxtral"),
)
# Latency parameter for voxtral.c (-I flag): seconds of audio to buffer
# before processing. Lower = faster but more CPU. Default 1.5s.
DEFAULT_LATENCY = float(os.environ.get("ADSB_AGENT_VOXTRAL_LATENCY", "1.5"))


class VoxtralBackend:
    """Voxtral STT backend — speech-to-text via voxtral.c sidecar process."""

    def __init__(
        self,
        binary_path: str = DEFAULT_VOXTRAL_BINARY,
        model_dir: str = DEFAULT_MODEL_DIR,
        latency: float = DEFAULT_LATENCY,
    ):
        self._binary_path = binary_path
        self._model_dir = model_dir
        self._latency = latency
        self._process: asyncio.subprocess.Process | None = None
        self._capture = AudioCapture()
        self._status = VoiceBackendStatus.NOT_READY
        self._feed_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._last_transcript: str | None = None
        self._reader_done = asyncio.Event()  # Set when no reader is active on stdout
        self._reader_done.set()  # No reader active initially
        self._stop_event = asyncio.Event()  # Signals transcript stream to exit
        self._bytes_fed: int = 0  # total PCM bytes sent to voxtral stdin this session
        self._trace_enabled: bool = False
        self._trace_audio_buffer: list[bytes] = []
        # Chat session id — set by /voice/start so the MLflow trace for this
        # capture rolls up under the same MLflow session as the chat turns.
        self.session_id: str | None = None
        self._check_ready()

    def _check_ready(self) -> None:
        """Check if voxtral binary and model are available."""
        binary_ok = shutil.which(self._binary_path) is not None or os.path.isfile(self._binary_path)
        model_ok = os.path.isdir(self._model_dir)
        if binary_ok and model_ok:
            self._status = VoiceBackendStatus.READY
        else:
            self._status = VoiceBackendStatus.NOT_READY
            if not binary_ok:
                logger.warning("Voxtral binary not found: %s", self._binary_path)
            if not model_ok:
                logger.warning("Voxtral model dir not found: %s", self._model_dir)

    @property
    def name(self) -> str:
        return "voxtral"

    @property
    def supports_end_to_end(self) -> bool:
        return False

    async def _acheck_ready(self) -> None:
        """Async wrapper for _check_ready — offloads filesystem checks to thread."""
        await asyncio.to_thread(self._check_ready)

    async def get_status(self) -> VoiceBackendStatus:
        return self._status

    async def get_info(self) -> BackendInfo:
        return BackendInfo(
            name="voxtral",
            description="Voxtral STT — speech-to-text via voxtral.c (MPS accelerated)",
            status=self._status,
            supports_end_to_end=False,
            model_size="~8.9 GB",
            extra={
                "binary": self._binary_path,
                "model_dir": self._model_dir,
                "latency": self._latency,
            },
        )

    def _build_trace_attachment(self):
        """Wrap buffered PCM in a WAV container and return an mlflow Attachment.

        Returns None when the trace buffer is empty (tracing disabled or no audio).
        Caller is responsible for clearing _trace_audio_buffer after use.
        """
        if not self._trace_audio_buffer:
            return None
        import io
        import wave
        from mlflow.tracing.attachments import Attachment
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)   # int16
            wf.setframerate(16000)
            wf.writeframes(b"".join(self._trace_audio_buffer))
        return Attachment(content_type="audio/wav", content_bytes=wav_buf.getvalue())

    async def start_listening(self) -> None:
        """Start voxtral.c subprocess and microphone capture."""
        if self._status == VoiceBackendStatus.LISTENING:
            return
        # Wipe any prior recording's transcript before doing anything else, so
        # an aborted/failed stop_listening can never leak stale text into the
        # next /voice/stop response.
        self._last_transcript = None
        self._stop_event.clear()
        if self._status == VoiceBackendStatus.NOT_READY:
            await self._acheck_ready()
            if self._status == VoiceBackendStatus.NOT_READY:
                raise RuntimeError(
                    f"Voxtral not ready: binary={self._binary_path}, model={self._model_dir}"
                )

        cmd = [
            self._binary_path,
            "-d", self._model_dir,
            "--stdin",
            "-I", str(self._latency),
        ]
        logger.info("Starting voxtral: %s", " ".join(cmd))

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Start stderr reader so voxtral.c errors are visible
        self._stderr_task = asyncio.create_task(self._read_stderr())

        # Start mic capture
        self._bytes_fed = 0
        try:
            from adsb_agent.config import settings as _s
            self._trace_enabled = _s.mlflow_enabled
        except Exception:
            self._trace_enabled = False
        self._trace_audio_buffer.clear()
        await self._capture.start()

        # Feed audio to voxtral stdin in background
        self._feed_task = asyncio.create_task(self._feed_audio())
        self._status = VoiceBackendStatus.LISTENING
        logger.info("Voxtral listening (PID %d)", self._process.pid)

    async def _read_stderr(self) -> None:
        """Background task: log voxtral.c stderr output."""
        if self._process is None or self._process.stderr is None:
            return
        try:
            async for raw_line in self._process.stderr:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                if line:
                    logger.info("[voxtral stderr] %s", line)
        except Exception:
            pass

    async def _feed_audio(self) -> None:
        """Background task: read mic chunks and write PCM to voxtral stdin."""
        chunks_fed = 0
        bytes_fed = 0
        try:
            async for chunk in self._capture.stream():
                if self._process is None or self._process.stdin is None:
                    break
                pcm_bytes = self._capture.get_pcm_bytes(chunk)
                self._process.stdin.write(pcm_bytes)
                await self._process.stdin.drain()
                chunks_fed += 1
                bytes_fed += len(pcm_bytes)
                self._bytes_fed += len(pcm_bytes)
                if self._trace_enabled:
                    self._trace_audio_buffer.append(pcm_bytes)
                if chunks_fed % 50 == 0:  # Log every ~5s (50 x 100ms)
                    logger.info("[voxtral feed] %d chunks, %d bytes (%.1fs audio)",
                                chunks_fed, bytes_fed, bytes_fed / (16000 * 2))
        except (BrokenPipeError, ConnectionResetError):
            logger.warning("Voxtral stdin pipe broken — process may have exited")
        except Exception as e:
            logger.error("Audio feed error: %s", e, exc_info=True)
        finally:
            logger.info("[voxtral feed] Total: %d chunks, %d bytes (%.1fs audio)",
                        chunks_fed, bytes_fed, bytes_fed / (16000 * 2) if bytes_fed else 0)
            if self._process and self._process.stdin:
                try:
                    self._process.stdin.close()
                except Exception:
                    pass

    async def stop_listening(self) -> None:
        """Stop mic capture and let voxtral.c process remaining audio.

        Sequence: stop mic → cancel feed task → signal transcript stream to
        exit → close stdin (signals EOF to voxtral.c) → drain stdout
        (only if no other reader) → wait for process exit → terminate fallback.
        """
        self._status = VoiceBackendStatus.READY
        await self._capture.stop()

        # Cancel audio feed task
        if self._feed_task is not None:
            self._feed_task.cancel()
            try:
                await self._feed_task
            except asyncio.CancelledError:
                pass
            self._feed_task = None

        # Signal the transcript stream (get_transcript_stream) to stop reading
        self._stop_event.set()
        # Wait for the reader to finish (up to 1s)
        try:
            await asyncio.wait_for(self._reader_done.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            logger.warning("Transcript stream still active after 1s — proceeding anyway")

        # Close stdin — signals EOF so voxtral.c processes buffered audio
        if self._process is not None and self._process.stdin is not None:
            try:
                self._process.stdin.close()
                await self._process.stdin.wait_closed()
            except Exception:
                pass
            logger.info("Voxtral stdin closed (EOF sent), waiting for processing...")

        # Read stdout while waiting for voxtral to finish processing
        # Only safe if no other coroutine is reading from the same stream
        self._last_transcript = None
        if self._process is not None and self._reader_done.is_set():
            stdout_lines: list[str] = []
            try:
                async def _drain_stdout():
                    if not self._process or not self._process.stdout:
                        return
                    while True:
                        try:
                            raw_line = await asyncio.wait_for(
                                self._process.stdout.readline(), timeout=2.0
                            )
                        except asyncio.TimeoutError:
                            break
                        if not raw_line:  # EOF
                            break
                        line = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                        if line:
                            logger.info("[voxtral stdout] %r", line)
                            stdout_lines.append(line)

                from adsb_agent.tracing import make_span, set_session_tag
                with make_span("voxtral_stt") as span:
                    if self.session_id:
                        set_session_tag(self.session_id, voice_backend="voxtral")
                    if span is not None:
                        inputs: dict = {
                            "model": "voxtral",
                            "audio_duration_s": round(self._bytes_fed / (16000 * 2), 2),
                        }
                        attachment = self._build_trace_attachment()
                        if attachment is not None:
                            inputs["audio"] = attachment
                        self._trace_audio_buffer.clear()
                        span.set_inputs(inputs)
                    try:
                        await asyncio.wait_for(_drain_stdout(), timeout=15.0)
                    except asyncio.TimeoutError:
                        logger.warning("Voxtral stdout drain timed out after 15s")
                    if span is not None:
                        span.set_outputs({"transcript": " ".join(stdout_lines) or None})
            except asyncio.TimeoutError:
                logger.warning("Voxtral stdout drain timed out after 15s")

            if stdout_lines:
                self._last_transcript = " ".join(stdout_lines)
                logger.info("[voxtral] Transcript: %r", self._last_transcript)
            else:
                logger.warning("[voxtral] No transcript produced")
        elif not self._reader_done.is_set():
            logger.warning("[voxtral] Skipping stdout drain — another reader is active")

        # Wait for process to exit
        if self._process is not None:
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
                logger.info("Voxtral process exited normally (rc=%d)", self._process.returncode)
            except asyncio.TimeoutError:
                logger.warning("Voxtral did not exit in 5s, terminating...")
                try:
                    self._process.terminate()
                    await asyncio.wait_for(self._process.wait(), timeout=5.0)
                except (ProcessLookupError, asyncio.TimeoutError):
                    try:
                        self._process.kill()
                    except ProcessLookupError:
                        pass
            except ProcessLookupError:
                pass
            self._process = None

        # Cancel stderr reader after process is done
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            try:
                await self._stderr_task
            except asyncio.CancelledError:
                pass
            self._stderr_task = None

        logger.info("Voxtral process stopped")

    async def get_transcript_stream(self) -> AsyncIterator[TranscriptChunk]:
        """Read voxtral stdout line-by-line, yielding transcript chunks.

        Voxtral.c is batch: it reads all audio from stdin until EOF, then
        produces output. This stream will be idle during capture and only
        produce data after stop_listening() closes stdin.

        The stream exits when _stop_event is set (by stop_listening) so that
        stop_listening can safely drain stdout itself.
        """
        if self._process is None or self._process.stdout is None:
            return

        self._reader_done.clear()
        logger.debug("[voxtral transcript stream] started")
        try:
            buffer = ""
            while not self._stop_event.is_set():
                # Use wait_for with a short timeout so we can check _stop_event
                try:
                    raw_line = await asyncio.wait_for(
                        self._process.stdout.readline(), timeout=0.5
                    )
                except asyncio.TimeoutError:
                    continue  # Check stop_event again
                except Exception:
                    break

                if not raw_line:
                    # EOF — process closed stdout
                    break

                line = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                logger.debug("[voxtral stdout] raw_line=%r", line)
                if not line:
                    if buffer.strip():
                        chunk = TranscriptChunk(text=buffer.strip(), is_final=True)
                        logger.info("[voxtral transcript] FINAL: %r", chunk.text)
                        yield chunk
                        buffer = ""
                    continue

                buffer += line
                stripped = buffer.strip()
                if stripped and stripped[-1] in ".?!":
                    chunk = TranscriptChunk(text=stripped, is_final=True)
                    logger.info("[voxtral transcript] FINAL: %r", chunk.text)
                    yield chunk
                    buffer = ""
                else:
                    chunk = TranscriptChunk(text=stripped, is_final=False)
                    logger.debug("[voxtral transcript] interim: %r", chunk.text)
                    yield chunk

            # Final flush
            if buffer.strip():
                chunk = TranscriptChunk(text=buffer.strip(), is_final=True)
                logger.info("[voxtral transcript] FINAL (flush): %r", chunk.text)
                yield chunk
        finally:
            self._reader_done.set()
            logger.debug("[voxtral transcript stream] stopped")
