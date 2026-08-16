"""The simulation agent's LangGraph (DC1).

Flow: parse_intent -> plan_route -> apply_kinematics -> validate -> (retry | END)

The retry edge is the reason this is a graph rather than a function call: a
route that comes out unflyable gets corrected and regenerated instead of being
returned broken.
"""

from __future__ import annotations

import pytest

from adsb_simulation_agent.graph import (
    build_simulation_graph,
    correct_plan,
    generate,
)
from adsb_simulation_agent.models import (
    AircraftCategory,
    FlightPhase,
    RoutePattern,
    RoutePlan,
    SimulatedAircraftTrajectory,
    TrajectoryRequest,
    TrajectoryResponse,
    Violation,
    Waypoint,
)

GA = AircraftCategory.GA


class FakeLLM:
    def __init__(self, content: str = '{"pattern":"orbit","radius_nm":3}'):
        self.content = content
        self.calls: list = []

    async def ainvoke(self, messages, **kwargs):
        self.calls.append(messages)

        class _Msg:
            def __init__(self, c):
                self.content = c

        return _Msg(self.content)


def _request(**kw) -> TrajectoryRequest:
    params = {"origin_lat": 45.5, "origin_lng": -73.6, "category": GA, "seed": 5}
    params.update(kw)
    return TrajectoryRequest(**params)


