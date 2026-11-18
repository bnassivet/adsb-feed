"""The decision model's ``choice`` question: one pick among named options.

The agent's ranker asks one ``noul`` (yes/no) question per tool; each is scored
alone, on its own scale, so one tool that always scores high crowds out the
right one. A ``choice`` question puts every option into a single question::

    {"type": "choice", "instructions": ..., "criteria": {<option>: <description>}}

and answers ``{"choice": <option>, "probabilities": {<option>: p}, "confidence": c}``
with the probabilities summing to one. Ranking by probability gives a top-k that
is comparable across options. (The third type, ``score``, takes a list of
criteria and is not used here.)

**One question must fit in 512 tokens** (the model's batch size); a longer one
fails with HTTP 500 "input is too large to process". A choice over all ~40 tools
with their descriptions does not fit. Two ways round it are offered here: the
tool names alone as options, or the tools split into small chunks, one choice
question per chunk, each with a "none of these" option.
"""

from __future__ import annotations

import httpx

from adsb_agent.config import settings

CHOICE_INSTRUCTIONS = (
    "The user is talking to the assistant of an aircraft-tracking application. "
    "Which of these does the assistant most need to fulfil the user's request?"
)


async def choice_probabilities(
    options: dict[str, str],
    question: str,
    history: list[str],
    client: httpx.AsyncClient,
    *,
    instructions: str = CHOICE_INSTRUCTIONS,
    timeout: float = 30.0,
) -> dict[str, float]:
    """Probability of each option for this request, from one ``choice`` question."""
    resp = None
    for inputs in _shrinking_inputs(question, history):
        body = {
            "model": settings.tool_ranker_model,
            "state": {"inputs": inputs},
            "questions": {
                "pick": {"type": "choice", "instructions": instructions, "criteria": options}
            },
        }
        resp = await client.post(settings.tool_ranker_url, json=body, timeout=timeout)
        if not _too_large(resp):
            break
    resp.raise_for_status()
    probabilities = resp.json()["answers"]["pick"]["probabilities"]
    missing = set(options) - set(probabilities)
    if missing:
        raise ValueError(f"no probability for {sorted(missing)}")
    return {name: float(probabilities[name]) for name in options}


def _too_large(resp: httpx.Response) -> bool:
    return resp.status_code == 500 and "too large to process" in resp.text


def _shrinking_inputs(question: str, history: list[str]):
    """The request, then progressively shorter forms of it.

    The question and the options share the 512-token budget, so a long request
    (a simulation route with coordinates, say) can overflow where a short one
    fits. Drop the history first, then cut the question: what a request is about
    is nearly always in its first words.
    """
    if history:
        yield {"question": question, "previous_requests": list(history)}
    yield {"question": question}
    for limit in (300, 150, 60):
        if len(question) > limit:
            yield {"question": question[:limit]}


NONE = "none_of_these"


async def chunked_choice_probabilities(
    options: dict[str, str],
    question: str,
    history: list[str],
    client: httpx.AsyncClient,
    *,
    chunk_size: int = 6,
    timeout: float = 30.0,
) -> dict[str, float]:
    """A choice question per chunk of options, all in one request.

    Every chunk gets a "none of these" option, so a chunk that holds nothing
    relevant can say so instead of spreading its probability over bad options.
    The probability an option gets inside its own chunk is used as its score.
    Scores from different chunks are therefore only roughly comparable.
    """
    names = list(options)
    chunks = [names[i : i + chunk_size] for i in range(0, len(names), chunk_size)]
    inputs: dict = {"question": question}
    if history:
        inputs["previous_requests"] = list(history)
    body = {
        "model": settings.tool_ranker_model,
        "state": {"inputs": inputs},
        "questions": {
            f"chunk{i}": {
                "type": "choice",
                "instructions": CHOICE_INSTRUCTIONS,
                "criteria": {
                    **{n: options[n] for n in chunk},
                    NONE: "None of these is needed for the request.",
                },
            }
            for i, chunk in enumerate(chunks)
        },
    }
    resp = await client.post(settings.tool_ranker_url, json=body, timeout=timeout)
    resp.raise_for_status()
    answers = resp.json()["answers"]
    scores: dict[str, float] = {}
    for i, chunk in enumerate(chunks):
        probabilities = answers[f"chunk{i}"]["probabilities"]
        for name in chunk:
            scores[name] = float(probabilities[name])
    return scores
