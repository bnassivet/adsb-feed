"""The gate variants compared by ``eval/fastpath_agent/eval_gate_variants.py``."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

EVAL = Path(__file__).resolve().parents[2] / "eval"
sys.path.insert(0, str(EVAL))

from fastpath_agent.eval_gate_variants import about_documents, auc, margin  # noqa: E402

from adsb_agent.fast_path import DIRECT_TOOLS  # noqa: E402


def test_auc_counts_pairs_ranked_right_and_halves_ties():
    assert auc([0.9, 0.8, 0.1], [True, True, False]) == 1.0
    assert auc([0.1, 0.9], [True, False]) == 0.0
    assert auc([0.5, 0.5], [True, False]) == 0.5
    # 2 positives x 2 negatives: 0.7 beats both, 0.2 beats one -> 3 of 4
    assert auc([0.7, 0.2, 0.4, 0.1], [True, True, False, False]) == 0.75


def test_margin_is_best_direct_minus_best_other():
    sims = {"setMapTheme": 0.6, "stopFeed": 0.5, "querySummary": 0.4}
    assert margin(sims, {}) == pytest.approx(0.2)


def test_an_about_document_counts_against_the_direct_tools():
    """A question about the theme lands closer to "asking about the theme" than to
    the theme command: the margin goes negative and the gate rejects it."""
    sims = {"setMapTheme": 0.6, "querySummary": 0.4}
    assert margin(sims, {"setMapTheme": 0.7}) == pytest.approx(-0.1)


def test_every_direct_tool_has_an_about_document_and_nothing_else_does():
    docs = about_documents()
    assert set(docs) == DIRECT_TOOLS
    assert all(isinstance(t, str) and len(t) > 40 for t in docs.values())
    raw = json.loads((EVAL / "fastpath_agent" / "fixtures" / "about_descriptions.json").read_text())
    assert "_comment" in raw
