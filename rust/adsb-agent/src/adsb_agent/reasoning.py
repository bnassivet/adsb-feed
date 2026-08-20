"""Asking a reasoning model to think less.

Ported from `adsb_simulation_agent.server`, which hit this first: reasoning
tokens are charged against the **same** budget as the answer, so a model that
deliberates at length hits `finish_reason='length'` with empty content. To the
caller that is indistinguishable from a hang — it waits out its whole timeout
and receives nothing.

`gemma-4-12b-qat` treats reasoning as a *toggle*, not a dial: only
``reasoning_effort="none"`` has any effect (measured 4 s / 162 completion tokens
with it, 23 s / 1083 without). ``minimal`` and ``low`` are accepted and ignored,
as are ``reasoning={"enabled": false}`` and
``chat_template_kwargs={"enable_thinking": false}``. So the plain words for the
toggle are mapped onto the one value that works.
"""

from __future__ import annotations

from typing import Any

_REASONING_OFF = frozenset({"off", "false", "no", "disabled", "none", "0"})
_REASONING_ON = frozenset({"on", "true", "yes", "enabled", "1"})


def reasoning_kwargs(effort: str | None, max_tokens: int | None) -> dict[str, Any]:
    """Extra `ChatOpenAI` constructor fields asking the model to think less.

    Only emitted when configured: sending ``reasoning_effort: null`` on every
    request would add a field some endpoints reject and none benefit from.
    Support varies by provider — an endpoint that does not understand these
    ignores them, so they are safe to set but are a *request*, not a guarantee.

    ``reasoning_effort`` is a native `ChatOpenAI` field (routing it through
    ``model_kwargs`` makes LangChain warn and hoist it anyway), while the token
    cap has no native equivalent and goes in ``extra_body``.
    """
    kwargs: dict[str, Any] = {}

    if effort and effort.strip():
        word = effort.strip().lower()
        if word in _REASONING_OFF:
            # The one value that actually works on a toggle-style model.
            kwargs["reasoning_effort"] = "none"
        elif word not in _REASONING_ON:
            # A graded level, or something a provider we don't know understands.
            kwargs["reasoning_effort"] = word
        # "on" sends nothing: it is the model's own default, and naming it would
        # only risk an endpoint rejecting a value it has no concept of.

    if max_tokens is not None and max_tokens > 0:
        kwargs["extra_body"] = {"reasoning": {"max_tokens": max_tokens}}

    return kwargs
