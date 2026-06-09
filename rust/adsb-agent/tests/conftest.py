"""Pytest configuration and shared fixtures.

sounddevice loads PortAudio at import time, which fails in CI (no audio
hardware). Stub the module before any test file imports audio_capture.
"""

import sys
from unittest.mock import MagicMock

# Must be set before any test module is imported so that
# `from adsb_agent.voice.audio_capture import AudioCapture` doesn't trigger
# the real sounddevice C extension.
if "sounddevice" not in sys.modules:
    sys.modules["sounddevice"] = MagicMock()
