"""Shared settings and helpers for the tool-ranking evaluation harness.

Run everything from ``rust/adsb-agent`` with the ``eval`` extra installed
(``uv sync --all-extras``), e.g. ``uv run python eval/mine_traces.py``.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

EVAL_DIR = Path(__file__).parent
TOOL_SURFACE_PATH = EVAL_DIR / "fixtures" / "tool_surface.json"
CANDIDATES_PATH = EVAL_DIR / "data" / "candidates.jsonl"
#: The reviewed labels. ``ADSB_EVAL_LABELS`` names another file with the same
#: record shape (``fastpath_agent/data/validation_labels.jsonl``: requests nobody tuned
#: against); evaluate it with ``--data labels``.
LABELS_PATH = Path(os.environ.get("ADSB_EVAL_LABELS") or EVAL_DIR / "data" / "labels.jsonl")

TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://127.0.0.1:5010")
#: Where the running agent logs its chat traces (the mining source).
AGENT_EXPERIMENT = os.environ.get("ADSB_AGENT_MLFLOW_EXPERIMENT", "adsb-agent")
#: Where datasets and evaluation runs go. Kept apart from the agent's own
#: experiment so evaluation traces never mix with real usage.
EVAL_EXPERIMENT = "adsb-agent-tool-ranking"
#: The dataset is versioned by name: ``adsb-tool-selection-v<N>``. Open-source
#: MLflow has no immutable dataset versions (``get_dataset(version=...)`` is
#: Databricks-only) and ``merge_records`` edits a dataset in place, so a run
#: logged last week against "the dataset" would silently mean something else
#: after a label fix. Instead each version is its own dataset, frozen once
#: uploaded: change ``labels.jsonl`` -> bump this number -> upload a new one.
#:
#: v1  243 records: expected_tools / any_of.
#: v2  same records, plus `category` (ui_action | simple_question | multi_step).
#: v3  category relabelled: needing the clock (getCurrentDateTime) plus one other
#:     tool no longer makes a request multi-step; 30 authored multi-step
#:     requests added so that class stays measurable (273 records).
#: v4  plus `route` (desktop | agent): can a small model on the desktop finish
#:     the request alone, in one step, with browser-side UI tools?
#: v5  plus `expected_calls` on the 60 desktop records: the tool calls, with
#:     argument values, that carry the command out.
#: v6  plus `route_ui` (desktop | agent): the broader split, UI action vs other,
#:     for a UI model holding ALL browser-side action tools (scenario and event
#:     edits included). Simulation stays with the agent: it runs there.
DATASET_BASENAME = "adsb-tool-selection"
DATASET_VERSION = 6


def dataset_name(version: int = DATASET_VERSION) -> str:
    return f"{DATASET_BASENAME}-v{version}"


def labels_sha256() -> str:
    """Content hash of the reviewed labels: what a dataset version is pinned to."""
    import hashlib

    return hashlib.sha256(LABELS_PATH.read_bytes()).hexdigest()


def setup_mlflow(experiment: str = EVAL_EXPERIMENT):
    """Point MLflow at the tracking server and select ``experiment``."""
    os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
    import mlflow

    mlflow.set_tracking_uri(TRACKING_URI)
    return mlflow.set_experiment(experiment)


def load_tool_surface() -> list[SimpleNamespace]:
    """The production tool surface, as objects with name/description/parameters.

    A snapshot of what the desktop actually sends plus the agent's backend
    tools (see ``snapshot_tool_surface.py``). The 31 client tools are declared
    in TypeScript, so a recorded request is the only place Python can read the
    real list from; ``adsb_agent/tools.py`` is an incomplete dev copy.
    """
    raw = json.loads(TOOL_SURFACE_PATH.read_text())
    overrides = tool_overrides()
    tools = []
    for t in raw["tools"]:
        override = overrides.get(t["name"], {})
        parameters = copy.deepcopy(t.get("parameters"))
        for param, text in (override.get("params") or {}).items():
            parameters["properties"][param]["description"] = text  # KeyError: a typo, fail loudly
        tools.append(
            SimpleNamespace(
                name=t["name"],
                description=override.get("description", t.get("description", "")),
                parameters=parameters,
            )
        )
    return tools


def tool_overrides() -> dict:
    """Candidate description rewrites, when ``ADSB_EVAL_TOOL_OVERRIDES`` names a file.

    ``{tool: {"description": ..., "params": {param: description}}}``. Lets two
    wordings of the tool surface be scored on the same records without touching
    the desktop's source until one is shown to be better.
    """
    path = os.environ.get("ADSB_EVAL_TOOL_OVERRIDES")
    if not path:
        return {}
    return {k: v for k, v in json.loads(Path(path).read_text()).items() if not k.startswith("_")}


def overrides_tag() -> str:
    """A suffix for run and file names, so variants do not overwrite each other."""
    path = os.environ.get("ADSB_EVAL_TOOL_OVERRIDES")
    return f"-{Path(path).stem}" if path else ""


def labels_tag() -> str:
    """A suffix for run and file names when ``ADSB_EVAL_LABELS`` selects another
    labels file, so its results never overwrite the main set's."""
    return f"-{LABELS_PATH.stem}" if os.environ.get("ADSB_EVAL_LABELS") else ""


def schema_chars(tools: list[Any]) -> int:
    """Size of the tool schemas as sent to the LLM (OpenAI function format)."""
    return sum(
        len(
            json.dumps(
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters or {"type": "object", "properties": {}},
                    },
                }
            )
        )
        for t in tools
    )


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
