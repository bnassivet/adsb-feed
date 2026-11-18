"""Publish the reviewed labels as a versioned MLflow evaluation dataset.

    uv run python eval/upload_dataset.py            # publish the current version
    uv run python eval/upload_dataset.py --list     # versions on the server

Reads ``data/labels.jsonl`` and creates ``adsb-tool-selection-v<N>`` under the
experiment ``adsb-agent-tool-ranking``, where N is ``DATASET_VERSION`` in
``common.py``.

A published version is **frozen**. The dataset is tagged with the SHA-256 of
the labels file it was built from; running this again with the same labels is a
no-op, and running it with *changed* labels is refused until the version is
bumped. That is what makes "evaluated on v1" keep its meaning: MLflow's
``merge_records`` would otherwise edit the dataset under every earlier run.

To publish a new version: edit ``labels.jsonl``, bump ``DATASET_VERSION``,
commit both, run this.
"""

from __future__ import annotations

import argparse
import subprocess

from common import (
    DATASET_BASENAME,
    DATASET_VERSION,
    EVAL_DIR,
    EVAL_EXPERIMENT,
    LABELS_PATH,
    dataset_name,
    labels_sha256,
    load_tool_surface,
    read_jsonl,
    setup_mlflow,
)


def git_commit() -> str:
    """The commit the labels were published from, '-dirty' if they differ from it."""
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=EVAL_DIR,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--", str(LABELS_PATH)],
            cwd=EVAL_DIR,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        return f"{sha}-dirty" if dirty else sha
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def find(datasets, experiment_id: str, name: str):
    found = datasets.search_datasets(
        experiment_ids=[experiment_id], filter_string=f"name = '{name}'"
    )
    return found[0] if found else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--list", action="store_true", help="list published versions and exit")
    args = parser.parse_args()

    experiment = setup_mlflow()
    from mlflow.genai import datasets

    if args.list:
        found = datasets.search_datasets(
            experiment_ids=[experiment.experiment_id],
            filter_string=f"name LIKE '{DATASET_BASENAME}-v%'",
        )
        for ds in sorted(found, key=lambda d: d.name):
            tags = ds.tags or {}
            print(
                f"{ds.name}  records={tags.get('records', '?')}  "
                f"labels_sha256={str(tags.get('labels_sha256', '?'))[:12]}  "
                f"commit={tags.get('git_commit', '?')}  id={ds.dataset_id}"
            )
        if not found:
            print("no published versions")
        return

    name = dataset_name()
    sha = labels_sha256()
    labels = read_jsonl(LABELS_PATH)

    existing = find(datasets, experiment.experiment_id, name)
    if existing is not None:
        published = (existing.tags or {}).get("labels_sha256")
        if published == sha:
            print(f"'{name}' is already published from these labels ({sha[:12]}); nothing to do")
            return
        raise SystemExit(
            f"'{name}' is already published from different labels "
            f"({str(published)[:12]}, now {sha[:12]}).\n"
            f"A published version is frozen. Bump DATASET_VERSION in eval/common.py "
            f"(currently {DATASET_VERSION}) and run this again."
        )

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
            "tags": {"source": r["source"], "label_id": r["id"]},
        }
        for r in labels
    ]
    dataset = datasets.create_dataset(
        name=name,
        experiment_id=experiment.experiment_id,
        tags={
            "version": str(DATASET_VERSION),
            "labels_sha256": sha,
            "git_commit": git_commit(),
            "records": str(len(records)),
            "records_from_traces": str(sum(r["source"] == "trace" for r in labels)),
            "records_curated": str(sum(r["source"] == "curated" for r in labels)),
            "tools_in_surface": str(len(load_tool_surface())),
            "purpose": "tool-selection ground truth for the adsb-agent tool ranker",
        },
    )
    dataset.merge_records(records)
    print(
        f"published '{name}': {len(records)} records, labels {sha[:12]}, "
        f"id {dataset.dataset_id}, experiment '{EVAL_EXPERIMENT}'"
    )


if __name__ == "__main__":
    main()
