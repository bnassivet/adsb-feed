"""The decision model reading the tool descriptions: gate, veto, and tool pick.

    uv run python eval/fastpath_agent/eval_decision_gate.py
    ADSB_EVAL_TOOL_OVERRIDES=eval/fastpath_agent/fixtures/tool_overrides_v2.json \
        uv run python eval/fastpath_agent/eval_decision_gate.py

One request per record carries the questions of ``decision_gate.py`` (kind of
message, family of display commands, one tool choice per family with the tools'
full descriptions). Reported:

  gates     the decision model alone (thresholds cross-fitted like
            ``eval_route.py``), the embedding gate, and the embedding gate
            with the decision model's veto (no fitted threshold: a request is
            dropped when "display command" scores under 0.5)
  tool      how often the tool the decision model names is the expected one
  pipeline  for every executor result file of the same descriptions
            (``eval_executor.py`` writes them), what reaches the user with the
            embedding gate alone and with the veto added

The executor files hold each model's reply to EVERY request, so a different
gate is applied to them here without running the executors again.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import statistics
import sys
import time
from pathlib import Path

import httpx

if __package__ in (None, ""):  # run as a file: eval/ holds the shared modules
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import DATASET_VERSION, EVAL_DIR, load_tool_surface, overrides_tag, setup_mlflow
from eval_ranker import data_params, load_records, needed_groups

from fastpath_agent.decision_gate import ask, build_questions, signals
from fastpath_agent.eval_route import (
    DIRECT_TOOLS,
    cross_fitted,
    embed_scores,
    precision_recall,
    spread,
)

#: Executor outcomes the user sees as a wrong action (see eval_executor.py).
WRONG = {"wrong_args", "bad_args", "wrong", "acted"}


def collect(records: list[dict], questions: dict) -> tuple[list[dict], float, float]:
    """Signals per record, median latency (ms) and median input tokens."""

    async def run():
        out, latencies, tokens = [], [], []
        async with httpx.AsyncClient() as client:
            for r in records:
                started = time.perf_counter()
                answers, used = await ask(
                    questions,
                    r["inputs"]["question"],
                    list(r["inputs"].get("history") or []),
                    client,
                )
                latencies.append((time.perf_counter() - started) * 1000)
                tokens.append(used)
                out.append(signals(answers))
        return out, statistics.median(latencies), statistics.median(tokens)

    return asyncio.run(run())


def pipeline(rows: list[dict], passes: dict[str, bool]) -> tuple[int, int]:
    """(commands done on the desktop, wrong actions shown) under a gate."""
    done = wrong = 0
    for row in rows:
        key = json.dumps({"question": row["question"], "history": row["history"]}, sort_keys=True)
        if not passes[key]:
            continue
        done += row["route"] == "desktop" and row["outcome"] == "done"
        wrong += row["outcome"] in WRONG
    return done, wrong


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target-precision", type=float, default=0.95)
    parser.add_argument("--data", choices=["labels", "dataset"], default="dataset")
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    args = parser.parse_args()

    setup_mlflow()
    import mlflow

    records = load_records(args.data, None, args.dataset_version)
    truth = [r["expectations"]["route"] == "desktop" for r in records]
    keys = [json.dumps(r["inputs"], sort_keys=True, default=list) for r in records]
    direct = {t.name: t.description for t in load_tool_surface() if t.name in DIRECT_TOOLS}

    sig, latency, tokens = collect(records, build_questions(direct))
    embed, _ = embed_scores(records, "with-history")
    veto = [s["vetoed"] for s in sig]

    print(
        f"\nrecords={len(records)}  direct commands={sum(truth)}  "
        f"decision request: {latency:.0f} ms, {tokens:.0f} input tokens (medians)\n"
    )
    print(
        f"{'gate':<28} {'precision':>9} {'recall':>7} {'wrong':>6} {'missed':>7}   "
        "25 splits: precision median (min), recall median (min-max)"
    )
    metrics: dict[str, float] = {"decision_latency_ms_p50": latency, "decision_tokens_p50": tokens}
    decisions: dict[str, list[bool]] = {}

    def report(name: str, score_sets: list[list[float]], vetoed: list[bool] | None = None):
        def decide(seed: int = 0) -> list[bool]:
            decided, _ = cross_fitted(score_sets, truth, args.target_precision, seed, keys)
            return [d and not (vetoed and vetoed[i]) for i, d in enumerate(decided)]

        decided = decide()
        precision, recall, fp, fn = precision_recall(truth, decided)
        if vetoed is None:
            sp = spread(score_sets, truth, args.target_precision, keys)
            tail = (
                f"{sp['precision_median']:.3f} ({sp['precision_min']:.3f}), "
                f"{sp['recall_median']:.3f} ({sp['recall_min']:.3f}-{sp['recall_max']:.3f})"
            )
        else:  # the veto is applied after the fitted gate, on each split
            runs = [precision_recall(truth, decide(seed)) for seed in range(25)]
            ps, rs = [r[0] for r in runs if r[0] == r[0]], [r[1] for r in runs]
            tail = (
                f"{statistics.median(ps):.3f} ({min(ps):.3f}), "
                f"{statistics.median(rs):.3f} ({min(rs):.3f}-{max(rs):.3f})"
            )
        print(f"{name:<28} {precision:>9.3f} {recall:>7.3f} {fp:>6} {fn:>7}   {tail}")
        slug = name.replace(" ", "_").replace("+", "and")
        metrics[f"{slug}_precision"] = precision if precision == precision else 0.0
        metrics[f"{slug}_recall"] = recall
        decisions[name] = decided

    report("d1 command", [[s["command"] for s in sig]])
    report("d1 command x family", [[s["command_family"] for s in sig]])
    report("d1 command x family x tool", [[s["command_family_tool"] for s in sig]])
    report("embed", [embed])
    report("embed + d1 veto", [embed], veto)

    right = sum(
        s["tool"] in {t for g in needed_groups(r["expectations"]) for t in g}
        for r, s, t in zip(records, sig, truth, strict=True)
        if t
    )
    metrics["d1_tool_right_on_direct"] = right
    print(f"\ntool named by the decision model is an expected one: {right} of {sum(truth)}")

    for name in ("embed", "embed + d1 veto"):
        sent = [
            r["inputs"]["question"][:70]
            for r, t, d in zip(records, truth, decisions[name], strict=True)
            if d and not t
        ]
        print(f"\n{name}: sent to the desktop but belong to the agent")
        for q in sent:
            print(f"   - {q}")
    lost = [
        r["inputs"]["question"][:70]
        for r, t, a, b in zip(
            records, truth, decisions["embed"], decisions["embed + d1 veto"], strict=True
        )
        if t and a and not b
    ]
    print("\ndirect commands the veto drops:")
    for q in lost:
        print(f"   - {q}")

    tag = overrides_tag()
    files = sorted((EVAL_DIR / "results").glob("executor-direct-*.jsonl"))
    # Only the runs made with the same descriptions as this one.
    files = [f for f in files if (tag in f.name if tag else "tool_overrides" not in f.name)]
    if files:
        print(f"\n{'executor (done / wrong actions)':<52} {'embed':>10} {'embed + d1 veto':>18}")
    for path in files:
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        if collections.Counter(r["question"] for r in rows).total() != len(records):
            continue  # a --limit or --sample run
        cells = []
        for name in ("embed", "embed + d1 veto"):
            done, wrong = pipeline(rows, dict(zip(keys, decisions[name], strict=True)))
            cells.append(f"{done} / {wrong}")
            slug = path.stem.removeprefix("executor-direct-").replace(tag, "")
            metrics[f"{slug}_{'veto' if 'veto' in name else 'embed'}_done"] = done
            metrics[f"{slug}_{'veto' if 'veto' in name else 'embed'}_wrong"] = wrong
        model = path.stem.removeprefix("executor-direct-").replace(tag, "")
        print(f"{model:<52} {cells[0]:>10} {cells[1]:>18}")

    with mlflow.start_run(run_name=f"decision-gate{tag}"):
        mlflow.log_params(
            {
                "stage": "G-decision-gate",
                "target_precision": args.target_precision,
                "records": len(records),
                **data_params(args.data, args.dataset_version),
            }
        )
        mlflow.log_metrics(
            {k.replace("/", "_").replace("(", "").replace(")", ""): v for k, v in metrics.items()}
        )


if __name__ == "__main__":
    main()
