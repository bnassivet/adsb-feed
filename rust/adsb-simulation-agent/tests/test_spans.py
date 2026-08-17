"""Which spans this service emits, and what they carry.

Patches ``mlflow.start_span`` itself rather than our ``make_span`` wrapper, so
these tests fail if instrumentation stops reaching MLflow at all.

Two properties matter beyond "a span exists":
* the waypoint payload never becomes span I/O (a 2-lap orbit is ~240 waypoints);
* failures are recorded as exceptions, which is what MLflow promotes to ERROR
  level and therefore what makes them findable in the trace explorer.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from a2a.helpers import new_data_part
from a2a.types import Message, Role, TaskState

from adsb_simulation_agent.executor import SimulationAgentExecutor
from adsb_simulation_agent.graph import generate
from adsb_simulation_agent.models import (
    AircraftCategory,
    FlightPhase,
    SimulatedAircraftTrajectory,
    TrajectoryRequest,
    TrajectoryResponse,
    Waypoint,
)
from adsb_simulation_agent.tracing import SpanType

ORIGIN = {"origin_lat": 45.5, "origin_lng": -73.6}


def _request(**overrides) -> TrajectoryRequest:
    return TrajectoryRequest(
        origin_lat=45.5, origin_lng=-73.6, category=AircraftCategory.GA, **overrides
    )


def _unflyable_response() -> TrajectoryResponse:
    """A track that breaches the GA envelope, so `validate` always objects.

    Violations are computed by `validate_response`, not read off the response —
    so forcing a retry means producing genuinely bad geometry: 8000 ft of climb
    and a 170-degree turn, both in two seconds.
    """
    return TrajectoryResponse(
        aircraft=[
            SimulatedAircraftTrajectory(
                hex_ident="SIM-BAD",
                callsign="BAD001",
                category=AircraftCategory.GA,
                waypoints=[
                    Waypoint(
                        lat=45.5,
                        lng=-73.6,
                        alt_ft=1000,
                        speed_kts=120,
                        heading_deg=0,
                        phase=FlightPhase.CRUISE,
                        t_offset_s=0,
                    ),
                    Waypoint(
                        lat=45.6,
                        lng=-73.6,
                        alt_ft=9000,
                        speed_kts=120,
                        heading_deg=170,
                        phase=FlightPhase.CRUISE,
                        t_offset_s=2,
                    ),
                ],
            )
        ]
    )


@dataclass
class RecordedSpan:
    """A span the code under test opened, plus everything it put on it."""

    name: str
    span_type: str
    inputs: dict | None = None
    outputs: object = None
    attributes: dict = field(default_factory=dict)
    exceptions: list = field(default_factory=list)

    # -- the mlflow span API surface we use -------------------------------
    def set_inputs(self, value):
        self.inputs = value

    def set_outputs(self, value):
        self.outputs = value

    def set_attributes(self, values):
        self.attributes.update(values)

    def record_exception(self, exc):
        self.exceptions.append(exc)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class SpanRecorder:
    def __init__(self):
        self.spans: list[RecordedSpan] = []

    def __call__(self, name: str, span_type: str = "UNKNOWN"):
        span = RecordedSpan(name=name, span_type=span_type)
        self.spans.append(span)
        return span

    def named(self, name: str) -> list[RecordedSpan]:
        return [s for s in self.spans if s.name == name]

    def one(self, name: str) -> RecordedSpan:
        matches = self.named(name)
        assert len(matches) == 1, f"expected one {name!r} span, got {len(matches)}"
        return matches[0]

    @property
    def names(self) -> list[str]:
        return [s.name for s in self.spans]


@pytest.fixture
def spans(monkeypatch):
    """Record every span opened, with tracing enabled."""
    import mlflow

    from adsb_simulation_agent.config import settings

    monkeypatch.setattr(settings, "mlflow_enabled", True)
    recorder = SpanRecorder()
    monkeypatch.setattr(mlflow, "start_span", lambda name, span_type: recorder(name, span_type))
    return recorder


@pytest.fixture
def traced(monkeypatch):
    """Record trace-level metadata calls."""
    import mlflow

    from adsb_simulation_agent.config import settings

    monkeypatch.setattr(settings, "mlflow_enabled", True)
    calls: list[dict] = []
    monkeypatch.setattr(mlflow, "update_current_trace", lambda **kw: calls.append(kw))
    return calls


class RecordingQueue:
    def __init__(self):
        self.events: list = []

    async def enqueue_event(self, event):
        self.events.append(event)


class FakeContext:
    def __init__(self, payload: dict, task_id="task-1", context_id="ctx-1"):
        self.message = Message(
            message_id="msg-1", role=Role.ROLE_USER, parts=[new_data_part(payload)]
        )
        self.task_id = task_id
        self.context_id = context_id
        self.current_task = None

    def get_user_input(self):
        return ""


# ---------------------------------------------------------------------------
# Graph node spans
# ---------------------------------------------------------------------------


class TestGraphNodeSpans:
    async def test_each_node_opens_a_span(self, spans):
        await generate(_request())
        for node in ("parse_intent", "plan_route", "apply_kinematics", "validate"):
            assert node in spans.names, f"{node} span missing"

    async def test_intent_is_a_parser_not_an_llm_span(self, spans):
        """openai autolog emits the real LLM span *inside* this one.

        Typing the wrapper LLM as well would double-count LLM spans in the trace.
        """
        await generate(_request())
        assert spans.one("parse_intent").span_type == SpanType.PARSER

    async def test_compute_nodes_are_chain_spans(self, spans):
        await generate(_request())
        for node in ("plan_route", "apply_kinematics", "validate"):
            assert spans.one(node).span_type == SpanType.CHAIN

    async def test_validate_span_records_attempts_and_violations(self, spans):
        await generate(_request())
        span = spans.one("validate")
        assert span.outputs["attempts"] == 1
        assert span.outputs["violations"] == 0

    async def test_apply_kinematics_reports_size_not_waypoints(self, spans):
        """Span I/O must stay compact — hundreds of waypoints don't belong."""
        await generate(_request(count=2))
        span = spans.one("apply_kinematics")
        assert span.outputs["aircraft"] == 2
        assert "waypoints" not in str(span.outputs).lower() or isinstance(
            span.outputs.get("waypoints"), int
        )

    async def test_retry_shows_as_repeated_sibling_spans(self, spans):
        """The retry edge is the behaviour most worth seeing in a trace."""

        def always_bad(_request):
            return _unflyable_response()

        await generate(_request(), max_retries=2, generator=always_bad)
        assert len(spans.named("plan_route")) == 3  # initial + 2 retries
        assert len(spans.named("validate")) == 3

    async def test_no_spans_when_disabled(self, spans, monkeypatch):
        from adsb_simulation_agent.config import settings

        monkeypatch.setattr(settings, "mlflow_enabled", False)
        await generate(_request())
        assert spans.names == []


