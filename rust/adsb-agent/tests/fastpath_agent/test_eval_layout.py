"""The eval package layout: shared modules in ``eval/``, the fast path
experiment in ``eval/fastpath_agent/``.

The scripts are run as files from ``rust/adsb-agent`` (so the agent's ``.env``
is read), not as modules. A script in the subpackage therefore has to put
``eval/`` on the path itself to reach the shared modules.
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "eval"
FASTPATH = EVAL / "fastpath_agent"

SCRIPTS = sorted(
    p.relative_to(ROOT) for p in FASTPATH.glob("*.py") if '__name__ == "__main__"' in p.read_text()
)


def test_the_experiment_scripts_are_found():
    assert len(SCRIPTS) == 6


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.stem)
def test_each_script_starts_from_the_agent_directory(script):
    result = subprocess.run(
        [sys.executable, str(script), "--help"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert "usage" in result.stdout.lower()


def test_shared_modules_do_not_depend_on_the_experiment():
    """The dependency goes one way: fastpath_agent uses eval/, never the reverse."""
    for path in EVAL.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and node.module:
                assert not node.module.startswith("fastpath_agent"), path.name
            if isinstance(node, ast.Import):
                assert all(not a.name.startswith("fastpath_agent") for a in node.names), path.name
