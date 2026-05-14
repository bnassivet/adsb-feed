"""Shared microphone capture — streams 16 kHz mono PCM via an asyncio queue.

Both Voxtral and LFM2.5-Audio backends consume audio from this module.
The capture runs on a background thread (sounddevice callback) and pushes
raw int16 PCM chunks into an asyncio.Queue for async consumers.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

import numpy as np

logger = logging.getLogger("adsb_agent.voice.audio")

# Audio parameters — both Voxtral and LFM2.5 expect 16 kHz mono
SAMPLE_RATE = 16000
CHANNELS = 1
DTYPE = "int16"
# ~100 ms chunks (1600 samples at 16 kHz)
CHUNK_SAMPLES = 1600


class AudioCapture:
    """Captures microphone audio and streams PCM chunks asynchronously.

    Usage:
        capture = AudioCapture()
        await capture.start()
        async for chunk in capture.stream():
            process(chunk)  # np.ndarray of int16
        await capture.stop()
    """

    def __init__(self, sample_rate: int = SAMPLE_RATE, chunk_samples: int = CHUNK_SAMPLES):
        self._sample_rate = sample_rate
        self._chunk_samples = chunk_samples
        self._queue: asyncio.Queue[np.ndarray | None] = asyncio.Queue(maxsize=500)
        self._stream = None
        self._running = False
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    @property
    def is_running(self) -> bool:
        return self._running

    async def start(self) -> None:
        """Open the microphone and begin capturing."""
        if self._running:
            return

        import sounddevice as sd

        self._loop = asyncio.get_running_loop()
        self._running = True

        def _callback(indata: np.ndarray, frames: int, time_info, status) -> None:
            if status:
                logger.warning("Audio capture status: %s", status)
            if self._running and self._loop is not None:
                # Copy the data — sounddevice reuses the buffer
                chunk = indata[:, 0].copy().astype(np.int16)
                # Drop audio if consumer can't keep up (queue full)
                if not self._queue.full():
                    self._loop.call_soon_threadsafe(self._queue.put_nowait, chunk)

        def _open_stream():
            stream = sd.InputStream(
                samplerate=self._sample_rate,
                channels=CHANNELS,
                dtype=DTYPE,
                blocksize=self._chunk_samples,
                callback=_callback,
            )
            stream.start()
            return stream

        self._stream = await asyncio.to_thread(_open_stream)
        logger.info("Audio capture started: %d Hz, %d-sample chunks", self._sample_rate, self._chunk_samples)

    async def stop(self) -> None:
        """Stop capturing and close the microphone."""
        self._running = False
        if self._stream is not None:
            stream = self._stream
            self._stream = None
            await asyncio.to_thread(lambda: (stream.stop(), stream.close()))
        # Signal end of stream
        try:
            self._queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
        logger.info("Audio capture stopped")

    async def stream(self) -> AsyncIterator[np.ndarray]:
        """Yield PCM chunks (int16 numpy arrays) until stopped."""
        while self._running or not self._queue.empty():
            chunk = await self._queue.get()
            if chunk is None:
                break
            yield chunk

    def get_pcm_bytes(self, chunk: np.ndarray) -> bytes:
        """Convert a numpy int16 chunk to raw PCM bytes (little-endian)."""
        return chunk.tobytes()
