"""Voice input subsystem — dual backend (Voxtral STT + LFM2.5-Audio)."""

from .base import TranscriptChunk, VoiceBackend, VoiceBackendStatus

__all__ = ["TranscriptChunk", "VoiceBackend", "VoiceBackendStatus"]
