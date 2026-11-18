"""Does the model still USE the UI state when it rides on the user message?

    uv run python eval/eval_context_use.py

Moving the ambient UI state out of the system prompt makes turns fast
(cache_experiment.py); this checks it does not make them wrong. Each probe is a
request that can only be handled correctly by reading the state, run under two
different states (so a lucky guess fails one of them) and both placements.

A probe passes when every needle appears in the reply text or its tool-call
arguments. One real LLM call per probe, state and placement; no tool executes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from types import SimpleNamespace

from common import load_tool_surface, setup_mlflow
from eval_agent_step import first_reply

from adsb_agent.config import settings

# Made-up values; the receiver position is not a real one.
STATES = {
    "A": {
        "mode": "live", "selected": ["4CA7B2"], "theme": "dark", "labels": True,
        "density": True, "history_h": 48, "tracks": 12, "receiver": "48.0, -2.0",
        "alt_max": 50000,
    },
    "B": {
        "mode": "analysis", "selected": ["3C6589"], "theme": "light", "labels": False,
        "density": False, "history_h": 6, "tracks": 31, "receiver": "51.5, 4.25",
        "alt_max": 12000,
    },
}


def ui_state(s: dict) -> list[SimpleNamespace]:
    entries = [
        ("Active mode (live or analysis)", s["mode"]),
        (
            "Selected aircraft (hex idents) and the most recently selected one",
            json.dumps({"selected": s["selected"], "lastSelected": s["selected"][-1]}),
        ),
        (
            "Active aircraft filters (callsign, altitude range, speed range)",
            json.dumps({"callsign": "", "altitudeMin": 0, "altitudeMax": s["alt_max"],
                        "speedMin": 0, "speedMax": 600}),
        ),
        ("Map theme and sidebar state", json.dumps({"mapTheme": s["theme"], "sidebarOpen": True})),
        (
            "Visible map layers",
            json.dumps({"positions": True, "labels": s["labels"], "rangeLines": False,
                        "history": False, "density": s["density"]}),
        ),
        (
            "History layer time window",
            json.dumps({"retentionHours": 48, "fromHoursAgo": s["history_h"], "toHoursAgo": 0}),
        ),
        ("Live aircraft track count", json.dumps({"trackCount": s["tracks"]})),
        ("Database storage availability", "available"),
        ("Receiver (antenna) location as lat/lng", s["receiver"]),
    ]
    return [SimpleNamespace(description=d, value=v) for d, v in entries]


def _other(theme: str) -> str:
    return "light" if theme == "dark" else "dark"


# (request, needles(state) -> strings that must all appear in the reply)
PROBES = [
    ("which aircraft is selected?", lambda s: [s["selected"][0]]),
    ("show the trajectory of the selected aircraft", lambda s: [s["selected"][0]]),
    ("what is the wind at the selected aircraft?", lambda s: [s["selected"][0]]),
    ("center the map on the receiver", lambda s: s["receiver"].replace(" ", "").split(",")),
    ("which map theme am I using?", lambda s: [s["theme"]]),
    ("switch to the other map theme", lambda s: [_other(s["theme"])]),
    ("toggle the labels layer", lambda s: [str(not s["labels"]).lower()]),
    ("am I in live or analysis mode?", lambda s: [s["mode"]]),
    ("switch to the other mode", lambda s: ["analysis" if s["mode"] == "live" else "live"]),
    ("what is my current maximum altitude filter?", lambda s: [str(s["alt_max"])]),
    ("how far back does the history layer go right now?", lambda s: [str(s["history_h"])]),
    ("where is the receiver located?", lambda s: s["receiver"].replace(" ", "").split(",")),
]


def passed(reply: dict, needles: list[str]) -> bool:
    hay = (reply["text"] + " " + json.dumps(reply["tool_args"])).lower().replace(",", "")
    return all(n.lower().rstrip("0").rstrip(".") in hay for n in needles)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--placements", nargs="+", default=["system", "user"])
    args = parser.parse_args()

    setup_mlflow()
    import mlflow

    surface = load_tool_surface()
    # One event loop for every call: the OpenAI client keeps its connection
    # pool, and a pool outliving its loop fails with "Event loop is closed".
    rows = asyncio.run(run_probes(args.placements, surface))
    report(rows, args.placements, mlflow)


async def run_probes(placements: list[str], surface: list) -> list[dict]:
    rows = []
    for placement in placements:
        for state_name, state in STATES.items():
            for request, needles in PROBES:
                reply = await first_reply(request, [], "full", 0, surface,
                                          context=ui_state(state), placement=placement)
                ok = passed(reply, needles(state))
                rows.append({"placement": placement, "state": state_name, "request": request,
                             "ok": ok, **reply})
                calls = [f"{n}({json.dumps(a)})" for n, a in
                         zip(reply["tool_calls"], reply["tool_args"])]
                print(f"{placement:<6} {state_name} {'ok ' if ok else 'FAIL'} {request}\n"
                      f"         -> {calls or reply['text'][:140]!r}  [{reply['latency_s']} s]")
    return rows


def report(rows: list[dict], placements: list[str], mlflow) -> None:
    with mlflow.start_run(run_name="context-use"):
        mlflow.log_params({"stage": "context-use", "llm_model": settings.model,
                           "probes": len(PROBES), "states": len(STATES)})
        print()
        for placement in placements:
            mine = [r for r in rows if r["placement"] == placement]
            n_ok = sum(r["ok"] for r in mine)
            lat = sorted(r["latency_s"] for r in mine)[len(mine) // 2]
            mlflow.log_metric(f"used_state_{placement}", n_ok / len(mine))
            mlflow.log_metric(f"latency_median_s_{placement}", lat)
            print(f"{placement:<6} used the state in {n_ok}/{len(mine)}; median latency {lat} s")
        mlflow.log_dict({"rows": [{k: v for k, v in r.items() if k != "bound"} for r in rows]},
                        "context_use.json")


if __name__ == "__main__":
    main()
