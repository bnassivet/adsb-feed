"""Embedding-gate variants against the questions that passed the shipped gate.

    uv run python eval/fastpath_agent/eval_gate_variants.py                     # development sets
    uv run python eval/fastpath_agent/eval_gate_variants.py --holdout --variant D --threshold 0.05

The validation run (2026-11-15) showed the gate passing questions and remarks
about what a direct tool controls. Two fixes need no decision model:

* ``B`` embeds the latest message alone, without the earlier turns. Short voice
  commands after an unrelated turn were rejected because the history drowned
  them; the risk is a follow-up whose meaning is in the earlier turn.
* ``C`` adds one "asking about ..." document per direct tool
  (``fixtures/about_descriptions.json``), counted with the other tools, so a
  question about a setting has somewhere closer to land than the command.

``A`` is the shipped gate and ``D`` is B and C together.

Development data is ``labels.jsonl`` and ``validation_labels.jsonl`` (spent).
The threshold is fitted on both for 95% precision. ``holdout_labels.jsonl`` is
the blind test: it only runs with ``--variant`` and ``--threshold`` given, i.e.
after the choice is made, and reading it spends it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from pathlib import Path

import httpx

if __package__ in (None, ""):  # run as a file: eval/ holds the shared modules
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adsb_agent import fast_path

HERE = Path(__file__).parent
EVAL_DIR = HERE.parent
DEV_FILES = (EVAL_DIR / "data" / "labels.jsonl", HERE / "data" / "validation_labels.jsonl")
HOLDOUT_FILE = HERE / "data" / "holdout_labels.jsonl"
VARIANTS = {
    "A": {"history": True, "about": False},
    "B": {"history": False, "about": False},
    "C": {"history": True, "about": True},
    "D": {"history": False, "about": True},
}
BATCH = 32


def about_documents() -> dict[str, str]:
    raw = json.loads((HERE / "fixtures" / "about_descriptions.json").read_text())
    return {k: v for k, v in raw.items() if not k.startswith("_")}


def auc(scores: Sequence[float], truth: Sequence[bool]) -> float:
    """Chance that a random positive outscores a random negative (ties count half)."""
    pos = [s for s, t in zip(scores, truth, strict=True) if t]
    neg = [s for s, t in zip(scores, truth, strict=True) if not t]
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def margin(tool_sims: dict[str, float], about_sims: dict[str, float]) -> float:
    """Best direct tool minus the best of everything else, about-documents included."""
    direct = max(s for n, s in tool_sims.items() if n in fast_path.DIRECT_TOOLS)
    others = [s for n, s in tool_sims.items() if n not in fast_path.DIRECT_TOOLS]
    others += list(about_sims.values())
    return direct - max(others)


def load(path: Path) -> list[dict]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    for r in rows:
        r["set"] = path.stem
    return rows


async def embed_all(texts: list[str], client: httpx.AsyncClient) -> dict[str, list[float]]:
    unique = list(dict.fromkeys(texts))
    out: dict[str, list[float]] = {}
    for i in range(0, len(unique), BATCH):
        chunk = unique[i : i + BATCH]
        vectors = await fast_path._embed_batch(chunk, client, fast_path.DOCUMENTS_TIMEOUT)
        out.update(zip(chunk, vectors, strict=True))
    return out


def query_text(record: dict, history: bool) -> str:
    parts = (
        [*(record.get("history") or []), record["question"]] if history else [record["question"]]
    )
    return fast_path.QUERY_PREFIX + " ".join(parts)


async def score(records: list[dict]) -> dict[str, list[float]]:
    from common import load_tool_surface

    described = fast_path.with_descriptions(load_tool_surface())
    about = about_documents()
    async with httpx.AsyncClient() as client:
        tool_vecs = await embed_all(
            [fast_path.DOC_PREFIX + t.description for t in described], client
        )
        about_vecs = await embed_all([fast_path.DOC_PREFIX + d for d in about.values()], client)
        queries = await embed_all(
            [query_text(r, h) for r in records for h in (True, False)], client
        )
    out: dict[str, list[float]] = {}
    for name, v in VARIANTS.items():
        scores = []
        for r in records:
            q = queries[query_text(r, v["history"])]
            tool_sims = {
                t.name: fast_path._cosine(q, tool_vecs[fast_path.DOC_PREFIX + t.description])
                for t in described
            }
            about_sims = (
                {
                    n: fast_path._cosine(q, about_vecs[fast_path.DOC_PREFIX + d])
                    for n, d in about.items()
                }
                if v["about"]
                else {}
            )
            scores.append(margin(tool_sims, about_sims))
        out[name] = scores
    return out


def report(records: list[dict], scores: list[float], threshold: float) -> None:
    passed = [s >= threshold for s in scores]
    groups: dict[str, list[int]] = {}
    for i, r in enumerate(records):
        cls = "command" if r["route"] == "desktop" else "agent"
        groups.setdefault(f"{r['set']} {cls}", []).append(i)
        if r.get("tag") and r["set"] != "labels":
            groups.setdefault(f"{r['set']} {cls} tag={r['tag']}", []).append(i)
        if r.get("history") and cls == "command":
            groups.setdefault(f"{r['set']} command with history", []).append(i)
    for key in sorted(groups):
        idx = groups[key]
        print(f"    {key:<52} {sum(passed[i] for i in idx):>4} of {len(idx):<4} pass")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--holdout", action="store_true", help="the blind test; spends it")
    parser.add_argument("--variant", choices=sorted(VARIANTS))
    parser.add_argument("--threshold", type=float)
    parser.add_argument("--target-precision", type=float, default=0.95)
    parser.add_argument(
        "--show", type=int, default=0, help="list the N worst agent requests passing"
    )
    args = parser.parse_args()

    from fastpath_agent.eval_route import fit_threshold, precision_recall

    if args.holdout:
        if args.variant is None or args.threshold is None:
            parser.error("--holdout needs --variant and --threshold chosen on the development sets")
        records = load(HOLDOUT_FILE)
    else:
        records = [r for name in DEV_FILES for r in load(name)]
    truth = [r["route"] == "desktop" for r in records]
    all_scores = asyncio.run(score(records))

    for name, scores in all_scores.items():
        if args.variant and name != args.variant:
            continue
        threshold = (
            args.threshold
            if args.threshold is not None
            else fit_threshold(scores, truth, args.target_precision)
        )
        precision, recall, fp, fn = precision_recall(truth, [s >= threshold for s in scores])
        per_set = ", ".join(
            f"{s} {auc([x for x, r in zip(scores, records, strict=True) if r['set'] == s], [t for t, r in zip(truth, records, strict=True) if r['set'] == s]):.3f}"
            for s in dict.fromkeys(r["set"] for r in records)
        )
        print(
            f"\n{name} {VARIANTS[name]}  AUC {auc(scores, truth):.3f} ({per_set})\n"
            f"  threshold {threshold:.4f}: precision {precision:.3f}, recall {recall:.3f}, "
            f"{fp} agent requests pass, {fn} commands missed"
        )
        report(records, scores, threshold)
        if args.show:
            worst = sorted(
                (s, r["question"]) for s, r, t in zip(scores, records, truth, strict=True) if not t
            )[-args.show :]
            for s, q in reversed(worst):
                print(f"      {s:+.3f}  {q[:80]}")


if __name__ == "__main__":
    main()
