"""Free-text route hint -> RoutePlan, via a small local LLM.

The model is `qwen2.5-7b-instruct` on LM Studio, so the parsing layer has to
survive markdown fences, prose padding, wrong enum spellings, out-of-range
numbers and outright garbage. Every failure mode degrades to a sensible default
plan rather than raising — a demo feature must never break the chat turn.

Critically: the LLM is never asked for coordinates, and any it volunteers are
ignored. Geometry belongs to `geometry.py`.
"""

from __future__ import annotations

import pytest

from adsb_simulation_agent.intent import (
    INTENT_SYSTEM_PROMPT,
    RETRY_MAX_TOKENS,
    build_intent_messages,
    parse_plan_json,
    parse_route_hint,
)
from adsb_simulation_agent.models import AircraftCategory, RoutePattern

GA = AircraftCategory.GA


class _Msg:
    def __init__(self, content: str, finish_reason: str | None = None):
        self.content = content
        self.response_metadata = {"finish_reason": finish_reason}


class FakeLLM:
    """Minimal stand-in for a LangChain chat model."""

    def __init__(
        self,
        content: str = "",
        error: Exception | None = None,
        finish_reason: str | None = "stop",
    ):
        self.content = content
        self.error = error
        self.finish_reason = finish_reason
        self.calls: list = []

    async def ainvoke(self, messages, **kwargs):
        self.calls.append(messages)
        if self.error:
            raise self.error
        return _Msg(self.content, self.finish_reason)


class TruncatingLLM:
    """Runs out of budget first, then succeeds when given a larger one —
    the behaviour of a reasoning model on a vague hint."""

    def __init__(self, success: str = '{"pattern":"orbit"}'):
        self.success = success
        self.bound_max_tokens: list[int] = []
        self.calls = 0

    def bind(self, **kwargs):
        self.bound_max_tokens.append(kwargs.get("max_tokens"))
        return self

    async def ainvoke(self, messages, **kwargs):
        self.calls += 1
        if self.bound_max_tokens:
            return _Msg(self.success, "stop")
        return _Msg("", "length")


class TestPromptConstruction:
    def test_prompt_forbids_coordinates(self):
        """The guardrail must be stated explicitly, not just implied by schema."""
        lowered = INTENT_SYSTEM_PROMPT.lower()
        assert "coordinate" in lowered or "latitude" in lowered

    def test_prompt_lists_every_pattern(self):
        for pattern in RoutePattern:
            assert pattern.value in INTENT_SYSTEM_PROMPT

    def test_messages_carry_the_hint_and_category(self):
        messages = build_intent_messages("circle the port", AircraftCategory.HELICOPTER)
        blob = " ".join(str(getattr(m, "content", m)) for m in messages)
        assert "circle the port" in blob
        assert "helicopter" in blob.lower()


class TestJsonParsing:
    def test_parses_clean_json(self):
        plan = parse_plan_json('{"pattern":"orbit","radius_nm":3,"bearing_deg":90}', GA)
        assert plan.pattern == RoutePattern.ORBIT
        assert plan.radius_nm == 3
        assert plan.bearing_deg == 90

    def test_parses_json_inside_a_markdown_fence(self):
        raw = '```json\n{"pattern": "racetrack", "radius_nm": 5}\n```'
        assert parse_plan_json(raw, GA).pattern == RoutePattern.RACETRACK

    def test_parses_json_surrounded_by_prose(self):
        raw = 'Sure! Here is the plan:\n{"pattern": "transit"}\nLet me know if that works.'
        assert parse_plan_json(raw, GA).pattern == RoutePattern.TRANSIT

    def test_category_always_comes_from_the_caller(self):
        """The category is a request parameter, not the model's to choose."""
        plan = parse_plan_json('{"pattern":"orbit","category":"fighter"}', GA)
        assert plan.category == GA

    def test_ignores_any_coordinates_the_model_volunteers(self):
        raw = '{"pattern":"orbit","waypoints":[[45.5,-73.6]],"lat":45.5,"lng":-73.6}'
        plan = parse_plan_json(raw, GA)
        assert plan.pattern == RoutePattern.ORBIT
        assert not hasattr(plan, "waypoints")
        assert not hasattr(plan, "lat")


class TestRobustness:
    @pytest.mark.parametrize(
        "raw",
        ["", "   ", "I don't know", "{broken json", "null", "[]", "{}"],
    )
    def test_unusable_output_falls_back_to_a_default_plan(self, raw):
        plan = parse_plan_json(raw, GA, seed=1)
        assert plan.category == GA
        assert plan.pattern in set(RoutePattern)
        assert plan.radius_nm > 0

    def test_unknown_pattern_falls_back(self):
        plan = parse_plan_json('{"pattern":"barrel_roll"}', GA, seed=1)
        assert plan.pattern in set(RoutePattern)

    def test_pattern_matching_is_case_insensitive(self):
        assert parse_plan_json('{"pattern":"ORBIT"}', GA).pattern == RoutePattern.ORBIT

    def test_pattern_synonyms_are_recognised(self):
        """Small models paraphrase; accept the obvious near-misses."""
        assert parse_plan_json('{"pattern":"holding"}', GA).pattern == RoutePattern.ORBIT
        assert parse_plan_json('{"pattern":"landing"}', GA).pattern == RoutePattern.APPROACH

    @pytest.mark.parametrize(
        "raw,field",
        [
            ('{"pattern":"orbit","radius_nm":-5}', "radius_nm"),
            ('{"pattern":"orbit","radius_nm":99999}', "radius_nm"),
            ('{"pattern":"orbit","bearing_deg":720}', "bearing_deg"),
            ('{"pattern":"orbit","bearing_deg":-30}', "bearing_deg"),
            ('{"pattern":"orbit","turn_count":0}', "turn_count"),
            ('{"pattern":"orbit","turn_count":500}', "turn_count"),
            ('{"pattern":"orbit","altitude_ft":-2000}', "altitude_ft"),
        ],
    )
    def test_out_of_range_values_are_clamped_not_rejected(self, raw, field):
        plan = parse_plan_json(raw, GA)
        assert plan.pattern == RoutePattern.ORBIT, "a bad scalar must not lose the pattern"
        value = getattr(plan, field)
        if value is not None:
            assert value >= 0

    def test_string_numbers_are_coerced(self):
        """Local models frequently quote their numbers."""
        plan = parse_plan_json('{"pattern":"orbit","radius_nm":"4.5"}', GA)
        assert plan.radius_nm == pytest.approx(4.5)

    def test_bearing_wraps_rather_than_failing(self):
        assert parse_plan_json('{"pattern":"orbit","bearing_deg":450}', GA).bearing_deg == 90


