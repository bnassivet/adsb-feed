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

# With the `eval` extra installed the full `mlflow` package is present, and its
# default tracking store writes `mlflow.db` and `mlruns/` in the working directory. Any
# test that opens a span would then leave `mlflow.db` and `mlruns/` in the
# project. Point it at a throwaway file store instead (a SQLite URI still puts
# trace artifacts in `./mlruns`). Set before any test
# module imports mlflow; `setdefault` so an explicit URI still wins.
import os  # noqa: E402
import tempfile  # noqa: E402

_MLFLOW_TMP = tempfile.mkdtemp(prefix="adsb-agent-tests-")
os.environ.setdefault("MLFLOW_TRACKING_URI", f"file://{_MLFLOW_TMP}/mlruns")
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _fast_path_off_unless_asked(monkeypatch):
    """The fast path is on by default and calls three model endpoints before
    the main agent. Tests of everything else must not reach the network; the
    fast-path tests turn it back on and supply their own transport."""
    from adsb_agent.config import settings

    monkeypatch.setattr(settings, "fast_path_enabled", False)
