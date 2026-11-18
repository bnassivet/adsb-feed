"""What one request costs and yields with the fast path, against the agent alone.

With the fast path a request first meets the gate, then (if it passes) the
small executor; whatever the executor does not carry out goes on to the agent,
having already paid for the gate and the executor.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "eval"))

from fastpath_agent.eval_fast_path_compare import with_fast_path  # noqa: E402

AGENT = {"outcome": "done", "latency_s": 3.0}
GATE_S = 0.1


def run(gate_passes: bool, executor: dict, agent: dict = AGENT) -> dict:
    return with_fast_path(agent, gate_passes, executor, GATE_S)


class TestWithFastPath:
    def test_a_rejected_request_goes_to_the_agent_and_pays_for_the_gate(self):
        out = run(False, {"outcome": "done", "latency_s": 0.3})
        assert out["handled_by"] == "agent"
        assert out["outcome"] == "done"
        assert out["latency_s"] == pytest.approx(3.1)

    def test_a_command_the_executor_carries_out_never_reaches_the_agent(self):
        out = run(True, {"outcome": "done", "latency_s": 0.3})
        assert out["handled_by"] == "desktop"
        assert out["latency_s"] == pytest.approx(0.4)

    @pytest.mark.parametrize("declined", ["handoff", "nothing", "error"])
    def test_a_declined_request_pays_for_gate_executor_and_agent(self, declined):
        out = run(True, {"outcome": declined, "latency_s": 0.3})
        assert out["handled_by"] == "agent"
        assert out["outcome"] == "done"
        assert out["latency_s"] == pytest.approx(3.4)

    @pytest.mark.parametrize("wrong", ["wrong_args", "bad_args", "wrong", "acted"])
    def test_a_wrong_action_is_shown_and_the_agent_is_not_asked(self, wrong):
        """The harm case: the user sees the action, and no answer follows."""
        out = run(True, {"outcome": wrong, "latency_s": 0.3})
        assert out["handled_by"] == "desktop"
        assert out["outcome"] == wrong
        assert out["latency_s"] == pytest.approx(0.4)

    def test_the_agents_own_mistake_is_kept_when_it_handles_the_request(self):
        out = run(
            False,
            {"outcome": "done", "latency_s": 0.3},
            {"outcome": "wrong_args", "latency_s": 2.0},
        )
        assert out["outcome"] == "wrong_args"