# ---------------------------------------------------------------------------
# Executor span
# ---------------------------------------------------------------------------


class TestExecutorSpan:
    async def test_opens_an_agent_span(self, spans):
        await SimulationAgentExecutor().execute(FakeContext(ORIGIN), RecordingQueue())
        assert spans.one("simulate_trajectory").span_type == SpanType.AGENT

    async def test_records_request_details_as_attributes(self, spans):
        await SimulationAgentExecutor().execute(
            FakeContext({**ORIGIN, "category": "helicopter", "count": 2}), RecordingQueue()
        )
        attrs = spans.one("simulate_trajectory").attributes
        assert attrs["a2a.task_id"] == "task-1"
        assert attrs["a2a.context_id"] == "ctx-1"
        assert attrs["simulation.category"] == "helicopter"
        assert attrs["simulation.count"] == 2

    async def test_outputs_are_the_summary_not_the_payload(self, spans):
        """The whole point of TrajectoryResponse.summary() — keep traces small."""
        await SimulationAgentExecutor().execute(
            FakeContext({**ORIGIN, "count": 2}), RecordingQueue()
        )
        outputs = spans.one("simulate_trajectory").outputs
        assert "2 aircraft" in outputs["summary"]
        assert "waypoints" not in outputs

    async def test_bad_request_records_the_exception(self, spans):
        """MLflow promotes spans with an exception event to ERROR level."""
        queue = RecordingQueue()
        await SimulationAgentExecutor().execute(FakeContext({"category": "ga"}), queue)

        span = spans.one("simulate_trajectory")
        assert span.exceptions, "failure was not recorded on the span"
        assert "origin" in str(span.exceptions[0]).lower()
        assert queue.events[-1].status.state == TaskState.TASK_STATE_FAILED

    async def test_generation_failure_records_the_exception(self, spans, monkeypatch):
        import adsb_simulation_agent.executor as executor_module

        async def boom(*_a, **_kw):
            raise RuntimeError("geometry exploded")

        monkeypatch.setattr(executor_module, "generate", boom)
        await SimulationAgentExecutor().execute(FakeContext(ORIGIN), RecordingQueue())
        assert "geometry exploded" in str(spans.one("simulate_trajectory").exceptions[0])


# ---------------------------------------------------------------------------
# Trace-level metadata
# ---------------------------------------------------------------------------


class TestTraceMetadata:
    async def test_tags_the_trace_when_running_standalone(self, spans, traced):
        await SimulationAgentExecutor().execute(FakeContext(ORIGIN), RecordingQueue())
        assert traced == [
            {"client_request_id": "task-1", "tags": {"agent": "adsb-simulation-agent"}}
        ]

    async def test_does_not_touch_the_trace_when_linked(self, spans, traced, monkeypatch):
        """Linked means the caller owns the trace — tagging would clobber its
        session_id, since update_current_trace is trace-scoped, not span-scoped."""
        import adsb_simulation_agent.tracing as tracing_module

        monkeypatch.setattr(tracing_module, "is_linked", lambda: True)
        await SimulationAgentExecutor().execute(FakeContext(ORIGIN), RecordingQueue())
        assert traced == []
