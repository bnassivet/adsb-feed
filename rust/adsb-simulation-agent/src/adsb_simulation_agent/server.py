"""Starlette app exposing the simulation agent over A2A JSON-RPC.

a2a-sdk v1.0 removed the ``A2AStarletteApplication`` / ``A2AFastApiApplication``
wrapper classes in favour of route factories, so the app is assembled here from
``create_agent_card_routes`` + ``create_jsonrpc_routes``. That also means the
card path is ``/.well-known/agent-card.json`` (renamed from ``agent.json``).
"""

from __future__ import annotations

import logging
from typing import Any

from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .agent_card import build_agent_card
from .config import settings
from .executor import SimulationAgentExecutor
from .tracing import capture_trace_headers

logger = logging.getLogger("adsb_simulation_agent.server")

RPC_URL = "/"
"""JSON-RPC endpoint path; the agent card advertises the base URL itself."""


_REASONING_OFF = frozenset({"off", "false", "no", "disabled", "none", "0"})
_REASONING_ON = frozenset({"on", "true", "yes", "enabled", "1"})
"""Reasoning is a *toggle* on some models rather than a dial.

`gemma-4-12b-qat` only honours ``reasoning_effort="none"`` — measured 4 s and
162 completion tokens with it, against 23 s and 1083 without. ``minimal`` and
``low`` are accepted and ignored, as are ``reasoning={"enabled": false}`` and
``chat_template_kwargs={"enable_thinking": false}``. So the plain words for the
toggle are mapped onto the one value that works, and ``on`` sends nothing at
all — that is already the model's default.
"""


def reasoning_kwargs(effort: str | None, max_tokens: int | None) -> dict[str, Any]:
    """Extra request fields asking the model to think less.

    Reasoning tokens are charged against the *same* budget as the answer, so a
    model that deliberates at length returns ``finish_reason='length'`` with
    empty content — the budget is gone before it writes anything. These fields
    ask for less of that.

    Only emitted when configured. Sending ``reasoning_effort: null`` on every
    request would add a field that some endpoints reject and none benefit from.
    Support varies by provider; an endpoint that does not understand these
    ignores them, so they are safe to set but are a *request*, not a guarantee.

    Returned as ``ChatOpenAI`` constructor kwargs. ``reasoning_effort`` is a
    native field — routing it through ``model_kwargs`` instead makes LangChain
    warn and hoist it anyway — while the token cap has no native equivalent and
    goes in ``extra_body``.
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


def build_llm() -> Any | None:
    """Chat model for route-hint classification, or None if unavailable.

    Returning None is a supported mode, not an error: without an LLM the service
    still generates trajectories from seeded default plans. The connection isn't
    tested here — a dead endpoint surfaces later as a graceful per-request
    fallback in ``intent.parse_route_hint``.
    """
    try:
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.model,
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
            timeout=settings.llm_timeout_s,
            # The OpenAI client retries twice by default, so one classification
            # is really three attempts and `llm_timeout_s` is effectively
            # tripled — a 300s budget becomes a 900s worst case, long after the
            # caller has given up. Nothing here is worth a transport-level
            # retry: `intent.parse_route_hint` owns the one retry that helps (a
            # truncated answer, retried with a *bigger* budget), and every other
            # failure degrades to a default plan anyway.
            max_retries=0,
            **reasoning_kwargs(settings.reasoning_effort, settings.reasoning_max_tokens),
        )
    except Exception as e:  # noqa: BLE001 — degrade to no-LLM mode
        logger.warning("LLM unavailable (%s); route hints will use default plans", e)
        return None


def build_app(base_url: str | None = None, llm: Any | None = None) -> Starlette:
    """Assemble the A2A Starlette application."""
    url = base_url or f"http://localhost:{settings.port}"
    agent_card = build_agent_card(url)

    handler = DefaultRequestHandler(
        agent_executor=SimulationAgentExecutor(llm=llm),
        task_store=InMemoryTaskStore(),
        # v1.0 requires the card here so the handler can validate against
        # declared capabilities.
        agent_card=agent_card,
    )

    async def health(_request):
        return JSONResponse({"status": "healthy", "service": agent_card.name})

    routes = [
        *create_agent_card_routes(agent_card),
        *create_jsonrpc_routes(handler, RPC_URL),
        Route("/health", health, methods=["GET"]),
    ]
    return Starlette(routes=routes, middleware=[Middleware(TracingContextMiddleware)])


class TracingContextMiddleware(BaseHTTPMiddleware):
    """Hand inbound trace headers to the executor.

    Middleware because the A2A layer gives the executor no access to the raw
    request; a ContextVar because ``DefaultRequestHandler`` starts the executor
    with ``asyncio.create_task`` *during* request handling, and a task copies the
    current context at creation.

    It only *captures* — joining the trace happens in the executor. That split
    is deliberate: the producer task is not awaited before the HTTP response is
    returned, so a trace scope opened here could exit while the executor's span
    was still open, and MLflow would drop that span on export. Joining inside
    the executor makes the scope's lifetime match the span's.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        capture_trace_headers(request.headers)
        return await call_next(request)
