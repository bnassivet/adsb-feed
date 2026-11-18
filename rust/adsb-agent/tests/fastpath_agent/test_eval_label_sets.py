"""The fast path experiment's own label sets: well formed, and fresh against
every set written before them.

``validation_labels.jsonl`` (176) and ``holdout_labels.jsonl`` (137) are read
through ``ADSB_EVAL_LABELS``, so they must load like the main ``labels.jsonl``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

EVAL = Path(__file__).resolve().parents[2] / "eval"

#: The main set stays with the shared code; the fast path experiment's own
#: sets live in its subpackage.
MAIN = EVAL / "data" / "labels.jsonl"
VALIDATION = EVAL / "fastpath_agent" / "data" / "validation_labels.jsonl"
HOLDOUT = EVAL / "fastpath_agent" / "data" / "holdout_labels.jsonl"


def _rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _questions(*paths: Path) -> set[str]:
    return {r["question"].strip().lower() for path in paths for r in _rows(path)}


@pytest.mark.parametrize(
    ("path", "earlier"),
    [
        (VALIDATION, (MAIN,)),
        # The blind test for the gate fixes: fresh against both earlier sets.
        (HOLDOUT, (MAIN, VALIDATION)),
    ],
    ids=lambda v: v.stem if isinstance(v, Path) else None,
)
def test_extra_labels_are_well_formed(path, earlier):
    """Every record loads like a labels.jsonl record, shares no question with
    the sets written before it, and a direct command names the tools its
    expected calls use."""
    rows = _rows(path)
    tools = {
        t["name"]
        for t in json.loads((EVAL / "fixtures" / "tool_surface.json").read_text())["tools"]
    }
    seen = _questions(*earlier)

    questions = [r["question"] for r in rows]
    assert len(set(questions)) == len(questions), "results are keyed by question"
    for r in rows:
        assert r["question"].strip().lower() not in seen, f"not fresh: {r['question']}"
        assert r["route"] in ("desktop", "agent")
        for key in ("history", "expected_tools", "any_of", "category", "route_ui", "is_simulation"):
            assert key in r, f"{r['id']} lacks {key}"
        if r["route"] == "desktop":
            assert r["expected_calls"], r["id"]
            named = {c["tool"] for alt in r["expected_calls"] for c in alt}
            assert named <= tools, r["id"]
            needed = set(r["expected_tools"]) | {t for g in r["any_of"] for t in g}
            assert needed == named, r["id"]
        else:
            assert "expected_calls" not in r, r["id"]
