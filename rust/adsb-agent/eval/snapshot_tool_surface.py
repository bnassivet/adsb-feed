"""Snapshot the tool surface the agent really binds, from a recorded LLM request.

    uv run python eval/snapshot_tool_surface.py [--trace-id tr-...]

Takes the ``tools`` array from the ``AsyncCompletions`` span of the most recent
``chat_turn`` trace that has one (or the given trace) and writes
``fixtures/tool_surface.json``. Re-run after the desktop's tools change, so the
evaluation ranks the list production sends rather than a stale copy.
"""

from __future__ import annotations

import argparse
import json

from common import AGENT_EXPERIMENT, TOOL_SURFACE_PATH, setup_mlflow


def tools_of(trace) -> list[dict] | None:
    for span in trace.data.spans:
        inputs = span.inputs
        if isinstance(inputs, dict) and inputs.get("tools"):
            return [t["function"] for t in inputs["tools"] if "function" in t]
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--trace-id", help="take the tools from this trace")
    args = parser.parse_args()

    experiment = setup_mlflow(AGENT_EXPERIMENT)
    import mlflow

    if args.trace_id:
        traces = [mlflow.get_trace(args.trace_id)]
    else:
        traces = mlflow.search_traces(
            locations=[experiment.experiment_id],
            max_results=50,
            order_by=["timestamp_ms DESC"],
            return_type="list",
        )
    # Only an unranked request shows the whole surface. A run made with the
    # ranker on carries a `tool_ranker` span and a shortened list.
    for trace in traces:
        if any(s.name == "tool_ranker" for s in trace.data.spans):
            continue
        tools = tools_of(trace)
        if tools:
            TOOL_SURFACE_PATH.parent.mkdir(parents=True, exist_ok=True)
            TOOL_SURFACE_PATH.write_text(
                json.dumps({"source_trace": trace.info.trace_id, "tools": tools}, indent=2) + "\n"
            )
            print(f"{len(tools)} tools from {trace.info.trace_id} -> {TOOL_SURFACE_PATH}")
            return
    raise SystemExit("no recent trace with a full tool list; pass --trace-id")


if __name__ == "__main__":
    main()
