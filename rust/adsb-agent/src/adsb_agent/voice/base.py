"""Voice backend protocol — common interface for all voice backends.

Each backend captures audio from the microphone and produces transcripts
(Voxtral) or full AG-UI event streams (LFM2.5-Audio).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable


class VoiceBackendStatus(str, Enum):
    """Lifecycle state of a voice backend."""

    NOT_READY = "not_ready"  # Model not downloaded / binary not found
    READY = "ready"  # Model available, not listening
    LISTENING = "listening"  # Actively capturing + transcribing
    ERROR = "error"  # Unrecoverable error


@dataclass
class TranscriptChunk:
    """A piece of transcribed text from the STT backend.

    Attributes:
        text: The transcribed text fragment.
        is_final: True when the chunk ends a complete utterance.
        confidence: Optional confidence score [0, 1].
    """

    text: str
    is_final: bool = False
    confidence: float | None = None


@dataclass
class BackendInfo:
    """Metadata about a voice backend for the /voice/backends endpoint."""

    name: str
    description: str
    status: VoiceBackendStatus
    supports_end_to_end: bool
    model_size: str | None = None
    extra: dict = field(default_factory=dict)


@runtime_checkable
class VoiceBackend(Protocol):
    """Protocol that all voice backends must implement.

    Two flavours:
    - **STT-only** (e.g. Voxtral): produces TranscriptChunks that are fed
      into the existing text agent pipeline.
    - **End-to-end** (e.g. LFM2.5-Audio): consumes audio directly and
      produces AG-UI events, bypassing the text LLM entirely.
    """

    @property
    def name(self) -> str:
        """Short identifier for this backend (e.g. 'voxtral', 'lfm2-audio')."""
        ...

    @property
    def supports_end_to_end(self) -> bool:
        """True if this backend handles the full audio→response pipeline."""
        ...

    async def get_status(self) -> VoiceBackendStatus:
        """Return current lifecycle status."""
        ...

    async def get_info(self) -> BackendInfo:
        """Return metadata about this backend."""
        ...

    async def start_listening(self) -> None:
        """Begin audio capture and transcription/inference.

        Raises RuntimeError if the backend is not ready.
        """
        ...

    async def stop_listening(self) -> None:
        """Stop audio capture and release resources."""
        ...

    async def get_transcript_stream(self) -> AsyncIterator[TranscriptChunk]:
        """Yield transcript chunks as audio is processed.

        Only meaningful for STT-only backends. End-to-end backends
        should yield the transcript portion of their output here
        (for display purposes) or raise NotImplementedError.
        """
        ...
