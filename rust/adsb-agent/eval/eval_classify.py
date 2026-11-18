"""Can the decision model tell what KIND of request this is?

    uv run python eval/eval_classify.py                    # every wording
    uv run python eval/eval_classify.py --wording guided --query question

A thinner use of the decision model than picking tools: one ``choice`` question
with three options --

  ui_action        the user tells the application to do or change something
  simple_question  the user wants information; one lookup at most
  multi_step       answering needs several dependent steps and reasoning

-- which is the kind of signal a router needs (fast path, tool subset, whether
to let the LLM reason). Ground truth is ``expectations.category`` in the dataset
(v2 onwards; see README for how it was labelled).

Reports accuracy, per-class precision and recall, the confusion matrix, and
accuracy against the model's own confidence: a router can act on confident
answers and fall back to the full agent on the rest.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import time

import httpx
from common import DATASET_VERSION, setup_mlflow
from decision_api import choice_probabilities
from eval_ranker import data_params, load_records

CATEGORIES = ("ui_action", "simple_question", "multi_step")

WORDINGS: dict[str, dict] = {
    # The three classes as named in the request for this experiment, nothing more.
    "plain": {
        "instructions": "What kind of request is the user's message?",
        "criteria": {
            "ui_action": "UI action.",
            "simple_question": "Simple question.",
            "multi_step": "Question that needs reasoning and multiple steps.",
        },
    },
    # A generic definition of each class, no knowledge of this application.
    "defined": {
        "instructions": "What kind of request is the user's message?",
        "criteria": {
            "ui_action": (
                "A command: the user tells the application to do, show, hide, change, "
                "create or delete something."
            ),
            "simple_question": (
                "A simple question or remark: the user wants one piece of information "
                "that a single lookup answers, or is just chatting."
            ),
            "multi_step": (
                "A question that needs reasoning and multiple steps: several lookups, "
                "a comparison or computation, or finding something first and then using it."
            ),
        },
    },
    # The same, spelling out what makes a request multi-step in THIS application.
    "guided": {
        "instructions": (
            "The user is talking to the assistant of an aircraft-tracking application. "
            "What kind of request is the user's message?"
        ),
        "criteria": {
            "ui_action": (
                "A command to the application: change the map, a layer, a filter, the "
                "theme or mode, start or stop the feed, simulate aircraft, create, edit or "
                "delete a scenario or an event."
            ),
            "simple_question": (
                "A simple question or remark answered by one lookup: the live aircraft "
                "right now, feed status, stored totals, the wind, one aircraft's "
                "trajectory, counts or statistics for one time period such as today or "
                "the last hour, a listing, a greeting or a general question."
            ),
            "multi_step": (
                "A request needing several dependent steps: find an aircraft and then "
                "look up or do something with it, compare two periods or two results, "
                "or combine several different lookups."
            ),
        },
    },
}


def classify_all(records: list[dict], wording: dict, query_mode: str):
    async def run():
        out, latencies = [], []
        async with httpx.AsyncClient() as client:
            for r in records:
                history = list(r["inputs"].get("history") or [])
                started = time.perf_counter()
                out.append(
                    await choice_probabilities(
                        wording["criteria"],
                        r["inputs"]["question"],
                        history if query_mode == "with-history" else [],
                        client,
                        instructions=wording["instructions"],
                    )
                )
                latencies.append((time.perf_counter() - started) * 1000)
        return out, statistics.median(latencies)

    return asyncio.run(run())


def report(truth: list[str], predicted: list[str], confidence: list[float]) -> dict:
    """Per-class precision/recall, confusion matrix, accuracy by confidence."""
    metrics: dict[str, float] = {}
    n = len(truth)
    metrics["accuracy"] = sum(t == p for t, p in zip(truth, predicted, strict=True)) / n

    print(f"\n{'':<17}" + "".join(f"{'-> ' + c:>19}" for c in CATEGORIES) + f"{'recall':>9}")
    for actual in CATEGORIES:
        row = [
            sum(t == actual and p == c for t, p in zip(truth, predicted, strict=True))
            for c in CATEGORIES
        ]
        total = sum(row)
        recall = row[CATEGORIES.index(actual)] / total if total else float("nan")
        metrics[f"recall_{actual}"] = recall
        print(f"{actual:<17}" + "".join(f"{v:>19}" for v in row) + f"{recall:>9.3f}")
    precisions = []
    for c in CATEGORIES:
        said = sum(p == c for p in predicted)
        right = sum(t == c and p == c for t, p in zip(truth, predicted, strict=True))
        precision = right / said if said else float("nan")
        metrics[f"precision_{c}"] = precision
        precisions.append(precision)
    print(f"{'precision':<17}" + "".join(f"{v:>19.3f}" for v in precisions))
    metrics["macro_recall"] = statistics.mean(metrics[f"recall_{c}"] for c in CATEGORIES)

    print("\nconfidence >=   share of requests   accuracy on those")
    for threshold in (0.0, 0.5, 0.7, 0.9):
        kept = [
            t == p
            for t, p, c in zip(truth, predicted, confidence, strict=True)
            if c >= threshold
        ]
        if kept:
            share, acc = len(kept) / n, sum(kept) / len(kept)
            print(f"{threshold:>13.1f} {share:>19.3f} {acc:>19.3f}")
            if threshold:
                key = str(threshold).replace(".", "")
                metrics[f"coverage_conf{key}"] = share
                metrics[f"accuracy_conf{key}"] = acc
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--wording", nargs="+", choices=sorted(WORDINGS), default=sorted(WORDINGS))
    parser.add_argument("--query", choices=["question", "with-history"], default="with-history")
    parser.add_argument("--data", choices=["labels", "dataset"], default="dataset")
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    args = parser.parse_args()

    os.environ.setdefault("MLFLOW_GENAI_EVAL_MAX_WORKERS", "8")  # predict is a lookup
    setup_mlflow()
    import mlflow
    from mlflow.genai.scorers import scorer

    records = load_records(args.data, None, args.dataset_version)
    if any("category" not in r["expectations"] for r in records):
        raise SystemExit("this dataset version has no `category`; use version 2 or later")
    data = data_params(args.data, args.dataset_version)
    truth = [r["expectations"]["category"] for r in records]

    @scorer
    def correct(outputs, expectations) -> bool:
        return outputs["category"] == expectations["category"]

    @scorer
    def confidence(outputs) -> float:
        return outputs["confidence"]

    for name in args.wording:
        probabilities, latency_ms = classify_all(records, WORDINGS[name], args.query)
        by_key = {
            json.dumps(r["inputs"], sort_keys=True, default=list): p
            for r, p in zip(records, probabilities, strict=True)
        }

        def predict(question: str, history=None, _by_key=by_key) -> dict:
            inputs = {"question": question, "history": list(history or [])}
            p = _by_key[json.dumps(inputs, sort_keys=True)]
            best = max(p, key=p.get)
            return {
                "category": best,
                "confidence": round(p[best], 4),
                "probabilities": {k: round(v, 4) for k, v in p.items()},
            }

        predicted = [max(p, key=p.get) for p in probabilities]
        confidences = [max(p.values()) for p in probabilities]
        print(
            f"\n=== wording={name}  query={args.query}  data={data['data']}  "
            f"records={len(records)}  latency median {latency_ms:.0f} ms ==="
        )
        with mlflow.start_run(run_name=f"classify-{name}-{args.query}"):
            mlflow.log_params(
                {
                    "stage": "C-classify",
                    "wording": name,
                    "query": args.query,
                    "question_type": "choice",
                    "categories": ",".join(CATEGORIES),
                    "records": len(records),
                    **data,
                }
            )
            mlflow.genai.evaluate(data=records, predict_fn=predict, scorers=[correct, confidence])
            metrics = report(truth, predicted, confidences)
            mlflow.log_metrics({**metrics, "classifier_latency_ms_p50": latency_ms})
        print(f"accuracy {metrics['accuracy']:.3f}   macro recall {metrics['macro_recall']:.3f}")


if __name__ == "__main__":
    main()
