"""Stage A: how well does the decision model rank tools? No LLM involved.

    uv run python eval/eval_ranker.py                       # baseline wording, k=10
    uv run python eval/eval_ranker.py --wording match --top-k 6 8 10 12
    uv run python eval/eval_ranker.py --limit 5             # sanity run
    uv run python eval/eval_ranker.py --data labels         # draft labels, not yet published
    uv run python eval/eval_ranker.py --dataset-version 1   # an earlier published version

For every record the ranker scores all tools once; each ``--top-k`` value then
becomes its own MLflow run over the same scores, so a k sweep costs one pass.
Scores are cached per wording in ``eval/.cache`` (delete it, or pass
``--no-cache``, after changing a wording or the tool surface).

A record's expectation is ``expected_tools`` (every one must be selected) plus
``any_of`` (groups of interchangeable tools; one from each must be selected).

Scorers:
  full_recall      every needed tool was selected -- the one that decides
                   whether a turn can still be answered
  recall           fraction of needed tools selected
  k_needed         smallest top_k that would have given full recall
  token_reduction  share of tool-schema characters no longer sent
  tools_bound      how many tools were bound (top_k + pinned)
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import statistics
import time
from types import SimpleNamespace

import httpx
from common import (
    DATASET_VERSION,
    EVAL_DIR,
    LABELS_PATH,
    dataset_name,
    labels_sha256,
    load_tool_surface,
    read_jsonl,
    schema_chars,
    setup_mlflow,
)
from wordings import VARIANTS

from adsb_agent.config import settings
from adsb_agent.tool_ranker import pick, rank_tools

CACHE_DIR = EVAL_DIR / ".cache"
#: Never chosen by the model (the agent synthesizes the call), so ranking it is
#: noise. Excluded from the ranked surface, as the production path should too.
NOT_RANKED = {"applySimulatedTrajectory"}


def needed_groups(expectations: dict) -> list[list[str]]:
    """Every requirement as a group: one tool from each must be selected."""
    groups = [[t] for t in expectations.get("expected_tools") or []]
    groups += [list(g) for g in expectations.get("any_of") or [] if g]
    return groups


def k_needed(ranked: list[str], groups: list[list[str]], free: set[str]) -> int:
    """Smallest top_k giving full recall; ``free`` tools (pinned) cost nothing."""
    position = {name: i + 1 for i, name in enumerate(ranked)}
    worst = 0
    for group in groups:
        if any(t in free for t in group):
            continue
        worst = max(worst, min(position.get(t, len(ranked) + 1) for t in group))
    return worst


def data_params(source: str, version: int) -> dict:
    """What a run was evaluated on, logged so results stay comparable."""
    if source == "dataset":
        import mlflow.genai.datasets as datasets

        tags = datasets.get_dataset(name=dataset_name(version)).tags or {}
        return {
            "data": dataset_name(version),
            "labels_sha256": str(tags.get("labels_sha256", "unknown"))[:12],
        }
    return {"data": f"{LABELS_PATH.name} (working copy)", "labels_sha256": labels_sha256()[:12]}


def sample_records(records: list[dict], n: int | None, seed: int = 0) -> list[dict]:
    """A reproducible random subset, for evaluations too slow to run on everything.

    Sorted first so the sample does not depend on the order the server returns
    records in; the same ``n`` and ``seed`` always pick the same records.
    """
    if not n or n >= len(records):
        return records
    import random

    ordered = sorted(records, key=lambda r: json.dumps(r["inputs"], sort_keys=True))
    return random.Random(seed).sample(ordered, n)


def load_records(source: str, limit: int | None, version: int = DATASET_VERSION) -> list[dict]:
    if source == "dataset":
        import mlflow.genai.datasets as datasets

        df = datasets.get_dataset(name=dataset_name(version)).to_df()
        records = [
            {"inputs": row["inputs"], "expectations": row["expectations"]}
            for _, row in df.iterrows()
        ]
    else:
        records = [
            {
                "inputs": {"question": r["question"], "history": r["history"]},
                "expectations": {
                    "expected_tools": r["expected_tools"],
                    "any_of": r["any_of"],
                    "category": r["category"],
                    "route": r["route"],
                    "route_ui": r["route_ui"],
                    "is_simulation": r["is_simulation"],
                    **({"expected_calls": r["expected_calls"]} if "expected_calls" in r else {}),
                },
            }
            for r in read_jsonl(LABELS_PATH)
        ]
    return records[:limit] if limit else records


class Scores:
    """Decision-model scores per record, cached on disk per wording."""

    def __init__(
        self, wording_name: str, tools: list, use_cache: bool, question_type: str = "noul"
    ):
        self.variant = VARIANTS[wording_name]
        self.question_type = question_type
        self.tools = tools
        # What the model is shown: the variant may shorten each description.
        self.shown = [
            SimpleNamespace(name=t.name, description=self.variant.describe(t.description))
            for t in tools
        ]
        suffix = "" if question_type == "noul" else f"-{question_type}"
        self.path = CACHE_DIR / f"scores-{wording_name}{suffix}.json"
        self.use_cache = use_cache
        self.cache: dict[str, dict] = {}
        if use_cache and self.path.exists():
            self.cache = json.loads(self.path.read_text())

    @staticmethod
    def key(question: str, history: list[str]) -> str:
        return hashlib.sha1(json.dumps([question, history]).encode()).hexdigest()

    def get(self, question: str, history: list[str]) -> dict:
        key = self.key(question, history)
        if key not in self.cache:
            self.cache[key] = asyncio.run(self._rank(question, history))
        return self.cache[key]

    async def _rank(self, question: str, history: list[str]) -> dict:
        async with httpx.AsyncClient() as client:
            started = time.perf_counter()
            if self.question_type != "noul":
                # The wording's question templates do not apply to a choice
                # question, only its choice of description text.
                from decision_api import choice_probabilities, chunked_choice_probabilities

                if self.question_type == "choice-names":
                    # Names only: all tools fit in one question (512-token limit).
                    scores = await choice_probabilities(
                        {t.name: t.name for t in self.shown}, question, history, client
                    )
                else:  # choice-chunked
                    scores = await chunked_choice_probabilities(
                        {t.name: t.description for t in self.shown}, question, history, client
                    )
                return {"scores": scores, "latency_ms": (time.perf_counter() - started) * 1000}
            scores = await rank_tools(
                self.shown,
                question,
                history,
                client,
                url=settings.tool_ranker_url,
                model=settings.tool_ranker_model,
                timeout=30.0,
                wording=self.variant.wording,
            )
            return {"scores": scores, "latency_ms": (time.perf_counter() - started) * 1000}

    def save(self) -> None:
        if self.use_cache:
            CACHE_DIR.mkdir(exist_ok=True)
            self.path.write_text(json.dumps(self.cache))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--wording", default="baseline", choices=sorted(VARIANTS))
    parser.add_argument(
        "--question-type",
        choices=["noul", "choice-names", "choice-chunked"],
        default="noul",
        help="noul: one yes/no question per tool (what the agent ships); "
        "choice-names: one choice question over all tool names; "
        "choice-chunked: tools in chunks of 6 with descriptions, one choice question each",
    )
    parser.add_argument("--top-k", type=int, nargs="+", default=[10])
    parser.add_argument("--pinned", nargs="*", default=list(settings.tool_ranker_pinned))
    parser.add_argument(
        "--data",
        choices=["labels", "dataset"],
        default="dataset",
        help="'dataset': the published MLflow dataset version (default); "
        "'labels': the working copy of labels.jsonl, for drafts",
    )
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    parser.add_argument("--limit", type=int, help="only the first N records (sanity run)")
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args()

    # One record at a time: the default thread pool fires several ranking
    # requests at once, which roughly triples the latency being measured.
    os.environ.setdefault("MLFLOW_GENAI_EVAL_MAX_WORKERS", "1")
    setup_mlflow()
    import mlflow
    from mlflow.genai.scorers import scorer

    tools = [t for t in load_tool_surface() if t.name not in NOT_RANKED]
    full_chars = schema_chars(tools)
    records = load_records(args.data, args.limit, args.dataset_version)
    data = data_params(args.data, args.dataset_version)
    scores = Scores(args.wording, tools, not args.no_cache, args.question_type)
    pinned = set(args.pinned)

    @scorer
    def full_recall(outputs, expectations) -> bool:
        selected = set(outputs["selected"])
        return all(any(t in selected for t in g) for g in needed_groups(expectations))

    @scorer
    def recall(outputs, expectations) -> float:
        groups = needed_groups(expectations)
        if not groups:
            return 1.0
        selected = set(outputs["selected"])
        return sum(any(t in selected for t in g) for g in groups) / len(groups)

    @scorer(name="k_needed")
    def k_needed_scorer(outputs, expectations) -> int:
        return k_needed(outputs["ranked"], needed_groups(expectations), pinned)

    @scorer
    def token_reduction(outputs) -> float:
        return outputs["token_reduction"]

    @scorer
    def tools_bound(outputs) -> int:
        return len(outputs["selected"])

    summary = []
    for top_k in args.top_k:

        def predict(question: str, history: list[str] | None = None, _k: int = top_k) -> dict:
            result = scores.get(question, list(history or []))
            ranked = sorted(result["scores"], key=lambda n: -result["scores"][n])
            selected = pick(tools, result["scores"], top_k=_k, pinned=pinned)
            return {
                "selected": [t.name for t in selected],
                "ranked": ranked,
                "latency_ms": round(result["latency_ms"], 1),
                "token_reduction": round(1 - schema_chars(selected) / full_chars, 4),
            }

        label = args.wording if args.question_type == "noul" else args.question_type
        with mlflow.start_run(run_name=f"ranker-{label}-k{top_k}"):
            mlflow.log_params(
                {
                    "stage": "A-ranker",
                    "wording": args.wording,
                    "question_type": args.question_type,
                    "top_k": top_k,
                    "pinned": ",".join(sorted(pinned)),
                    "ranker_model": settings.tool_ranker_model,
                    "tools_ranked": len(tools),
                    "records": len(records),
                    **data,
                }
            )
            result = mlflow.genai.evaluate(
                data=records,
                predict_fn=predict,
                scorers=[full_recall, recall, k_needed_scorer, token_reduction, tools_bound],
            )
            latencies = [v["latency_ms"] for v in scores.cache.values()]
            mlflow.log_metric("ranker_latency_ms_p50", statistics.median(latencies))
            mlflow.log_metric("ranker_latency_ms_max", max(latencies))
            summary.append((top_k, result.metrics))
        scores.save()

    print(
        f"\nwording={args.wording}  question_type={args.question_type}  data={data['data']} ({data['labels_sha256']})  "
        f"records={len(records)}  pinned={sorted(pinned)}"
    )
    print(f"{'top_k':>5} {'full_recall':>12} {'recall':>8} {'token_red':>10} {'bound':>6}")
    for top_k, m in summary:
        print(
            f"{top_k:>5} {m.get('full_recall/mean', float('nan')):>12.3f} "
            f"{m.get('recall/mean', float('nan')):>8.3f} "
            f"{m.get('token_reduction/mean', float('nan')):>10.3f} "
            f"{m.get('tools_bound/mean', float('nan')):>6.1f}"
        )
    need = [
        k_needed(
            sorted(v["scores"], key=lambda n: -v["scores"][n]),
            needed_groups(r["expectations"]),
            pinned,
        )
        for r in records
        if (v := scores.cache.get(Scores.key(r["inputs"]["question"], r["inputs"]["history"])))
    ]
    failed = len(records) - len(need)
    if failed:
        # mlflow.genai.evaluate averages over the records whose prediction
        # succeeded, so a failure silently flatters the means above.
        print(f"WARNING: {failed} of {len(records)} records failed and are NOT in the means")
    if need:
        qs = statistics.quantiles(need, n=20) if len(need) > 1 else [need[0]] * 19
        print(
            f"k needed for full recall: median {statistics.median(need):.0f}, "
            f"p90 {qs[17]:.0f}, p95 {qs[18]:.0f}, max {max(need)}"
        )
    lat = [v["latency_ms"] for v in scores.cache.values()]
    print(f"ranker latency: median {statistics.median(lat):.0f} ms, max {max(lat):.0f} ms")


if __name__ == "__main__":
    main()
