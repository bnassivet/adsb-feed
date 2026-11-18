"""Group retrieval: pick tool *families* for a request, then bind their tools.

    uv run python eval/eval_groups.py --method embed-desc --top-g 1 2 3 4
    uv run python eval/eval_groups.py --method embed-tools --query with-history
    uv run python eval/eval_groups.py --method d1 --top-g 2 3

Methods (how a family is scored against the request):
  embed-desc    cosine similarity to the family's hand-written description
  embed-tools   best cosine similarity among the family's tool descriptions
  embed-both    the higher of the two above
  d1            the decision model, one yes/no (noul) question per family
  d1-choice     the decision model, ONE choice question over all families;
                families are ranked by the probability it gives each

``--query question`` embeds the request alone; ``with-history`` prepends the
previous user messages, so "and now?" carries what it refers to.

The ``top_g`` best families are bound, plus the always-on tools (groups.ALWAYS).
One MLflow run per ``top_g``. Scorers are the stage A ones, with ``g_needed``
(families needed for full recall) in place of ``k_needed``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import statistics
import time
from types import SimpleNamespace

import httpx
from common import DATASET_VERSION, EVAL_DIR, load_tool_surface, schema_chars, setup_mlflow
from eval_ranker import data_params, load_records, needed_groups
from groups import ALWAYS, GROUP_OF, GROUPS, check_covers

from adsb_agent.config import settings
from adsb_agent.tool_ranker import QuestionWording, rank_tools

EMBED_URL = os.environ.get(
    "ADSB_EVAL_EMBED_URL", "http://localhost:5010/gateway/openai/v1/embeddings"
)
EMBED_MODEL = os.environ.get("ADSB_EVAL_EMBED_MODEL", "lmstudio-embeddinggemma-300m")
CACHE_PATH = EVAL_DIR / ".cache" / "embeddings.json"

# EmbeddingGemma is trained with task prefixes; retrieval is asymmetric.
QUERY_PREFIX = "task: search result | query: "
DOC_PREFIX = "title: none | text: "

GROUP_WORDING = QuestionWording(
    instructions="Is the user's request about this? {description}",
    true="Yes, the request is about this.",
    false="No, the request is about something else.",
)


class Embedder:
    """Embeddings with an on-disk cache keyed by model and text."""

    def __init__(self) -> None:
        self.cache: dict[str, list[float]] = {}
        if CACHE_PATH.exists():
            self.cache = json.loads(CACHE_PATH.read_text())
        self.latencies_ms: list[float] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        missing = [t for t in dict.fromkeys(texts) if self._key(t) not in self.cache]
        for start in range(0, len(missing), 32):
            batch = missing[start : start + 32]
            started = time.perf_counter()
            resp = httpx.post(
                EMBED_URL, json={"model": EMBED_MODEL, "input": batch}, timeout=120.0
            )
            resp.raise_for_status()
            self.latencies_ms.append((time.perf_counter() - started) * 1000 / len(batch))
            for text, item in zip(batch, resp.json()["data"], strict=True):
                self.cache[self._key(text)] = item["embedding"]
        if missing:
            CACHE_PATH.parent.mkdir(exist_ok=True)
            CACHE_PATH.write_text(json.dumps(self.cache))
        return [self.cache[self._key(t)] for t in texts]

    @staticmethod
    def _key(text: str) -> str:
        return f"{EMBED_MODEL}\x00{text}"


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def query_text(inputs: dict, mode: str) -> str:
    history = inputs.get("history") or []
    if mode == "with-history" and len(history):
        return " ".join([*history, inputs["question"]])
    return inputs["question"]


def embedding_scores(records: list[dict], tools: dict, method: str, query_mode: str):
    embedder = Embedder()
    queries = [QUERY_PREFIX + query_text(r["inputs"], query_mode) for r in records]
    query_vecs = embedder.embed(queries)

    group_vecs = dict(
        zip(
            [g.name for g in GROUPS],
            embedder.embed([DOC_PREFIX + g.description for g in GROUPS]),
            strict=True,
        )
    )
    tool_names = [t for g in GROUPS for t in g.tools]
    tool_vecs = dict(
        zip(
            tool_names,
            embedder.embed([DOC_PREFIX + tools[t].description for t in tool_names]),
            strict=True,
        )
    )

    out = []
    for qv in query_vecs:
        scores = {}
        for g in GROUPS:
            by_desc = cosine(qv, group_vecs[g.name])
            by_tool = max(cosine(qv, tool_vecs[t]) for t in g.tools)
            scores[g.name] = {
                "embed-desc": by_desc,
                "embed-tools": by_tool,
                "embed-both": max(by_desc, by_tool),
            }[method]
        out.append(scores)
    latency = statistics.median(embedder.latencies_ms) if embedder.latencies_ms else None
    return out, latency


def select_by_embedding(
    question: str,
    history: list[str],
    surface: list,
    top_g: int,
    *,
    method: str = "embed-desc",
    query_mode: str = "with-history",
) -> list:
    """The tools to bind for one request: the ``top_g`` best families + always-on.

    The single-request form of the evaluation above, used by stage B.
    """
    record = {"inputs": {"question": question, "history": history}}
    tools = {t.name: t for t in surface}
    (scores,), _ = embedding_scores([record], tools, method, query_mode)
    families = sorted(scores, key=lambda n: -scores[n])[:top_g]
    keep = {t for g in GROUPS if g.name in families for t in g.tools} | set(ALWAYS)
    return [t for t in surface if t.name in keep]


def d1_scores(records: list[dict], query_mode: str):
    as_tools = [SimpleNamespace(name=g.name, description=g.description) for g in GROUPS]

    async def run():
        out, latencies = [], []
        async with httpx.AsyncClient() as client:
            for r in records:
                history = list(r["inputs"].get("history") or [])
                started = time.perf_counter()
                out.append(
                    await rank_tools(
                        as_tools,
                        r["inputs"]["question"],
                        history if query_mode == "with-history" else [],
                        client,
                        url=settings.tool_ranker_url,
                        model=settings.tool_ranker_model,
                        timeout=30.0,
                        wording=GROUP_WORDING,
                    )
                )
                latencies.append((time.perf_counter() - started) * 1000)
        return out, statistics.median(latencies)

    return asyncio.run(run())


def d1_choice_scores(records: list[dict], query_mode: str):
    """One ``choice`` question over the families; rank them by probability."""
    from decision_api import choice_probabilities

    options = {g.name: g.description for g in GROUPS}

    async def run():
        out, latencies = [], []
        async with httpx.AsyncClient() as client:
            for r in records:
                history = list(r["inputs"].get("history") or [])
                started = time.perf_counter()
                out.append(
                    await choice_probabilities(
                        options,
                        r["inputs"]["question"],
                        history if query_mode == "with-history" else [],
                        client,
                    )
                )
                latencies.append((time.perf_counter() - started) * 1000)
        return out, statistics.median(latencies)

    return asyncio.run(run())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--method",
        choices=["embed-desc", "embed-tools", "embed-both", "d1", "d1-choice"],
        required=True,
    )
    parser.add_argument("--query", choices=["question", "with-history"], default="with-history")
    parser.add_argument("--top-g", type=int, nargs="+", default=[2, 3])
    parser.add_argument("--data", choices=["labels", "dataset"], default="dataset")
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    args = parser.parse_args()

    # predict_fn is a lookup into precomputed scores, so parallelism is free.
    os.environ.setdefault("MLFLOW_GENAI_EVAL_MAX_WORKERS", "8")
    setup_mlflow()
    import mlflow
    from mlflow.genai.scorers import scorer

    surface = load_tool_surface()
    tools = {t.name: t for t in surface}
    check_covers(list(tools))
    full_chars = schema_chars(surface)
    records = load_records(args.data, None, args.dataset_version)
    data = data_params(args.data, args.dataset_version)

    if args.method == "d1":
        all_scores, latency_ms = d1_scores(records, args.query)
    elif args.method == "d1-choice":
        all_scores, latency_ms = d1_choice_scores(records, args.query)
    else:
        all_scores, latency_ms = embedding_scores(records, tools, args.method, args.query)
    by_key = {
        json.dumps(r["inputs"], sort_keys=True, default=list): s
        for r, s in zip(records, all_scores, strict=True)
    }
    members = {g.name: g.tools for g in GROUPS}

    def required_families(expectations) -> list[set[str]]:
        """Per requirement, the families that would satisfy it (always-on: none needed)."""
        out = []
        for group in needed_groups(expectations):
            if any(t in ALWAYS for t in group):
                continue
            out.append({GROUP_OF[t] for t in group})
        return out

    def g_needed(ranked: list[str], expectations) -> int:
        position = {name: i + 1 for i, name in enumerate(ranked)}
        return max(
            (min(position[f] for f in fams) for fams in required_families(expectations)),
            default=0,
        )

    @scorer
    def full_recall(outputs, expectations) -> bool:
        chosen = set(outputs["families"])
        return all(fams & chosen for fams in required_families(expectations))

    @scorer
    def recall(outputs, expectations) -> float:
        need = required_families(expectations)
        chosen = set(outputs["families"])
        return sum(bool(f & chosen) for f in need) / len(need) if need else 1.0

    @scorer(name="g_needed")
    def g_needed_scorer(outputs, expectations) -> int:
        return g_needed(outputs["ranked"], expectations)

    @scorer
    def token_reduction(outputs) -> float:
        return outputs["token_reduction"]

    @scorer
    def tools_bound(outputs) -> int:
        return len(outputs["selected"])

    summary = []
    for top_g in args.top_g:

        def predict(question: str, history=None, _g: int = top_g) -> dict:
            inputs = {"question": question, "history": list(history or [])}
            scores = by_key[json.dumps(inputs, sort_keys=True)]
            ranked = sorted(scores, key=lambda n: -scores[n])
            families = ranked[:_g]
            keep = {t for f in families for t in members[f]} | set(ALWAYS)
            selected = [t for t in surface if t.name in keep]
            return {
                "families": families,
                "ranked": ranked,
                "selected": [t.name for t in selected],
                "token_reduction": round(1 - schema_chars(selected) / full_chars, 4),
            }

        with mlflow.start_run(run_name=f"groups-{args.method}-{args.query}-g{top_g}"):
            mlflow.log_params(
                {
                    "stage": "A-groups",
                    "method": args.method,
                    "query": args.query,
                    "top_g": top_g,
                    "families": len(GROUPS),
                    "always_on": ",".join(ALWAYS),
                    "model": settings.tool_ranker_model
                    if args.method.startswith("d1")
                    else EMBED_MODEL,
                    "records": len(records),
                    **data,
                }
            )
            result = mlflow.genai.evaluate(
                data=records,
                predict_fn=predict,
                scorers=[full_recall, recall, g_needed_scorer, token_reduction, tools_bound],
            )
            if latency_ms is not None:
                mlflow.log_metric("selector_latency_ms_p50", latency_ms)
            summary.append((top_g, result.metrics))

    print(
        f"\nmethod={args.method}  query={args.query}  data={data['data']}  records={len(records)}"
    )
    print(f"{'top_g':>5} {'full_recall':>12} {'recall':>8} {'token_red':>10} {'bound':>6}")
    for top_g, m in summary:
        print(
            f"{top_g:>5} {m.get('full_recall/mean', float('nan')):>12.3f} "
            f"{m.get('recall/mean', float('nan')):>8.3f} "
            f"{m.get('token_reduction/mean', float('nan')):>10.3f} "
            f"{m.get('tools_bound/mean', float('nan')):>6.1f}"
        )
    need = [
        g_needed(sorted(s, key=lambda n: -s[n]), r["expectations"])
        for r, s in zip(records, all_scores, strict=True)
    ]
    qs = statistics.quantiles(need, n=20)
    print(
        f"families needed for full recall: median {statistics.median(need):.0f}, "
        f"p90 {qs[17]:.0f}, p95 {qs[18]:.0f}, max {max(need)}"
    )
    if latency_ms is not None:
        print(f"selector latency: median {latency_ms:.0f} ms per request")


if __name__ == "__main__":
    main()
