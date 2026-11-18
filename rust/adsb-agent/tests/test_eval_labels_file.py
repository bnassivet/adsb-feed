"""Evaluating a second labels file without touching the published one.

``ADSB_EVAL_LABELS`` points every eval script at another labels file (the
validation requests). Result files must then carry its name, or a validation run
would overwrite the main run's per-record file whenever the record counts match.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

EVAL = Path(__file__).parent.parent / "eval"
sys.path.insert(0, str(EVAL))

import common  # noqa: E402


@pytest.fixture
def reloaded(monkeypatch):
    """``common`` re-imported under the environment a test sets, restored after."""

    def load(**env: str):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        return importlib.reload(common)

    yield load
    monkeypatch.delenv("ADSB_EVAL_LABELS", raising=False)
    importlib.reload(common)


def test_default_is_the_reviewed_labels_and_adds_no_tag(reloaded, monkeypatch):
    monkeypatch.delenv("ADSB_EVAL_LABELS", raising=False)
    module = reloaded()
    assert module.LABELS_PATH == EVAL / "data" / "labels.jsonl"
    assert module.labels_tag() == ""


def test_env_var_selects_another_labels_file(reloaded, tmp_path):
    other = tmp_path / "validation_labels.jsonl"
    other.write_text("{}\n")
    module = reloaded(ADSB_EVAL_LABELS=str(other))
    assert module.LABELS_PATH == other
    assert module.labels_tag() == "-validation_labels"
    assert module.labels_sha256() != ""
