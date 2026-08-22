"""The simulation agent's LangGraph.

::

    START -> parse_intent -> plan_route -> apply_kinematics -> validate -+-> END
                                  ^                                      |
                                  +-------------- (violations) ----------+

Why a graph and not a function: the ``validate -> plan_route`` edge. A route
that comes out unflyable — turns too tight for the category, a climb steeper
than the aircraft can manage — is corrected and regenerated rather than
returned broken. ``trajectory.py`` is built so this rarely fires; it is the
safety net that makes the guarantee unconditional.

The LLM appears only in ``parse_intent``, and only to classify free text into a
``RoutePlan``. Every other node is deterministic.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, NotRequired, TypedDict

from langgraph.graph import END, START, StateGraph

from .config import settings
from .intent import parse_route_hint
from .models import (
    RouteLeg,
    RoutePlan,
    SpeedBias,
    TrajectoryRequest,
    TrajectoryResponse,
    Violation,
)
from .tracing import SpanType, make_span
from .trajectory import generate_trajectory
from .validate import describe_violations, validate_response

logger = logging.getLogger("adsb_simulation_agent.graph")

Generator = Callable[[TrajectoryRequest], TrajectoryResponse]

RADIUS_WIDEN_FACTOR = 1.6
"""How much to enlarge a pattern when its turns proved too tight."""

ALTITUDE_BACKOFF_FACTOR = 0.6
"""How much to lower an altitude target that proved unreachable."""

MAX_RADIUS_NM = 100.0
"""Mirrors the ``RoutePlan.radius_nm`` schema bound — corrections must stay valid."""

_SLOWER_BIAS: dict[SpeedBias, SpeedBias] = {
    SpeedBias.FAST: SpeedBias.NORMAL,
    SpeedBias.NORMAL: SpeedBias.SLOW,
}
"""One step down the speed band, for a leg that cannot be widened."""


class SimulationState(TypedDict):
    """State threaded through the graph.

    Only ``request`` is present from the start; the rest accumulate as nodes run,
    which is why they are ``NotRequired`` and read with ``.get()``.
    """

    request: TrajectoryRequest
    plan: NotRequired[RoutePlan]
    response: NotRequired[TrajectoryResponse]
    violations: NotRequired[list[Violation]]
    attempts: NotRequired[int]


def _correct_leg(leg: RouteLeg, kinds: set[str]) -> RouteLeg:
    """Apply the corrective levers to one leg.

    Pattern size and altitude target are the main two, because those are what
    make a route infeasible: turns tighter than the category's minimum radius,
    and altitude changes that need more time than the route provides. Speed is
    the third, and applies only to anchored legs — see below.
    """
    radius = leg.radius_nm
    altitude = leg.altitude_ft
    speed_bias = leg.speed_bias

    if "turn_rate" in kinds:
        radius = min(radius * RADIUS_WIDEN_FACTOR, MAX_RADIUS_NM)
        # Widening does nothing to a leg pinned between two coordinates the user
        # named — its geometry is not ours to change. The lever there is speed:
        # turn radius is v/omega, so the way to fit a turn you cannot enlarge is
        # to fly it slower. Which is what a real crew would do.
        if leg.has_anchor:
            speed_bias = _SLOWER_BIAS.get(speed_bias, speed_bias)

    if kinds & {"climb_rate", "descent_rate"}:
        if altitude is not None:
            # Ask for less height rather than more room.
            altitude = altitude * ALTITUDE_BACKOFF_FACTOR
        else:
            # No explicit target, so buy time by making the route longer.
            radius = min(radius * RADIUS_WIDEN_FACTOR, MAX_RADIUS_NM)

    if "speed_band" in kinds:
        radius = min(radius * RADIUS_WIDEN_FACTOR, MAX_RADIUS_NM)

    return leg.model_copy(
        update={"radius_nm": radius, "altitude_ft": altitude, "speed_bias": speed_bias}
    )


def correct_plan(plan: RoutePlan, violations: list[Violation]) -> RoutePlan:
    """Adjust a plan in response to what made the last attempt unflyable.

    Corrections are applied *per leg*: on a three-leg route only the leg whose
    waypoints breached anything gets widened, so a tight orbit in the middle
    doesn't stretch the transits either side of it. A violation that carries no
    leg attribution falls back to correcting every leg, which is also what
    single-leg plans get.
    """
    if not violations:
        return plan

    by_leg: dict[int | None, set[str]] = {}
    for violation in violations:
        by_leg.setdefault(violation.leg_index, set()).add(violation.kind)

    # An unattributed violation applies everywhere.
    unattributed = by_leg.pop(None, set())

    legs = [
        _correct_leg(leg, kinds) if (kinds := unattributed | by_leg.get(index, set())) else leg
        for index, leg in enumerate(plan.legs)
    ]
    return plan.model_copy(update={"legs": legs})


def build_simulation_graph(
    llm: Any | None = None,
    max_retries: int | None = None,
    generator: Generator | None = None,
):
    """Compile the trajectory-generation graph.

    Args:
        llm: Chat model used to classify free-text route hints. ``None`` means
            hints are ignored and a seeded default plan is used — the service
            still works with no LLM available.
        max_retries: Regeneration attempts allowed after a failed validation.
        generator: Trajectory builder; injectable so tests can drive the retry
            edge without having to construct a geometrically infeasible request.
    """
    retries = settings.max_retries if max_retries is None else max_retries
    build = generator or generate_trajectory

    # Spans live inside the nodes rather than around `graph.ainvoke`, so a trip
    # round the retry edge shows up as repeated sibling spans — which is exactly
    # the behaviour worth being able to see in a trace.

    async def parse_intent(state: SimulationState) -> dict:
        request = state["request"]
        # PARSER, not LLM: openai autolog emits the real LLM span *inside* this
        # one, and typing the wrapper LLM too would double-count them.
        with make_span("parse_intent", SpanType.PARSER) as span:
            if span is not None:
                span.set_inputs(
                    {"route_hint": request.route_hint, "category": request.category.value}
                )
            if request.plan is not None:
                plan = request.plan
                source = "caller"
            else:
                plan = await parse_route_hint(
                    request.route_hint, request.category, llm, seed=request.seed
                )
                source = "llm" if llm is not None else "default"
            if span is not None:
                span.set_outputs({"plan": plan.model_dump(mode="json"), "source": source})
            return {"plan": plan, "attempts": 0}

    def plan_route(state: SimulationState) -> dict:
        """Apply corrections from the previous failed attempt, if any."""
        plan = state.get("plan")
        if plan is None:  # pragma: no cover — parse_intent always sets it
            raise ValueError("plan_route reached without a plan")
        violations = state.get("violations") or []
        with make_span("plan_route", SpanType.CHAIN) as span:
            if span is not None:
                span.set_inputs(
                    {"plan": plan.model_dump(mode="json"), "correcting": len(violations)}
                )
            if violations:
                plan = correct_plan(plan, violations)
                logger.info(
                    "Regenerating after %d violation(s):\n%s",
                    len(violations),
                    describe_violations(violations),
                )
            if span is not None:
                span.set_outputs({"plan": plan.model_dump(mode="json")})
            return {"plan": plan}

    def apply_kinematics(state: SimulationState) -> dict:
        request = state["request"].model_copy(update={"plan": state.get("plan")})
        with make_span("apply_kinematics", SpanType.CHAIN) as span:
            if span is not None:
                span.set_inputs({"count": request.count, "category": request.category.value})
            response = build(request)
            if span is not None:
                # Counts only: a 2-lap helicopter orbit is ~240 waypoints, and
                # span I/O is not the place for them.
                span.set_outputs(
                    {
                        "aircraft": len(response.aircraft),
                        "waypoints": sum(len(a.waypoints) for a in response.aircraft),
                    }
                )
            return {"response": response}

    def validate(state: SimulationState) -> dict:
        response = state.get("response")
        with make_span("validate", SpanType.CHAIN) as span:
            violations = validate_response(response) if response else []
            attempts = state.get("attempts", 0) + 1
            if span is not None:
                span.set_outputs(
                    {
                        "attempts": attempts,
                        "violations": len(violations),
                        "kinds": sorted({v.kind for v in violations}),
                    }
                )
            return {"violations": violations, "attempts": attempts}

    def route_after_validate(state: SimulationState) -> str:
        if state.get("violations") and state.get("attempts", 0) <= retries:
            return "plan_route"
        return END

    graph = StateGraph(SimulationState)
    graph.add_node("parse_intent", parse_intent)
    graph.add_node("plan_route", plan_route)
    graph.add_node("apply_kinematics", apply_kinematics)
    graph.add_node("validate", validate)

    graph.add_edge(START, "parse_intent")
    graph.add_edge("parse_intent", "plan_route")
    graph.add_edge("plan_route", "apply_kinematics")
    graph.add_edge("apply_kinematics", "validate")
    graph.add_conditional_edges(
        "validate", route_after_validate, {"plan_route": "plan_route", END: END}
    )
    return graph.compile()


async def generate(
    request: TrajectoryRequest,
    llm: Any | None = None,
    max_retries: int | None = None,
    generator: Generator | None = None,
) -> TrajectoryResponse:
    """Run the graph for one request.

    Any violations left unresolved when the retry budget runs out are attached
    to the response rather than raised: a best-effort trajectory with a warning
    is more useful to a demo than an error.
    """
    graph = build_simulation_graph(llm=llm, max_retries=max_retries, generator=generator)
    final = await graph.ainvoke({"request": request})

    response = final.get("response") or TrajectoryResponse(aircraft=[])
    violations = final.get("violations") or []
    if violations:
        logger.warning(
            "Returning best-effort trajectory with %d unresolved violation(s)",
            len(violations),
        )
        response = response.model_copy(update={"violations": violations})
    return response