class TestParseRouteHint:
    async def test_uses_the_llm_response(self):
        llm = FakeLLM('{"pattern":"racetrack","radius_nm":4}')
        plan = await parse_route_hint("patrol up and down the river", GA, llm)
        assert plan.pattern == RoutePattern.RACETRACK
        assert len(llm.calls) == 1

    async def test_no_llm_yields_a_default_plan(self):
        plan = await parse_route_hint("anything", GA, None, seed=3)
        assert plan.category == GA
        assert plan.pattern in set(RoutePattern)

    async def test_empty_hint_skips_the_llm_entirely(self):
        llm = FakeLLM('{"pattern":"orbit"}')
        plan = await parse_route_hint("", GA, llm, seed=3)
        assert llm.calls == [], "no hint means nothing to classify"
        assert plan.category == GA

    async def test_llm_failure_degrades_to_a_default_plan(self):
        """A dead LM Studio must not break trajectory generation."""
        llm = FakeLLM(error=ConnectionError("connection refused"))
        plan = await parse_route_hint("orbit downtown", GA, llm, seed=3)
        assert plan.category == GA
        assert plan.pattern in set(RoutePattern)

    async def test_result_is_always_the_requested_category(self):
        llm = FakeLLM('{"pattern":"maneuver","category":"airliner"}')
        plan = await parse_route_hint("do a display", AircraftCategory.FIGHTER, llm)
        assert plan.category == AircraftCategory.FIGHTER


class TestUnusableOutputIsDiagnosable:
    """Regression from manual E2E: a reasoning model whose token budget ran out
    returns `''`, which parsed as "no hint" and silently produced default
    plans. Correct behaviour, but it must not be invisible."""

    def test_empty_content_logs_a_warning(self, caplog):
        with caplog.at_level("WARNING"):
            parse_plan_json("", GA, seed=1)
        assert any("default plan" in r.message for r in caplog.records)

    def test_warning_includes_what_the_model_returned(self, caplog):
        with caplog.at_level("WARNING"):
            parse_plan_json("I think maybe an orbit?", GA, seed=1)
        blob = " ".join(r.getMessage() for r in caplog.records)
        assert "I think maybe" in blob

    def test_successful_classification_does_not_warn(self, caplog):
        with caplog.at_level("WARNING"):
            parse_plan_json('{"pattern":"orbit"}', GA)
        assert not [r for r in caplog.records if "default plan" in r.message]


class TestTruncationRetry:
    """Reasoning effort scales with how vague the hint is, not its length —
    a bare "downtown" costs ~3x a specific request. Rather than sizing every
    call for the worst case, a truncated answer is retried once."""

    async def test_retries_with_a_larger_budget_when_truncated(self):
        llm = TruncatingLLM('{"pattern":"racetrack"}')
        plan = await parse_route_hint("downtown", GA, llm, seed=1)
        assert llm.calls == 2
        assert plan.pattern == RoutePattern.RACETRACK

    async def test_retry_asks_for_more_tokens(self):
        llm = TruncatingLLM()
        await parse_route_hint("downtown", GA, llm, seed=1)
        assert llm.bound_max_tokens == [RETRY_MAX_TOKENS]

    async def test_no_retry_when_the_first_answer_is_usable(self):
        llm = FakeLLM('{"pattern":"orbit"}', finish_reason="stop")
        await parse_route_hint("circle the port", GA, llm)
        assert len(llm.calls) == 1

    async def test_no_retry_when_the_model_simply_refused(self):
        """finish_reason='stop' with unusable text is a model that answered
        badly, not one that ran out of room — retrying would just cost time."""
        llm = FakeLLM("I'm not sure what you mean", finish_reason="stop")
        plan = await parse_route_hint("???", GA, llm, seed=1)
        assert len(llm.calls) == 1
        assert plan.pattern in set(RoutePattern)

    async def test_still_falls_back_when_the_retry_also_fails(self):
        llm = FakeLLM("", finish_reason="length")
        plan = await parse_route_hint("downtown", GA, llm, seed=1)
        assert plan.category == GA
        assert plan.pattern in set(RoutePattern)

    def test_warning_reports_the_finish_reason(self, caplog):
        with caplog.at_level("WARNING"):
            parse_plan_json("", GA, seed=1, finish_reason="length")
        assert any("length" in r.getMessage() for r in caplog.records)
