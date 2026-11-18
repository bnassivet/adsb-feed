"""The agent alone against the agent with the desktop fast path, request by request.

    uv run python eval/eval_agent_step.py --mode full --context-placement user   # the agent alone
    ADSB_EVAL_TOOL_OVERRIDES=eval/fastpath_agent/fixtures/tool_overrides_v2.json \
        uv run python eval/fastpath_agent/eval_fast_path_compare.py --executor mistralai_ministral-3-3b

No model is called for the executor or the agent: both have already answered
every request, and their per-record files in ``results/`` are joined here.

  agent alone   ``agent-step-full-ctx-user-n<N>.jsonl``: the main agent's first
                reply with the ORIGINAL descriptions (what runs today)
  fast path     gate -> small executor (``executor-direct-<model><overlay>.jsonl``)
                -> the agent for whatever the executor did not carry out

For a direct command the agent's first reply is judged exactly like the
executor's (same tool, same argument values). For a request that belongs to the
agent, the fast path can only add a wrong action or a delay.

Latency is the time to the first tool call. For the agent that is a LOWER
bound on what the user waits: after the tool runs the agent makes a second
model call to write its reply, which the fast path does not need.
"""

from __future__ import annotations

import argparse
import collections
import json
import statistics
import sys
from pathlib import Path

if __package__ in (None, ""):  # run as a file: eval/ holds the shared modules
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import DATASET_VERSION, EVAL_DIR, load_tool_surface, overrides_tag, setup_mlflow

#: Executor outcomes that end on the desktop; the others fall through to the agent.
WRONG = ("wrong_args", "bad_args", "wrong", "acted")
ENDS_ON_DESKTOP = ("done", *WRONG)


def with_fast_path(agent: dict, gate_passes: bool, executor: dict, gate_s: float) -> dict:
    """Outcome and latency of one request when the fast path is in front of the agent."""
    if not gate_passes:
        return {
            "handled_by": "agent",
            "outcome": agent["outcome"],
            "latency_s": gate_s + agent["latency_s"],
        }
    if executor["outcome"] in ENDS_ON_DESKTOP:
        return {
            "handled_by": "desktop",
            "outcome": executor["outcome"],
            "latency_s": gate_s + executor["latency_s"],
        }
    return {
        "handled_by": "agent",
        "outcome": agent["outcome"],
        "latency_s": gate_s + executor["latency_s"] + agent["latency_s"],
    }