def _unflyable_response() -> TrajectoryResponse:
    """A trajectory that violates the GA envelope on every axis."""
    return TrajectoryResponse(
        aircraft=[
            SimulatedAircraftTrajectory(
                hex_ident="SIM-BAD",
                callsign="BAD001",
                category=GA,
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


class TestPlanCorrection:
    def test_turn_rate_violation_widens_the_pattern(self):
        plan = RoutePlan(pattern=RoutePattern.ORBIT, category=GA, radius_nm=2.0)
        corrected = correct_plan(
            plan, [Violation(kind="turn_rate", waypoint_index=1, detail="too tight")]
        )
        assert corrected.radius_nm > plan.radius_nm

    def test_climb_rate_violation_lowers_the_altitude_target(self):
        plan = RoutePlan(pattern=RoutePattern.TRANSIT, category=GA, radius_nm=5.0, altitude_ft=9000)
        corrected = correct_plan(
            plan, [Violation(kind="climb_rate", waypoint_index=1, detail="too steep")]
        )
        assert corrected.altitude_ft is not None
        assert corrected.altitude_ft < 9000

    def test_climb_violation_without_a_target_lengthens_the_route(self):
        plan = RoutePlan(pattern=RoutePattern.TRANSIT, category=GA, radius_nm=5.0)
        corrected = correct_plan(
            plan, [Violation(kind="descent_rate", waypoint_index=1, detail="too steep")]
        )
        assert corrected.radius_nm > plan.radius_nm

    def test_no_violations_leaves_the_plan_alone(self):
        plan = RoutePlan(pattern=RoutePattern.ORBIT, category=GA, radius_nm=2.0)
        assert correct_plan(plan, []) == plan

    def test_correction_stays_within_schema_bounds(self):
        """Repeated widening must not push radius past the model's limit."""
        plan = RoutePlan(pattern=RoutePattern.ORBIT, category=GA, radius_nm=99.0)
        corrected = correct_plan(plan, [Violation(kind="turn_rate", waypoint_index=1, detail="x")])
        assert corrected.radius_nm <= 100.0


class TestGraphFlow:
    async def test_produces_a_valid_trajectory_end_to_end(self):
        response = await generate(_request(), llm=None)
        assert response.aircraft
        assert response.aircraft[0].waypoints
        assert response.violations == []

    async def test_explicit_plan_bypasses_the_llm(self):
        llm = FakeLLM()
        plan = RoutePlan(pattern=RoutePattern.TRANSIT, category=GA, radius_nm=6.0)
        response = await generate(_request(plan=plan), llm=llm)
        assert llm.calls == [], "a structured plan needs no classification"
        assert response.aircraft

    async def test_route_hint_invokes_the_llm(self):
        llm = FakeLLM('{"pattern":"racetrack","radius_nm":4}')
        response = await generate(_request(route_hint="patrol the river"), llm=llm)
        assert len(llm.calls) == 1
        assert response.aircraft

    async def test_count_is_honoured(self):
        response = await generate(_request(count=3), llm=None)
        assert len(response.aircraft) == 3

    async def test_origin_is_respected(self):
        response = await generate(_request(origin_lat=51.5, origin_lng=-0.12), llm=None)
        first = response.aircraft[0].waypoints[0]
        assert abs(first.lat - 51.5) < 2.0
        assert abs(first.lng - (-0.12)) < 2.0


class TestRetryEdge:
    async def test_clean_first_pass_does_not_retry(self):
        calls = {"n": 0}

        def counting_generator(request):
            calls["n"] += 1
            from adsb_simulation_agent.trajectory import generate_trajectory

            return generate_trajectory(request)

        await generate(_request(), llm=None, generator=counting_generator)
        assert calls["n"] == 1

    async def test_violations_trigger_regeneration(self):
        """First attempt unflyable, second clean — the graph must go round again."""
        calls = {"n": 0}

        def flaky_generator(request):
            calls["n"] += 1
            if calls["n"] == 1:
                return _unflyable_response()
            from adsb_simulation_agent.trajectory import generate_trajectory

            return generate_trajectory(request)

        response = await generate(_request(), llm=None, generator=flaky_generator)
        assert calls["n"] == 2
        assert response.violations == [], "the retry should have produced a clean track"

    async def test_retry_budget_is_capped(self):
        calls = {"n": 0}

        def always_bad(request):
            calls["n"] += 1
            return _unflyable_response()

        response = await generate(_request(), llm=None, generator=always_bad, max_retries=2)
        # 1 initial attempt + 2 retries.
        assert calls["n"] == 3
        assert response.aircraft, "best-effort output is still returned"
        assert response.violations, "unresolved violations must be reported"

    async def test_exhausted_retries_report_the_violations(self):
        response = await generate(
            _request(),
            llm=None,
            generator=lambda r: _unflyable_response(),
            max_retries=1,
        )
        kinds = {v.kind for v in response.violations}
        assert "turn_rate" in kinds or "climb_rate" in kinds

    async def test_zero_retries_returns_the_first_attempt(self):
        calls = {"n": 0}

        def always_bad(request):
            calls["n"] += 1
            return _unflyable_response()

        await generate(_request(), llm=None, generator=always_bad, max_retries=0)
        assert calls["n"] == 1


class TestGraphStructure:
    def test_graph_compiles(self):
        assert build_simulation_graph(llm=None) is not None

    def test_expected_nodes_are_present(self):
        graph = build_simulation_graph(llm=None)
        nodes = set(graph.get_graph().nodes)
        for expected in ("parse_intent", "plan_route", "apply_kinematics", "validate"):
            assert expected in nodes

    async def test_llm_failure_still_produces_a_trajectory(self):
        class DeadLLM:
            async def ainvoke(self, messages, **kwargs):
                raise ConnectionError("LM Studio not running")

        response = await generate(_request(route_hint="orbit downtown"), llm=DeadLLM())
        assert response.aircraft, "a dead LLM must degrade, not break"


class TestDeterminism:
    async def test_same_seed_gives_the_same_result(self):
        a = await generate(_request(seed=11), llm=None)
        b = await generate(_request(seed=11), llm=None)
        assert a.model_dump() == b.model_dump()

    @pytest.mark.parametrize("category", list(AircraftCategory))
    async def test_every_category_generates_cleanly(self, category):
        response = await generate(_request(category=category), llm=None)
        assert response.aircraft
        assert response.violations == []
