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
