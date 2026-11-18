"""Does a model's reply carry out a direct command? Tool calls vs expected calls.

A label's ``expected_calls`` is a list of **alternatives**; the reply is right if
it matches any one. An alternative is a list of expected calls::

    {"tool": "setHistoryWindow",
     "args": {"depthHours": 4},            # must be present with these values
     "optional": {"endHoursAgo": [0]},     # may be present, only with these values
     "required": false}                    # (optional) the call itself may be absent

Rules, chosen so that a "match" means the user gets exactly what they asked for:

* every required expected call must be made, and every call made must be an
  expected one -- an unrequested extra action is a wrong action;
* an argument not listed under ``args`` or ``optional`` fails the call: on
  ``setLayerVisibility`` an extra argument is an extra layer switched;
* ``optional`` holds the values that change nothing (a default spelled out), or
  ``"*"`` where any value is acceptable (the zoom of a pan);
* strings compare ignoring case and surrounding spaces, numbers by value, and a
  boolean only ever equals a boolean.
"""

from __future__ import annotations

from typing import Any

ANY = "*"


def _plain(value: Any) -> Any:
    """Lists and dicts all the way down (the dataset returns numpy arrays)."""
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (str, bytes)) or value is None:
        return value
    if hasattr(value, "tolist"):
        return _plain(value.tolist())
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def values_equal(actual: Any, expected: Any) -> bool:
    if isinstance(expected, bool) or isinstance(actual, bool):
        return isinstance(actual, bool) and isinstance(expected, bool) and actual == expected
    if isinstance(expected, (int, float)):
        return isinstance(actual, (int, float)) and abs(actual - expected) < 1e-6
    if isinstance(expected, str):
        return isinstance(actual, str) and actual.strip().lower() == expected.strip().lower()
    return actual == expected


def call_matches(call: dict, expected: dict) -> bool:
    if call.get("name") != expected["tool"]:
        return False
    args = call.get("args") or {}
    required = expected.get("args") or {}
    optional = expected.get("optional") or {}
    for name, value in required.items():
        if name not in args or not values_equal(args[name], value):
            return False
    for name, value in args.items():
        if name in required:
            continue
        allowed = optional.get(name)
        if allowed is None:
            return False
        if allowed != ANY and not any(values_equal(value, a) for a in allowed):
            return False
    return True


def _alternative_matches(calls: list[dict], alternative: list[dict]) -> bool:
    remaining = list(calls)
    for expected in alternative:
        hit = next((c for c in remaining if call_matches(c, expected)), None)
        if hit is not None:
            remaining.remove(hit)
        elif expected.get("required", True):
            return False
    return not remaining


def calls_match(calls: list[dict], expected_calls: Any) -> bool:
    """True if the calls made carry out the command, per any one alternative."""
    if not calls:
        return False
    return any(_alternative_matches(calls, alt) for alt in _plain(expected_calls))
