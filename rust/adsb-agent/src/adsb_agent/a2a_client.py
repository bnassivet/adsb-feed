"""A2A client for the simulation agent (`adsb-simulation-agent`, port 8300).

The simulation agent runs a2a-sdk v1.x. Three details differ from every pre-1.0
example and each will silently break the integration if missed:

1. The JSON-RPC method is ``SendMessage`` (gRPC-style PascalCase), not
   ``message/send``.
2. The ``A2A-Version: 1.0`` header is **mandatory**. Omitting it is interpreted
   as protocol 0.3 and the server replies with ``VERSION_NOT_SUPPORTED``.
3. Generation failures come back as ``TASK_STATE_FAILED`` inside a *successful*
   JSON-RPC response — checking only for an ``error`` key reports failure as
   success.

Every failure mode degrades to a readable error string rather than raising: a
demo feature must never break the chat turn it was invoked from.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

import httpx

from .config import settings
from .tracing import tracing_headers

logger = logging.getLogger("adsb_agent.a2a_client")

SEND_MESSAGE_METHOD = "SendMessage"
A2A_VERSION_HEADER = "A2A-Version"
A2A_VERSION = "1.0"

TERMINAL_SUCCESS_STATE = "TASK_STATE_COMPLETED"

# Tool arg -> simulation-agent payload. The simulation agent accepts camelCase,
# so the LLM's tool args pass straight through.
_PAYLOAD_FIELDS = (
    "category",
    "count",
    "routeHint",
    "originLat",
    "originLng",
    "cruiseAltitudeFt",
    "callsignPrefix",
    "seed",
)


@dataclass
class TrajectoryResult:
    """Outcome of one generation request."""

    ok: bool
    summary: str = ""
    """Compact one-line description — safe to put in an LLM's context."""

    data: dict[str, Any] | None = None
    """Full trajectory payload. Hundreds of waypoints; must NOT reach the LLM."""

    error: str = ""


def build_trajectory_payload(args: dict[str, Any]) -> dict[str, Any]:
    """Select the recognised tool args, dropping anything absent."""
    return {key: args[key] for key in _PAYLOAD_FIELDS if args.get(key) is not None}


def build_send_message_request(
    payload: dict[str, Any], request_id: str | None = None
) -> dict[str, Any]:
    """Wrap a payload in an A2A ``SendMessage`` JSON-RPC envelope."""
    return {
        "jsonrpc": "2.0",
        "id": request_id or str(uuid.uuid4()),
        "method": SEND_MESSAGE_METHOD,
        "params": {
            "message": {
                "messageId": str(uuid.uuid4()),
                "role": "ROLE_USER",
                "parts": [{"data": payload}],
            }
        },
    }


def _status_text(status: dict[str, Any]) -> str:
    parts = (status.get("message") or {}).get("parts") or []
    return " ".join(p.get("text", "") for p in parts if p.get("text")).strip()


def parse_task_response(body: dict[str, Any]) -> TrajectoryResult:
    """Turn an A2A response body into a ``TrajectoryResult``.

    Handles the three shapes the server can return: a JSON-RPC error, a task in
    a non-success terminal state, and a completed task carrying the trajectory
    artifact.
    """
    if not isinstance(body, dict):
        return TrajectoryResult(ok=False, error="simulation agent returned a malformed response")

    if "error" in body:
        error = body["error"] or {}
        message = error.get("message", "unknown error")
        return TrajectoryResult(ok=False, error=f"simulation agent error: {message}")

    task = ((body.get("result") or {}).get("task")) or {}
    if not task:
        return TrajectoryResult(ok=False, error="simulation agent returned no task")

    status = task.get("status") or {}
    state = status.get("state", "")
    if state != TERMINAL_SUCCESS_STATE:
        reason = _status_text(status) or state or "unknown state"
        return TrajectoryResult(ok=False, error=f"trajectory generation failed: {reason}")

    artifacts = task.get("artifacts") or []
    data = None
    for artifact in artifacts:
        for part in artifact.get("parts") or []:
            if isinstance(part.get("data"), dict):
                data = part["data"]
                break
        if data is not None:
            break

    if data is None:
        return TrajectoryResult(ok=False, error="simulation agent returned no trajectory data")

    aircraft = data.get("aircraft") or []
    summary = data.get("summary") or _status_text(status) or f"{len(aircraft)} aircraft generated"
    return TrajectoryResult(ok=True, summary=summary, data=data)


async def call_simulation_agent(
    args: dict[str, Any], client: httpx.AsyncClient
) -> TrajectoryResult:
    """Request a trajectory from the simulation agent over A2A."""
    url = settings.simulation_agent_url.rstrip("/") + "/"
    request = build_send_message_request(build_trajectory_payload(args))

    try:
        response = await client.post(
            url,
            json=request,
            # A2A-Version is mandatory: without it the server assumes protocol
            # 0.3 and refuses. The trace headers are what let the simulation
            # agent nest its spans inside this agent's trace.
            headers={A2A_VERSION_HEADER: A2A_VERSION, **tracing_headers()},
            timeout=settings.simulation_agent_timeout,
        )
        response.raise_for_status()
        body = response.json()
    except httpx.HTTPStatusError as e:
        logger.warning("Simulation agent returned %s", e.response.status_code)
        return TrajectoryResult(
            ok=False,
            error=f"simulation agent returned HTTP {e.response.status_code}",
        )
    except Exception as e:  # noqa: BLE001 — surface transport/parse failures readably
        logger.warning("Simulation agent unreachable: %s", e)
        return TrajectoryResult(
            ok=False,
            error=(
                f"could not reach the simulation agent at {settings.simulation_agent_url} "
                f"({e}). Is it running?"
            ),
        )

    return parse_task_response(body)
