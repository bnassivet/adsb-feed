"""Prometheus metrics for the agent service.

# Why this exists alongside MLflow tracing

MLflow already captures far richer per-run detail than Prometheus ever will:
spans, prompts, token counts, tool arguments. This is not a replacement, and
it deliberately does not try to be one. It covers the three things tracing
cannot:

- **It works when MLflow does not.** MLflow being down is a documented failure
  mode here, and a loud one: both agents resolve their experiment at import
  time and retry a refused connection with backoff, so an MLflow that is down
  makes them *hang at startup*. The metrics that would tell you so must not
  live in MLflow.
- **It is cheap enough to keep unsampled, forever.** Counters cost bytes;
  traces cost storage, so they get sampled, and the turn you want is the one
  that was dropped.
- **It alerts.** `rate(adsb_agent_runs_total{outcome="error"}[5m])` is an alert
  rule; a trace is something a person goes and looks at after being told.

# Cardinality

Labels are bounded sets only: `outcome` is ok/error, `tool` is the
code-defined tool names, `kind` is a small error classification. Never a
model-supplied string, a thread id, or an error message -- those belong in the
trace, which is built for them.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

#: Media type a scrape must be served as.
CONTENT_TYPE = CONTENT_TYPE_LATEST

SERVICE = "adsb-agent"

#: Identity, as an always-1 gauge, matching the Rust services' convention.
#: The agents carry no `source_id`: they are per-stack, not per-receiver.
BUILD_INFO = Gauge(
    "adsb_build_info",
    "Identity and version of this ADS-B process; always 1.",
    ["service", "version"],
)

RUNS = Counter(
    "adsb_agent_runs_total",
    "Agent runs that reached a terminal state.",
    ["outcome"],
)

#: Default histogram buckets top out around 10s, which is the wrong shape
#: entirely for an LLM turn -- a multi-hop tool-calling run routinely takes a
#: minute. These are chosen so the p95 of a slow turn is still on the scale.
RUN_DURATION = Histogram(
    "adsb_agent_run_duration_seconds",
    "Wall-clock duration of an agent run.",
    buckets=(0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300),
)

ACTIVE_RUNS = Gauge(
    "adsb_agent_active_runs",
    "Agent runs currently in flight.",
)

SSE_STREAMS = Gauge(
    "adsb_agent_sse_streams_active",
    "Open AG-UI SSE response streams.",
)

TOOL_CALLS = Counter(
    "adsb_agent_tool_calls_total",
    "Tool invocations by the agent.",
    ["tool", "outcome"],
)

TOOL_DURATION = Histogram(
    "adsb_agent_tool_call_duration_seconds",
    "Wall-clock duration of one tool invocation.",
    ["tool"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30),
)

LLM_ERRORS = Counter(
    "adsb_agent_llm_errors_total",
    "Failures talking to the LLM endpoint, by class.",
    ["kind"],
)

SIMULATION_CALLS = Counter(
    "adsb_agent_simulation_calls_total",
    "A2A calls to the simulation agent.",
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

    One uvicorn process, no workers, so the default registry is correct. If
    workers are ever added this needs ``PROMETHEUS_MULTIPROC_DIR`` and a
    ``CollectorRegistry(multiproc)``, or each worker reports only its own share
    and the totals silently undercount.
    """
    return generate_latest()
