"""The fast path as the service runs it, over the evaluation requests.

    uv run python eval/fastpath_agent/eval_fast_path_service.py
    uv run python eval/fastpath_agent/eval_fast_path_service.py --fit        # refit the gate threshold

The other fast-path scripts evaluate the parts (gate, veto, executor) and join
their results. This one calls ``adsb_agent.fast_path.try_fast_path`` itself --
the function behind the agent endpoint -- with the settings in force
(``ADSB_AGENT_FAST_PATH_*``), so it checks the thing that ships: the packaged
descriptions, the FIXED gate threshold, the veto, the executor and the
validation of its calls.

No tool is executed. Each handled request is judged like an executor reply
(``eval_executor.outcome``), and the result is combined with the agent-alone
run (``eval_agent_step.py``) for what the user ends up with.

``--fit`` prints the threshold giving 95% precision on these requests, to put
in ``fast_path_embed_threshold`` after changing the embedding model or the
packaged descriptions. It is fitted on every request, not cross-fitted: expect
slightly lower precision on new ones.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import statistics
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx

if __package__ in (None, ""):  # run as a file: eval/ holds the shared modules
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import DATASET_VERSION, EVAL_DIR, labels_tag, load_tool_surface, setup_mlflow
from eval_ranker import data_params, load_records, needed_groups

from adsb_agent import fast_path
from adsb_agent.config import settings
from fastpath_agent.eval_executor import outcome
from fastpath_agent.eval_fast_path_compare import WRONG, with_fast_path
from fastpath_agent.eval_route import fit_threshold, precision_recall


def as_messages(inputs: dict) -> list[SimpleNamespace]:
    """A record as the AG-UI messages of a run: earlier requests, then this one."""
    texts = [*(inputs.get("history") or []), inputs["question"]]
    return [SimpleNamespace(role="user", content=t) for t in texts]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fit", action="store_true", help="refit the gate threshold and stop")
    parser.add_argument("--target-precision", type=float, default=0.95)
    parser.add_argument("--agent-file", help="per-record file of the agent-alone run")
    parser.add_argument("--data", choices=["labels", "dataset"], default="dataset")
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    args = parser.parse_args()

    setup_mlflow()
    import mlflow

    settings.fast_path_enabled = True  # this script exists to run it
    settings.mlflow_enabled = False  # no span per request in the agent's experiment
    records = load_records(args.data, None, args.dataset_version)
    truth = [r["expectations"]["route"] == "desktop" for r in records]
    surface = load_tool_surface()  # the desktop's own descriptions; the service overlays its own
    schemas = {t.name: t.parameters for t in surface}

    if args.fit:
        described = fast_path.with_descriptions(surface)

        async def margins():
            async with httpx.AsyncClient() as client:
                return [
                    await fast_path.embed_margin(
                        r["inputs"]["question"],
                        list(r["inputs"].get("history") or []),
                        described,
                        client,
                    )
                    for r in records
                ]

        scores = asyncio.run(margins())
        threshold = fit_threshold(scores, truth, args.target_precision)
        precision, recall, fp, fn = precision_recall(truth, [s >= threshold for s in scores])
        print(
            f"fast_path_embed_threshold = {threshold:.4f}   "
            f"(precision {precision:.3f}, recall {recall:.3f}, "
            f"{fp} agent requests pass, {fn} commands missed; "
            f"model {settings.fast_path_embed_model})"
        )
        return

    async def run_all():
        async with httpx.AsyncClient() as client:
            return [
                await fast_path.try_fast_path(as_messages(r["inputs"]), surface, client=client)
                for r in records
            ]

    decisions = asyncio.run(run_all())

    agent_path = (
        EVAL_DIR
        / "results"
        / (args.agent_file or f"agent-step-full-ctx-user{labels_tag()}-n{len(records)}.jsonl")
    )
    agent_rows: dict[str, dict] = {}
    for line in agent_path.read_text().splitlines():
        row = json.loads(line)
        agent_rows[row["question"]] = row  # the last row wins (the first may be a trial call)

    reasons: dict[bool, collections.Counter] = {
        True: collections.Counter(),
        False: collections.Counter(),
    }
    alone: dict[bool, list[dict]] = {True: [], False: []}
    fast: dict[bool, list[dict]] = {True: [], False: []}
    shown_wrong: list[str] = []
    for r, is_direct, d in zip(records, truth, decisions, strict=True):
        reasons[is_direct][d.reason] += 1
        route = "desktop" if is_direct else "agent"
        executor_outcome = (
            outcome(route, r["expectations"], d.calls, schemas) if d.calls else "handoff"
        )
        reply = agent_rows[r["inputs"]["question"]]
        calls = [
            {"name": n, "args": a}
            for n, a in zip(reply["tool_calls"], reply["tool_args"], strict=True)
        ]
        if is_direct:
            agent_outcome = outcome("desktop", r["expectations"], calls, schemas)
        else:
            needed = {t for g in needed_groups(r["expectations"]) for t in g}
            ok = any(c["name"] in needed for c in calls) if needed else not calls
            agent_outcome = "first_step_ok" if ok else "first_step_other"
        agent = {"outcome": agent_outcome, "latency_s": reply["latency_s"]}
        spent = sum(d.timings_ms.values()) / 1000
        # Everything the fast path spent is already in `spent`, whether it handled
        # the request or not; the agent's time is added when it has to take over.
        combined = with_fast_path(
            agent, True, {"outcome": executor_outcome, "latency_s": spent}, 0.0
        )
        alone[is_direct].append({"handled_by": "agent", **agent})
        fast[is_direct].append(combined)
        if combined["handled_by"] == "desktop" and combined["outcome"] in WRONG:
            shown_wrong.append(
                f"[{route}] {r['inputs']['question'][:60]} -> "
                + ", ".join(f"{c['name']}({json.dumps(c['args'])})" for c in d.calls or [])
            )

    def summary(rows: list[dict]) -> dict:
        latencies = [x["latency_s"] for x in rows]
        return {
            "done": sum(x["outcome"] == "done" for x in rows),
            "wrong": sum(x["outcome"] in WRONG for x in rows),
            "desktop": sum(x["handled_by"] == "desktop" for x in rows),
            "median_s": statistics.median(latencies),
            "mean_s": statistics.mean(latencies),
        }

    a_d, f_d, a_a, f_a = (summary(x) for x in (alone[True], fast[True], alone[False], fast[False]))
    print(
        f"\nexecutor={settings.fast_path_model}  veto={'on' if settings.fast_path_veto_enabled else 'off'} "
        f"(below {settings.fast_path_veto_below})  gate threshold={settings.fast_path_embed_threshold}"
    )
    for label, is_direct in (("direct commands", True), ("agent requests", False)):
        counts = ", ".join(f"{k} {v}" for k, v in reasons[is_direct].most_common())
        print(f"  {label:<16} ({sum(reasons[is_direct].values())}): {counts}")
    print(f"\n{'':<46} {'agent alone':>12} {'with fast path':>15}")
    print(f"DIRECT COMMANDS ({len(alone[True])})")
    for label, key, fmt in (
        ("carried out exactly", "done", "d"),
        ("wrong action shown", "wrong", "d"),
        ("handled by the fast path", "desktop", "d"),
        ("time to the action, median (s)", "median_s", ".2f"),
        ("time to the action, mean (s)", "mean_s", ".2f"),
    ):
        print(f"  {label:<44} {a_d[key]:>12{fmt}} {f_d[key]:>15{fmt}}")
    print(f"AGENT REQUESTS ({len(alone[False])})")
    for label, key, fmt in (
        ("wrong action shown instead of an answer", "wrong", "d"),
        ("time to the agent's first step, mean (s)", "mean_s", ".2f"),
    ):
        print(f"  {label:<44} {a_a[key]:>12{fmt}} {f_a[key]:>15{fmt}}")
    print("\nwrong actions the fast path would show:")
    for line in shown_wrong:
        print(f"   {line}")

    with mlflow.start_run(
        run_name=f"fast-path-service-{settings.fast_path_model.replace('/', '_')}"
    ):
        mlflow.log_params(
            {
                "stage": "I-fast-path-service",
                "executor": settings.fast_path_model,
                "veto": settings.fast_path_veto_enabled,
                "veto_below": settings.fast_path_veto_below,
                "embed_threshold": settings.fast_path_embed_threshold,
                **data_params(args.data, args.dataset_version),
            }
        )
        mlflow.log_metrics(
            {
                **{f"direct_alone_{k}": v for k, v in a_d.items()},
                **{f"direct_fast_{k}": v for k, v in f_d.items()},
                "agent_requests_fast_wrong": f_a["wrong"],
                "agent_requests_fast_mean_s": f_a["mean_s"],
                "agent_requests_alone_mean_s": a_a["mean_s"],
            }
        )


if __name__ == "__main__":
    main()
