"""Desktop or agent? A gate for requests a small local model can finish alone.

    uv run python eval/fastpath_agent/eval_route.py

The mechanism under test: before a request is sent to the agent, a gate decides
whether it is a **direct UI command** -- one a small model on the desktop can
carry out in a single step with browser-side tools (``DIRECT_TOOLS``). Those are
handled locally; everything else goes to the agent as today.

The two mistakes are not equally bad. A direct command sent to the agent only
costs time (today's behaviour). A question or a multi-step request sent to the
small model gets a wrong answer or none. So the gate is tuned for **precision**
(of what it sends to the desktop, how much really belongs there); **recall** is
the saving collected on top.

Gates, each producing a score per request ("how desktop-like"):
  d1        the decision model, one choice question: direct command or not
  embed     embedding similarity: best match among the direct tools minus best
            match among all other tools
  both      desktop only when d1 AND embed agree

A gate needs a threshold. Picking it on the same records it is scored on would
flatter it, so thresholds are **cross-fitted**: chosen on one half of the data
(the highest-recall threshold whose precision there is >= --target-precision),
applied to the other half, and the two halves pooled.

Ground truth is ``expectations.route`` (dataset v4 onwards).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path

import httpx

if __package__ in (None, ""):  # run as a file: eval/ holds the shared modules
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import DATASET_VERSION, load_tool_surface, overrides_tag, setup_mlflow
from decision_api import choice_probabilities
from eval_groups import DOC_PREFIX, QUERY_PREFIX, Embedder, cosine, query_text
from eval_ranker import data_params, load_records

from adsb_agent.fast_path import DIRECT_TOOLS  # what the service uses

#: Every browser-side tool that ACTS: the direct ones plus scenario and event
#: edits (with the two scenario lookups those need). A UI model holding all of
#: these can serve the broader class "UI action". Still not here: simulation
#: (generateSimulatedTrajectory runs inside the agent) and the read-only tools.
UI_TOOLS = DIRECT_TOOLS | frozenset(
    {
        "createEventOfInterest",
        "listScenarios",
        "getScenario",
        "createScenario",
        "renameScenario",
        "setScenarioDescription",
        "deleteScenario",
        "addTrajectoryToScenario",
        "removeTrackFromScenario",
        "setTrackStartOffset",
    }
)

D1_WORDING_UI = {
    "instructions": (
        "The user is talking to an aircraft-tracking map application. "
        "Is the user's message a command to change something in the application?"
    ),
    "criteria": {
        "desktop": (
            "A command to the application: show, hide or toggle a map layer, set a "
            "filter, history depth or colours, switch theme or mode, open or close the "
            "sidebar, pan the map, select an aircraft, start or stop the feed, or create, "
            "rename, describe, delete or edit a saved scenario, its tracks, or an event. "
            "Examples: 'show history', 'switch to night mode', 'delete the scenario X'."
        ),
        "agent": (
            "Anything else: a question, a request for information or statistics, "
            "a greeting, or a request to simulate or generate aircraft."
        ),
    },
}

D1_WORDING = {
    "instructions": (
        "The user is talking to an aircraft-tracking map application. "
        "Is the user's message a direct display command?"
    ),
    "criteria": {
        "desktop": (
            "A direct command about how the application looks or what the map shows, "
            "done in one step: show, hide, display or toggle a layer (history tracks, "
            "labels, range lines, density, events, wind barbs, weather, demo flights); "
            "set a filter, the history depth or track colours; switch day or night theme "
            "or live and analysis mode; open or close the sidebar; pan or zoom the map to "
            "given coordinates; select an aircraft by its identifier; start or stop the "
            "feed. Examples: 'show history', 'turn barbs on', 'switch to night mode'."
        ),
        "agent": (
            "Anything else: a question, a request for information or statistics, "
            "simulating or generating aircraft, creating or editing a scenario or an "
            "event, or a request that needs several steps or looking something up first."
        ),
    },
}


#: scope -> (tools the desktop model holds, label field, decision-model wording)
SCOPES = {
    "direct": (DIRECT_TOOLS, "route", "D1_WORDING"),
    "ui": (UI_TOOLS, "route_ui", "D1_WORDING_UI"),
}


def d1_scores(records: list[dict], query_mode: str, wording: dict | None = None):
    wording = wording or D1_WORDING

    async def run():
        out, latencies = [], []
        async with httpx.AsyncClient() as client:
            for r in records:
                history = list(r["inputs"].get("history") or [])
                started = time.perf_counter()
                p = await choice_probabilities(
                    wording["criteria"],
                    r["inputs"]["question"],
                    history if query_mode == "with-history" else [],
                    client,
                    instructions=wording["instructions"],
                )
                out.append(p["desktop"])
                latencies.append((time.perf_counter() - started) * 1000)
        return out, statistics.median(latencies)

    return asyncio.run(run())


def embed_scores(records: list[dict], query_mode: str, desktop_tools: frozenset = DIRECT_TOOLS):
    """Margin between the best desktop tool and the best other tool."""
    tools = load_tool_surface()
    embedder = Embedder()
    vecs = dict(
        zip(
            [t.name for t in tools],
            embedder.embed([DOC_PREFIX + t.description for t in tools]),
            strict=True,
        )
    )
    queries = embedder.embed([QUERY_PREFIX + query_text(r["inputs"], query_mode) for r in records])
    out = []
    for qv in queries:
        direct = max(cosine(qv, v) for n, v in vecs.items() if n in desktop_tools)
        other = max(cosine(qv, v) for n, v in vecs.items() if n not in desktop_tools)
        out.append(direct - other)
    latency = statistics.median(embedder.latencies_ms) if embedder.latencies_ms else None
    return out, latency


def precision_recall(truth: list[bool], decided: list[bool]) -> tuple[float, float, int, int]:
    tp = sum(t and d for t, d in zip(truth, decided, strict=True))
    fp = sum((not t) and d for t, d in zip(truth, decided, strict=True))
    fn = sum(t and not d for t, d in zip(truth, decided, strict=True))
    precision = tp / (tp + fp) if tp + fp else float("nan")
    recall = tp / (tp + fn) if tp + fn else float("nan")
    return precision, recall, fp, fn


def fit_threshold(scores: list[float], truth: list[bool], target: float) -> float:
    """The lowest threshold (so the highest recall) with precision >= target."""
    best = float("inf")  # send nothing to the desktop if the target is unreachable
    for threshold in sorted(set(scores), reverse=True):
        precision, _, _, _ = precision_recall(truth, [s >= threshold for s in scores])
        if precision >= target:
            best = threshold
    return best


def cross_fitted(
    score_sets: list[list[float]],
    truth: list[bool],
    target: float,
    seed: int = 0,
    keys: list[str] | None = None,
):
    """Decide each record with thresholds fitted on the OTHER half of the data.

    ``score_sets`` holds one score list per signal; a record goes to the desktop
    only if every signal clears its own threshold.

    Pass ``keys`` (a stable id per record) so the split does not depend on the
    order the server returns records in. Without it, re-publishing the dataset
    reshuffles the halves and moves the result: with 60 positives, one split
    gave 67% recall and another 47%. ``spread`` below reports that variance.
    """
    index = list(range(len(truth)))
    if keys is not None:
        index.sort(key=lambda i: keys[i])
    random.Random(seed).shuffle(index)
    half = len(index) // 2
    folds = [index[:half], index[half:]]
    decided = [False] * len(truth)
    thresholds = []
    for held_out in (0, 1):
        fit = folds[1 - held_out]
        fitted = [
            fit_threshold([s[i] for i in fit], [truth[i] for i in fit], target) for s in score_sets
        ]
        thresholds.append(fitted)
        for i in folds[held_out]:
            decided[i] = all(s[i] >= t for s, t in zip(score_sets, fitted, strict=True))
    return decided, thresholds


def spread(score_sets, truth, target, keys, seeds: int = 25) -> dict[str, float]:
    """Precision and recall over many different half/half splits."""
    precisions, recalls = [], []
    for seed in range(seeds):
        decided, _ = cross_fitted(score_sets, truth, target, seed, keys)
        precision, recall, _, _ = precision_recall(truth, decided)
        if precision == precision:  # not NaN: the gate passed something
            precisions.append(precision)
        recalls.append(recall)
    return {
        "precision_median": statistics.median(precisions) if precisions else float("nan"),
        "precision_min": min(precisions) if precisions else float("nan"),
        "recall_median": statistics.median(recalls),
        "recall_min": min(recalls),
        "recall_max": max(recalls),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--scope",
        choices=sorted(SCOPES),
        default="direct",
        help="direct: one-step display commands (15 tools); "
        "ui: every UI action, scenario and event edits included (25 tools)",
    )
    parser.add_argument("--query", choices=["question", "with-history"], default="with-history")
    parser.add_argument("--target-precision", type=float, default=0.95)
    parser.add_argument("--data", choices=["labels", "dataset"], default="dataset")
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    args = parser.parse_args()

    os.environ.setdefault("MLFLOW_GENAI_EVAL_MAX_WORKERS", "8")  # predict is a lookup
    setup_mlflow()
    import mlflow
    from mlflow.genai.scorers import scorer

    records = load_records(args.data, None, args.dataset_version)
    desktop_tools, label, wording_name = SCOPES[args.scope]
    if any(label not in r["expectations"] for r in records):
        raise SystemExit(f"this dataset version has no `{label}`; use a later version")
    data = data_params(args.data, args.dataset_version)
    truth = [r["expectations"][label] == "desktop" for r in records]
    keys = [json.dumps(r["inputs"], sort_keys=True, default=list) for r in records]

    d1, d1_latency = d1_scores(records, args.query, globals()[wording_name])
    embed, embed_latency = embed_scores(records, args.query, desktop_tools)
    gates = {
        "d1": ([d1], d1_latency),
        "embed": ([embed], embed_latency),
        "both": ([d1, embed], (d1_latency or 0) + (embed_latency or 0)),
    }

    @scorer
    def correct(outputs, expectations) -> bool:
        return outputs["route"] == expectations[label]

    print(
        f"\ndata={data['data']}  records={len(records)}  "
        f"scope={args.scope}  desktop={sum(truth)}  agent={len(truth) - sum(truth)}  "
        f"query={args.query}"
    )
    print(f"thresholds cross-fitted for precision >= {args.target_precision}\n")
    print(
        f"{'gate':<7} {'precision':>10} {'recall':>8} "
        f"{'wrongly to desktop':>19} {'missed':>7} {'latency':>9}"
    )
    wrong: dict[str, list[str]] = {}
    spreads: dict[str, dict[str, float]] = {}
    for name, (score_sets, latency) in gates.items():
        decided, thresholds = cross_fitted(score_sets, truth, args.target_precision, keys=keys)
        precision, recall, fp, fn = precision_recall(truth, decided)
        spreads[name] = spread(score_sets, truth, args.target_precision, keys)
        by_key = dict(zip(keys, decided, strict=True))

        def predict(question: str, history=None, _by_key=by_key) -> dict:
            inputs = {"question": question, "history": list(history or [])}
            return {"route": "desktop" if _by_key[json.dumps(inputs, sort_keys=True)] else "agent"}

        with mlflow.start_run(run_name=f"route-{args.scope}-{name}-{args.query}{overrides_tag()}"):
            mlflow.log_params(
                {
                    "stage": "D-route",
                    "gate": name,
                    "scope": args.scope,
                    "query": args.query,
                    "target_precision": args.target_precision,
                    "thresholds_fold_a": json.dumps([round(t, 4) for t in thresholds[0]]),
                    "thresholds_fold_b": json.dumps([round(t, 4) for t in thresholds[1]]),
                    "records": len(records),
                    **data,
                }
            )
            mlflow.genai.evaluate(data=records, predict_fn=predict, scorers=[correct])
            mlflow.log_metrics(
                {
                    "desktop_precision": precision if precision == precision else 0.0,
                    "desktop_recall": recall,
                    "desktop_precision_median_25_splits": spreads[name]["precision_median"],
                    "desktop_recall_median_25_splits": spreads[name]["recall_median"],
                    "desktop_recall_min_25_splits": spreads[name]["recall_min"],
                    "wrongly_to_desktop": fp,
                    "missed_desktop": fn,
                    **({"gate_latency_ms_p50": latency} if latency else {}),
                }
            )
        shown = f"{latency:.0f} ms" if latency else "cached"
        print(f"{name:<7} {precision:>10.3f} {recall:>8.3f} {fp:>19} {fn:>7} {shown:>9}")
        wrong[name] = [
            r["inputs"]["question"][:80].replace("\n", " ")
            for r, t, d in zip(records, truth, decided, strict=True)
            if d and not t
        ]

    print("\nover 25 different half/half splits (the single split above is one of them)")
    print(f"{'gate':<7} {'precision median (min)':>24} {'recall median (min-max)':>26}")
    for name, sp in spreads.items():
        print(
            f"{name:<7} {sp['precision_median']:>15.3f} ({sp['precision_min']:.3f}) "
            f"{sp['recall_median']:>15.3f} ({sp['recall_min']:.3f}-{sp['recall_max']:.3f})"
        )

    for name, questions in wrong.items():
        if questions:
            print(f"\n{name}: sent to the desktop but belong to the agent")
            for q in questions:
                print(f"   - {q}")

    print("\nscore sweep on all records (not cross-fitted; shows what each signal can do)")
    for name, scores in (("d1", d1), ("embed", embed)):
        print(f"  {name}: threshold  precision  recall")
        ranked = sorted(set(scores), reverse=True)
        for q in (0.1, 0.2, 0.3, 0.4, 0.5):
            threshold = ranked[min(int(len(ranked) * q), len(ranked) - 1)]
            p, r, _, _ = precision_recall(truth, [s >= threshold for s in scores])
            print(f"        {threshold:>9.3f} {p:>10.3f} {r:>7.3f}")


if __name__ == "__main__":
    main()
