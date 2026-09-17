"""Prometheus metrics for the simulation agent.

Same reasoning as ``adsb_agent.metrics``: this does not duplicate MLflow
tracing, it covers what tracing cannot -- it survives MLflow being down (which
makes this agent hang at startup, so it is exactly when you want numbers), it
is cheap enough to keep unsampled, and it alerts.

The one metric here that pays for itself is ``route_hint_total``. This agent's
LLM path has a documented failure that is invisible from outside: a too-small
token budget returns ``finish_reason='length'`` with empty content, which
"looks exactly like a model that ignored the prompt", and the code falls back
to a default plan. A counter on the fallback arm makes that visible as a rate
instead of something found by reading traces after someone complains.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

#: Media type a scrape must be served as.
CONTENT_TYPE = CONTENT_TYPE_LATEST

SERVICE = "adsb-simulation-agent"

BUILD_INFO = Gauge(
    "adsb_build_info",
    "Identity and version of this ADS-B process; always 1.",
    ["service", "version"],
)

TASKS = Counter(
    "adsb_sim_agent_tasks_total",
    "Trajectory generation tasks that reached a terminal state.",
    ["outcome"],
)

TASK_DURATION = Histogram(
    "adsb_sim_agent_task_duration_seconds",
    "Wall-clock duration of one trajectory generation task.",
    buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300),
)

#: classified  -- the LLM returned a usable route hint
#: fallback    -- empty or unusable content; a default plan was used
#: truncated_retry -- the response hit the token budget and was retried
ROUTE_HINT = Counter(
    "adsb_sim_agent_route_hint_total",
    "Route-hint outcomes from the LLM.",
    ["outcome"],
)


def init(version: str | None = None) -> None:
    """Publish the identity series. Safe to call more than once.

    The version is read from installed package metadata rather than passed in,
    so it cannot drift from what was actually deployed.
    """
    if version is None:
        try:
            version = _pkg_version(SERVICE)
        except PackageNotFoundError:  # running from a source tree
            version = "0.0.0"
    BUILD_INFO.labels(service=SERVICE, version=version).set(1)


def exposition() -> bytes:
    """The Prometheus text exposition for the default registry.

    Single uvicorn process, no workers -- see ``adsb_agent.metrics.exposition``
    for what would change if that ever stopped being true.
    """
    return generate_latest()
