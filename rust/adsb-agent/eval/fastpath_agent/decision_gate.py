"""The decision model as a gate that reads the tool descriptions.

The first decision-model gate (``eval_route.D1_WORDING``) asked one question
against a hand-written summary and never read the tool descriptions.

This one sends **several independent ``choice`` questions in one request**. The
model scores each in isolation, so more questions cost input tokens, not time
(about 1,100 tokens, 130 ms):

  kind            what sort of message is it: display command, question,
                  simulation or other?
  route           which GROUP of display commands, or a non-command kind?
  tool:<family>   one per family: which tool of this family? Options are the
                  tools' FULL descriptions. Four tools fit the model's
                  512-token question budget; all fifteen do not.

The code then walks the hierarchy: ``route`` names the family, and only that
family's ``tool`` answer is read (the others were asked speculatively).

What was tried and dropped, measured on ``d1-omni-600m``:

- ``noul`` (yes/no) questions. "Is the message a question?" scored 0.00-0.30
  on "what is the wind at FL350?"; one yes/no per tool with its description
  ranked unrelated tools first. On this model a yes/no works far better as a
  ``choice`` between described options.
- A "none of these" option in the tool choices: it competes with the real
  options. The ``kind`` question says whether any option applies instead.
- State as an object (``{"inputs": {"question": ...}}``): the plain message
  text as state gave cleaner answers.

How to use the answers (273 requests, 60 direct commands):

- As a gate on its own it is weak: about 90% precision at 30% recall, and the
  tool it names is right for 36 of 60 commands.
- As a **veto on the embedding gate** it is useful: pass a request only if the
  embedding margin clears its threshold AND ``kind`` gives "display command"
  at least 0.5. No threshold is fitted for the veto.
"""

from __future__ import annotations

import httpx
from decision_api import _too_large

from adsb_agent.config import settings
from adsb_agent.fast_path import APP, COMMAND, KIND_QUESTION, NOT_COMMANDS  # the veto's question

#: family -> (its tools, what the family covers). The summaries name the things
#: users actually say ("labels", "barbs"), which is what the model matches on.
FAMILIES: dict[str, tuple[tuple[str, ...], str]] = {
    "layers": (
        ("setLayerVisibility", "toggleDemoFlights", "setWeatherLayer"),
        "Show, hide or toggle something drawn on the map: trails, labels, range lines, "
        "history tracks, density heatmap, events, receiver marker, demo flights, weather, "
        "wind barbs or wind particles.",
    ),
    "layer_settings": (
        ("setHistoryWindow", "setDensityConfig", "setColorMode", "setEventFilter"),
        "Adjust how a layer is drawn: how many hours of history to show, the density "
        "heatmap's metric or altitude range, how tracks are colored, which events are shown.",
    ),
    "view": (
        ("setMapTheme", "toggleSidebar", "setActiveMode", "panMapTo"),
        "Change the view: day or night theme, open or close the sidebar, live or analysis "
        "mode, move the map to given coordinates.",
    ),
    "aircraft_feed": (
        ("selectAircraft", "setFilters", "startFeed", "stopFeed"),
        "Select an aircraft by its hex identifier, filter the displayed aircraft by "
        "callsign, altitude or speed, or start or stop the live feed.",
    ),
}

#: Below this probability of "display command" the request goes to the agent.
VETO_BELOW = 0.5


def build_questions(descriptions: dict[str, str]) -> dict[str, dict]:
    """Every question of one gate request. ``descriptions``: tool name -> description."""
    covered = {name for names, _ in FAMILIES.values() for name in names}
    if covered != set(descriptions):
        raise ValueError(f"families and tools differ: {sorted(covered ^ set(descriptions))}")
    questions = {
        "kind": KIND_QUESTION,
        "route": {
            "type": "choice",
            "instructions": f"What does this message, {APP}, ask for?",
            "criteria": {**{f: summary for f, (_, summary) in FAMILIES.items()}, **NOT_COMMANDS},
        },
    }
    for family, (names, _) in FAMILIES.items():
        questions[f"tool:{family}"] = {
            "type": "choice",
            "instructions": f"Which command does this message, {APP}, give?",
            "criteria": {name: descriptions[name] for name in names},
        }
    return questions


def state_text(question: str, history: list[str]) -> str:
    """The request as plain text; earlier requests are labelled as such."""
    if not history:
        return question
    return "\n".join([*(f"Earlier message: {h}" for h in history), f"Latest message: {question}"])


def _top(probabilities: dict[str, float]) -> tuple[str, float]:
    name = max(probabilities, key=lambda k: probabilities[k])
    return name, float(probabilities[name])


def signals(answers: dict[str, dict[str, float]]) -> dict:
    """What a gate can use, from one request's answers (question id -> probabilities)."""
    command = float(answers["kind"][COMMAND])
    family, p_family = _top({f: answers["route"][f] for f in FAMILIES})
    tool, p_tool = _top(answers[f"tool:{family}"])
    return {
        "command": command,
        "family": family,
        "p_family": p_family,
        "tool": tool,
        "p_tool": p_tool,
        "command_family": command * p_family,
        "command_family_tool": command * p_family * p_tool,
        "vetoed": command < VETO_BELOW,
    }


async def ask(
    questions: dict[str, dict],
    question: str,
    history: list[str],
    client: httpx.AsyncClient,
    *,
    timeout: float = 60.0,
) -> tuple[dict[str, dict[str, float]], int]:
    """Probabilities per question id, and the input tokens used."""
    states = [state_text(question, history), question]
    states += [question[:limit] for limit in (300, 150, 60) if len(question) > limit]
    resp: httpx.Response | None = None
    for state in states:  # shorter forms, for a request that overflows the model
        body = {"model": settings.tool_ranker_model, "state": state, "questions": questions}
        resp = await client.post(settings.tool_ranker_url, json=body, timeout=timeout)
        if not _too_large(resp):
            break
    assert resp is not None
    resp.raise_for_status()
    payload = resp.json()
    answers = {k: dict(v["probabilities"]) for k, v in payload["answers"].items()}
    return answers, int(payload.get("usage", {}).get("input_tokens", 0))
