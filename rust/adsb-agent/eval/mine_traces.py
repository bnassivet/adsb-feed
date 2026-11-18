"""Mine real user questions, and the tools they led to, from the agent's traces.

    uv run python eval/mine_traces.py

Reads the ``chat_turn`` traces of the agent's MLflow experiment and writes
``data/candidates.jsonl``: one row per distinct user request with the tools the
agent called for it. These are **candidates**, not ground truth. What the agent
called is sometimes wrong (it once answered "start simulated flights" with
``toggleDemoFlights``), so the labels are reviewed by a person in
``data/labels.jsonl`` before anything is uploaded.

One user request usually spans several traces: the run that calls a client
tool ends, the browser executes it, and a second run carries the result back.
Those runs share a session and the same last user message, so they are grouped
and their tool calls merged.
"""

from __future__ import annotations

import argparse
from collections import defaultdict

from common import AGENT_EXPERIMENT, CANDIDATES_PATH, load_tool_surface, setup_mlflow, write_jsonl

#: Synthesized by the agent after generateSimulatedTrajectory; the model never
#: chooses it, so it is not something a ranker has to find.
NOT_MODEL_CHOSEN = {"applySimulatedTrajectory"}
MAX_HISTORY = 3


def user_texts(messages: list[dict]) -> list[str]:
    out = []
    for m in messages or []:
        if not isinstance(m, dict):  # an older trace shape: bare strings, no roles
            continue
        content = m.get("content")
        if m.get("role") == "user" and isinstance(content, str) and content.strip():
            out.append(content.strip())
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max-traces", type=int, default=5000)
    args = parser.parse_args()

    experiment = setup_mlflow(AGENT_EXPERIMENT)
    import mlflow

    known = {t.name for t in load_tool_surface()}
    traces = mlflow.search_traces(
        locations=[experiment.experiment_id],
        filter_string="trace.name = 'chat_turn'",
        max_results=args.max_traces,
        order_by=["timestamp_ms ASC"],
        return_type="list",
    )
    print(f"{len(traces)} chat_turn traces in '{AGENT_EXPERIMENT}'")

    # (session, number of user messages, question) identifies one user request.
    groups: dict[tuple, dict] = {}
    for trace in traces:
        root = next((s for s in trace.data.spans if s.parent_id is None), None)
        inputs = root.inputs if root is not None else None
        if not isinstance(inputs, dict):
            continue
        texts = user_texts(inputs.get("messages"))
        if not texts:
            continue
        key = (inputs.get("thread_id"), len(texts), texts[-1])
        group = groups.setdefault(
            key,
            {"question": texts[-1], "history": texts[:-1][-MAX_HISTORY:], "tools": [], "traces": []},
        )
        group["traces"].append(trace.info.trace_id)
        for span in trace.data.spans:
            if span.name.startswith("tool."):
                name = span.name.removeprefix("tool.")
                if name not in group["tools"]:
                    group["tools"].append(name)

    # The same request asked in several sessions is one dataset row. Keep every
    # distinct tool set seen for it: disagreement between sessions is exactly
    # what a reviewer needs to see.
    merged: dict[tuple, dict] = {}
    seen_sets: dict[tuple, list[list[str]]] = defaultdict(list)
    for group in groups.values():
        key = (group["question"].lower(), tuple(group["history"]))
        tools = [t for t in group["tools"] if t not in NOT_MODEL_CHOSEN]
        if sorted(tools) not in [sorted(s) for s in seen_sets[key]]:
            seen_sets[key].append(tools)
        row = merged.setdefault(
            key,
            {
                "question": group["question"],
                "history": group["history"],
                "expected_tools": [],
                "source": "trace",
                "times_asked": 0,
                "trace_ids": [],
            },
        )
        row["times_asked"] += 1
        row["trace_ids"] = (row["trace_ids"] + group["traces"])[:3]

    rows = []
    for key, row in merged.items():
        observed = seen_sets[key]
        union = [t for s in observed for t in s]
        row["expected_tools"] = list(dict.fromkeys(union))
        row["observed_tool_sets"] = observed
        row["unknown_tools"] = [t for t in row["expected_tools"] if t not in known]
        rows.append(row)
    rows.sort(key=lambda r: (-r["times_asked"], r["question"].lower()))

    write_jsonl(CANDIDATES_PATH, rows)
    with_tools = sum(1 for r in rows if r["expected_tools"])
    print(f"{len(rows)} distinct requests ({with_tools} with tool calls) -> {CANDIDATES_PATH}")


if __name__ == "__main__":
    main()