def _rows(path) -> dict[str, list[dict]]:
    by_question: dict[str, list[dict]] = collections.defaultdict(list)
    for line in path.read_text().splitlines():
        row = json.loads(line)
        by_question[row["question"]].append(row)
    return by_question


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--executor", required=True, help="e.g. mistralai_ministral-3-3b")
    parser.add_argument("--gate", choices=["embed", "embed+veto"], default="embed+veto")
    parser.add_argument(
        "--veto-below",
        type=float,
        default=0.5,
        help="with embed+veto: drop a request whose P(display command) is under this",
    )
    parser.add_argument("--agent-file", help="per-record file of the agent-alone run")
    parser.add_argument("--data", choices=["labels", "dataset"], default="dataset")
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    args = parser.parse_args()

    setup_mlflow()
    import mlflow
    from eval_ranker import data_params, load_records, needed_groups

    from fastpath_agent.decision_gate import build_questions
    from fastpath_agent.eval_decision_gate import collect
    from fastpath_agent.eval_executor import outcome
    from fastpath_agent.eval_route import DIRECT_TOOLS, cross_fitted, embed_scores

    records = load_records(args.data, None, args.dataset_version)
    truth = [r["expectations"]["route"] == "desktop" for r in records]
    keys = [json.dumps(r["inputs"], sort_keys=True, default=list) for r in records]
    surface = load_tool_surface()
    schemas = {t.name: t.parameters for t in surface}
    tag = overrides_tag()

    # --- the gate, with the descriptions the fast path would ship with
    embed, embed_ms = embed_scores(records, "with-history")
    passes, _ = cross_fitted([embed], truth, 0.95, keys=keys)
    gate_s = (embed_ms or 0) / 1000
    if args.gate == "embed+veto":
        direct = {t.name: t.description for t in surface if t.name in DIRECT_TOOLS}
        sig, d1_ms, _ = collect(records, build_questions(direct))
        passes = [p and s["command"] >= args.veto_below for p, s in zip(passes, sig, strict=True)]
        gate_s += d1_ms / 1000

    # --- what each model answered
    results = EVAL_DIR / "results"
    agent_path = (
        results / args.agent_file
        if args.agent_file
        else results / f"agent-step-full-ctx-user-n{len(records)}.jsonl"
    )
    agent_rows = _rows(agent_path)
    matches = [
        p
        for p in results.glob(f"executor-direct-{args.executor}*.jsonl")
        if (tag in p.name if tag else "tool_overrides" not in p.name)
    ]
    if len(matches) != 1:
        raise SystemExit(f"expected one executor file, found {[p.name for p in matches]}")
    executor_rows = {
        json.dumps({"question": r["question"], "history": r["history"]}, sort_keys=True): r
        for r in map(json.loads, matches[0].read_text().splitlines())
    }

    alone: dict[bool, list[dict]] = {True: [], False: []}
    fast: dict[bool, list[dict]] = {True: [], False: []}
    changed: list[str] = []
    for r, is_direct, key, gate_passes in zip(records, truth, keys, passes, strict=True):
        question = r["inputs"]["question"]
        reply = agent_rows[question][-1]  # the first row may be MLflow's trial call
        calls = [
            {"name": n, "args": a}
            for n, a in zip(reply["tool_calls"], reply["tool_args"], strict=True)
        ]
        if is_direct:
            agent_outcome = outcome("desktop", r["expectations"], calls, schemas)
        else:  # for an agent request: is the first step one of the needed tools?
            needed = {t for g in needed_groups(r["expectations"]) for t in g}
            ok = any(c["name"] in needed for c in calls) if needed else not calls
            agent_outcome = "first_step_ok" if ok else "first_step_other"
        agent = {"outcome": agent_outcome, "latency_s": reply["latency_s"]}
        combined = with_fast_path(agent, gate_passes, executor_rows[key], gate_s)
        alone[is_direct].append({"handled_by": "agent", **agent})
        fast[is_direct].append(combined)
        if is_direct and combined["outcome"] != agent_outcome:
            changed.append(f"{question[:60]:<60} {agent_outcome:>10} -> {combined['outcome']}")

    def summary(rows: list[dict]) -> dict:
        latencies = [x["latency_s"] for x in rows]
        return {
            "done": sum(x["outcome"] == "done" for x in rows),
            "wrong": sum(x["outcome"] in WRONG for x in rows),
            "desktop": sum(x["handled_by"] == "desktop" for x in rows),
            "median_s": statistics.median(latencies),
            "mean_s": statistics.mean(latencies),
            "total_s": sum(latencies),
        }

    a_direct, f_direct = summary(alone[True]), summary(fast[True])
    a_agent, f_agent = summary(alone[False]), summary(fast[False])
    n_direct, n_agent = len(alone[True]), len(alone[False])
    print(
        f"\nexecutor={matches[0].stem.removeprefix('executor-direct-')}  gate={args.gate} "
        f"gate passes {sum(p and t for p, t in zip(passes, truth, strict=True))} commands, "
        f"{sum(p and not t for p, t in zip(passes, truth, strict=True))} agent requests  "
        f"veto below {args.veto_below} ({gate_s * 1000:.0f} ms)  agent file={agent_path.name}\n"
    )
    print(f"{'':<46} {'agent alone':>12} {'with fast path':>15}")
    print(f"DIRECT COMMANDS ({n_direct})")
    for label, key, fmt in (
        ("carried out exactly", "done", "d"),
        ("wrong action shown", "wrong", "d"),
        ("handled on the desktop", "desktop", "d"),
        ("time to the action, median (s)", "median_s", ".2f"),
        ("time to the action, mean (s)", "mean_s", ".2f"),
    ):
        print(f"  {label:<44} {a_direct[key]:>12{fmt}} {f_direct[key]:>15{fmt}}")
    print(f"AGENT REQUESTS ({n_agent})")
    for label, key, fmt in (
        ("wrong action shown instead of an answer", "wrong", "d"),
        ("time to the agent's first step, mean (s)", "mean_s", ".2f"),
    ):
        print(f"  {label:<44} {a_agent[key]:>12{fmt}} {f_agent[key]:>15{fmt}}")
    total_alone = a_direct["total_s"] + a_agent["total_s"]
    total_fast = f_direct["total_s"] + f_agent["total_s"]
    print(f"ALL {len(records)} REQUESTS")
    print(f"  {'model time, total (s)':<44} {total_alone:>12.0f} {total_fast:>15.0f}")

    print("\ndirect commands whose result changes (agent alone -> with fast path):")
    for line in changed:
        print(f"   {line}")

    with mlflow.start_run(run_name=f"fast-path-compare-{args.executor}-{args.gate}{tag}"):
        mlflow.log_params(
            {
                "stage": "H-fast-path-compare",
                "executor": args.executor,
                "gate": args.gate,
                "agent_file": agent_path.name,
                **data_params(args.data, args.dataset_version),
            }
        )
        mlflow.log_metrics(
            {
                **{f"direct_alone_{k}": v for k, v in a_direct.items()},
                **{f"direct_fast_{k}": v for k, v in f_direct.items()},
                "agent_requests_fast_wrong": f_agent["wrong"],
                "agent_requests_alone_mean_s": a_agent["mean_s"],
                "agent_requests_fast_mean_s": f_agent["mean_s"],
                "all_alone_total_s": total_alone,
                "all_fast_total_s": total_fast,
            }
        )


if __name__ == "__main__":
    main()
