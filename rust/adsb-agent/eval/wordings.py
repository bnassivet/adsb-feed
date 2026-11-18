"""Question wordings to compare: how one tool is put to the decision model.

The model scores each tool's question independently, so this text is the whole
lever on ranking quality. Add a variant here, then run
``eval/eval_ranker.py --wording <name>``. A variant is a wording plus a function
that picks which part of the tool's description to show.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from adsb_agent.tool_ranker import DEFAULT_WORDING, QuestionWording


def full(description: str) -> str:
    return description


def first_sentence(description: str) -> str:
    text = description.strip()
    cut = text.find(". ")
    return text[: cut + 1] if cut != -1 else text


@dataclass(frozen=True)
class Variant:
    wording: QuestionWording
    describe: Callable[[str], str] = full


VARIANTS: dict[str, Variant] = {
    # What the agent ships with (tool_ranker.DEFAULT_WORDING).
    "baseline": Variant(DEFAULT_WORDING),
    "baseline-short": Variant(DEFAULT_WORDING, first_sentence),
    # Lead with what the tool does, then ask; name the app so "tracks" and
    # "feed" are read in context.
    "capability": Variant(
        QuestionWording(
            instructions=(
                "The user is talking to the assistant of an aircraft-tracking application. "
                "One of the assistant's capabilities is `{name}`: {description} "
                "Does carrying out the user's request involve this capability?"
            ),
            true="Yes: the request asks for this, or cannot be completed without it.",
            false="No: the request is about something else.",
        )
    ),
    "capability-short": Variant(
        QuestionWording(
            instructions=(
                "The user is talking to the assistant of an aircraft-tracking application. "
                "One of the assistant's capabilities is `{name}`: {description} "
                "Does carrying out the user's request involve this capability?"
            ),
            true="Yes: the request asks for this, or cannot be completed without it.",
            false="No: the request is about something else.",
        ),
        first_sentence,
    ),
    # Put the description in the criteria instead of the instructions.
    "match": Variant(
        QuestionWording(
            instructions="Does the user's request match what this tool does?",
            true="The request matches this tool. `{name}`: {description}",
            false="The request is unrelated to this tool. `{name}`: {description}",
        )
    ),
}
