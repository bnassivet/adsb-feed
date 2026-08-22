"""Free-text route hint -> RoutePlan, via a small local LLM.

The model is `qwen2.5-7b-instruct` on LM Studio, so the parsing layer has to
survive markdown fences, prose padding, wrong enum spellings, out-of-range
numbers and outright garbage. Every failure mode degrades to a sensible default
plan rather than raising — a demo feature must never break the chat turn.

Critically: the LLM is never asked for coordinates, and any it volunteers are
ignored. Geometry belongs to `geometry.py`.
"""

from __future__ import annotations

import logging

import pytest

from adsb_simulation_agent.intent import (
    COMPACT_INTENT_SYSTEM_PROMPT,
    INTENT_SYSTEM_PROMPT,
    MAX_LEGS,
    RETRY_MAX_TOKENS,
    build_intent_messages,
    extract_coordinates,
    parse_plan_json,
    parse_route_hint,
    retry_token_budget,
    select_intent_prompt,
)
from adsb_simulation_agent.models import AircraftCategory, RoutePattern, SpeedBias

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
        """More than the call that just ran out — not a fixed constant, which
        would be *less* whenever `max_tokens` is configured above it."""
        from adsb_simulation_agent.config import settings

        llm = TruncatingLLM()
        await parse_route_hint("downtown", GA, llm, seed=1)
        assert len(llm.bound_max_tokens) == 1
        assert llm.bound_max_tokens[0] > settings.max_tokens
        assert llm.bound_max_tokens[0] >= RETRY_MAX_TOKENS

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


# ---------------------------------------------------------------------------
# Multi-leg routes and coordinate corroboration
# ---------------------------------------------------------------------------

WORKED_EXAMPLE = (
    "Simulate a flight with 3 fighters coming from (46.49365, -1.79214) at 10000ft "
    "altitude, manoeuvering at high speed above ILE D'YEU (46.69154, -2.35931), also "
    "going up and down at altitudes between 1000 and 3000 feets, then going towards "
    "(46.71161, -1.92810)"
)


class TestCoordinateExtraction:
    def test_pulls_parenthesised_pairs_in_order(self):
        assert extract_coordinates(WORKED_EXAMPLE) == [
            (46.49365, -1.79214),
            (46.69154, -2.35931),
            (46.71161, -1.92810),
        ]

    def test_accepts_bare_pairs(self):
        assert extract_coordinates("go from 45.5,-73.6 to 46.0, -74.0") == [
            (45.5, -73.6),
            (46.0, -74.0),
        ]

    def test_ignores_out_of_range_numbers(self):
        assert extract_coordinates("climb to (10000, 3000) feet") == []

    def test_ignores_prose_without_coordinates(self):
        assert extract_coordinates("a helicopter circling the port") == []

    def test_requires_a_decimal_point(self):
        """Bare integer pairs are far more often altitudes or counts than fixes."""
        assert extract_coordinates("between 1000 and 3000 feet") == []


class TestAnchorCorroboration:
    """The model may *copy* a coordinate; it may never invent one."""

    def test_a_corroborated_anchor_survives(self):
        raw = '{"legs":[{"pattern":"transit","anchor_lat":46.69154,"anchor_lng":-2.35931}]}'
        plan = parse_plan_json(raw, GA, hint=WORKED_EXAMPLE)
        assert plan.legs[0].has_anchor
        assert plan.legs[0].anchor_lat == pytest.approx(46.69154)

    def test_an_invented_anchor_is_discarded(self):
        """Nothing like this appears in the hint, so it did not come from the user."""
        raw = '{"legs":[{"pattern":"orbit","anchor_lat":12.3456,"anchor_lng":98.7654}]}'
        plan = parse_plan_json(raw, GA, hint=WORKED_EXAMPLE)
        assert not plan.legs[0].has_anchor

    def test_an_anchor_is_discarded_when_there_is_no_hint(self):
        raw = '{"legs":[{"pattern":"orbit","anchor_lat":46.69154,"anchor_lng":-2.35931}]}'
        assert not parse_plan_json(raw, GA).legs[0].has_anchor

    def test_a_near_miss_snaps_to_the_users_coordinate(self):
        """A model that rounds 46.69154 to 46.69 still meant the user's point."""
        raw = '{"legs":[{"pattern":"orbit","anchor_lat":46.6915,"anchor_lng":-2.3593}]}'
        plan = parse_plan_json(raw, GA, hint=WORKED_EXAMPLE)
        assert plan.legs[0].anchor_lat == pytest.approx(46.69154)
        assert plan.legs[0].anchor_lng == pytest.approx(-2.35931)

    def test_unanchored_legs_are_filled_positionally_when_counts_match(self):
        raw = '{"legs":[{"pattern":"transit"},{"pattern":"maneuver"},{"pattern":"transit"}]}'
        plan = parse_plan_json(raw, GA, hint=WORKED_EXAMPLE)
        assert [leg.has_anchor for leg in plan.legs] == [True, True, True]
        assert plan.legs[2].anchor_lat == pytest.approx(46.71161)

    def test_no_positional_fill_when_the_counts_disagree(self):
        """Guessing an alignment we can't justify would place aircraft wrongly."""
        raw = '{"legs":[{"pattern":"transit"},{"pattern":"orbit"}]}'
        plan = parse_plan_json(raw, GA, hint=WORKED_EXAMPLE)
        assert [leg.has_anchor for leg in plan.legs] == [False, False]


class TestMultiLegParsing:
    def test_a_legs_array_becomes_multiple_legs(self):
        raw = """
        {"legs": [
          {"pattern": "transit", "altitude_ft": 10000},
          {"pattern": "maneuver", "radius_nm": 5, "speed_bias": "fast",
           "altitude_min_ft": 1000, "altitude_max_ft": 3000},
          {"pattern": "transit"}
        ]}
        """
        plan = parse_plan_json(raw, AircraftCategory.FIGHTER, hint=WORKED_EXAMPLE)
        assert len(plan.legs) == 3
        assert plan.legs[0].altitude_ft == 10000
        assert plan.legs[1].pattern == RoutePattern.MANEUVER
        assert plan.legs[1].speed_bias == SpeedBias.FAST
        assert plan.legs[1].oscillates

    def test_a_legacy_single_object_still_works(self):
        plan = parse_plan_json('{"pattern":"orbit","radius_nm":2.5}', GA)
        assert len(plan.legs) == 1
        assert plan.pattern == RoutePattern.ORBIT
        assert plan.radius_nm == 2.5

    def test_per_leg_scalars_are_clamped_not_rejected(self):
        raw = '{"legs":[{"pattern":"orbit","radius_nm":9999,"turn_count":99,"bearing_deg":450}]}'
        plan = parse_plan_json(raw, GA)
        assert plan.legs[0].radius_nm == 100.0
        assert plan.legs[0].turn_count == 10
        assert plan.legs[0].bearing_deg == 90.0

    def test_an_unusable_leg_is_dropped_but_the_rest_survive(self):
        raw = '{"legs":[{"pattern":"transit"},{"pattern":"not-a-pattern"},{"pattern":"orbit"}]}'
        plan = parse_plan_json(raw, GA)
        assert [leg.pattern for leg in plan.legs] == [RoutePattern.TRANSIT, RoutePattern.ORBIT]

    def test_falls_back_to_a_default_when_no_leg_survives(self):
        plan = parse_plan_json('{"legs":[{"pattern":"nonsense"}]}', GA, seed=5)
        assert len(plan.legs) == 1

    def test_leg_count_is_capped(self):
        raw = '{"legs":[' + ",".join(['{"pattern":"orbit"}'] * 40) + "]}"
        assert len(parse_plan_json(raw, GA).legs) <= MAX_LEGS

    def test_an_unusable_speed_bias_degrades_to_normal(self):
        plan = parse_plan_json('{"legs":[{"pattern":"orbit","speed_bias":"ludicrous"}]}', GA)
        assert plan.legs[0].speed_bias == SpeedBias.NORMAL


class TestMultiLegPrompt:
    def test_the_prompt_describes_legs(self):
        assert "legs" in INTENT_SYSTEM_PROMPT.lower()

    def test_the_prompt_still_forbids_inventing_coordinates(self):
        lowered = INTENT_SYSTEM_PROMPT.lower()
        assert "invent" in lowered or "never" in lowered


class TestRetryBudgetActuallyGrows:
    """The truncation retry must ask for *more* room, not less.

    `RETRY_MAX_TOKENS` is a constant but `max_tokens` is configurable, so a
    deployment that raises the normal budget above the constant inverted the
    retry: the first call got 8192 tokens, the "larger budget" retry got 4096.
    A reasoning model that ran out of room at 8192 has no chance at 4096, so the
    retry burned another full LLM round-trip and could never succeed.
    """

    def test_the_retry_budget_exceeds_the_configured_budget(self):
        from adsb_simulation_agent.config import settings

        assert retry_token_budget(settings.max_tokens) > settings.max_tokens

    def test_it_grows_a_small_configured_budget_to_the_floor(self):
        assert retry_token_budget(512) == RETRY_MAX_TOKENS

    def test_it_grows_past_a_large_configured_budget(self):
        assert retry_token_budget(8192) > 8192

    def test_it_is_monotonic(self):
        budgets = [retry_token_budget(n) for n in (256, 1024, 4096, 8192, 16384)]
        assert budgets == sorted(budgets)


class TestReasoningModelDiagnostic:
    """A reasoning model that eats its whole budget must say so in the log.

    `gemma-4-12b-qat:2` returns `finish_reason='length'` with empty content and
    `reasoning_tokens` equal to the entire budget — it thinks until it runs out
    and never writes an answer. The generic "could not be classified" warning
    gave no hint that the *model choice* was the problem, so it looked like a
    prompt or transport fault.
    """

    def test_it_reports_a_budget_spent_entirely_on_reasoning(self, caplog):
        usage = {"completion_tokens": 2048, "completion_tokens_details": {"reasoning_tokens": 2045}}
        with caplog.at_level(logging.WARNING):
            parse_plan_json("", GA, finish_reason="length", usage=usage)
        assert "reasoning" in caplog.text.lower()

    def test_it_stays_quiet_about_reasoning_when_there_was_none(self, caplog):
        with caplog.at_level(logging.WARNING):
            parse_plan_json("", GA, finish_reason="length")
        assert "reasoning" not in caplog.text.lower()

    def test_it_still_returns_a_usable_default_plan(self):
        usage = {"completion_tokens": 2048, "completion_tokens_details": {"reasoning_tokens": 2045}}
        plan = parse_plan_json("", GA, seed=3, usage=usage)
        assert len(plan.legs) == 1


class TestCompactPrompt:
    """A smaller prompt for models that cannot afford the full one.

    The multi-leg prompt is ~2.4k characters. On a constrained or reasoning
    model that is enough to push the answer past the token budget entirely, so
    there is a stripped variant that keeps the schema and drops the teaching.
    """

    def test_it_is_substantially_smaller(self):
        assert len(COMPACT_INTENT_SYSTEM_PROMPT) < len(INTENT_SYSTEM_PROMPT) / 2

    def test_it_still_lists_every_pattern(self):
        for pattern in RoutePattern:
            assert pattern.value in COMPACT_INTENT_SYSTEM_PROMPT

    def test_it_still_asks_for_legs(self):
        assert "legs" in COMPACT_INTENT_SYSTEM_PROMPT.lower()

    def test_it_still_forbids_inventing_coordinates(self):
        assert "invent" in COMPACT_INTENT_SYSTEM_PROMPT.lower()

    def test_it_names_the_anchor_fields(self):
        assert "anchor_lat" in COMPACT_INTENT_SYSTEM_PROMPT
        assert "anchor_lng" in COMPACT_INTENT_SYSTEM_PROMPT

    def test_it_names_the_oscillation_and_speed_fields(self):
        assert "altitude_min_ft" in COMPACT_INTENT_SYSTEM_PROMPT
        assert "speed_bias" in COMPACT_INTENT_SYSTEM_PROMPT


class TestPromptSelection:
    def test_full_is_the_default_style(self):
        assert select_intent_prompt("full") is INTENT_SYSTEM_PROMPT

    def test_compact_is_selectable(self):
        assert select_intent_prompt("compact") is COMPACT_INTENT_SYSTEM_PROMPT

    def test_an_unknown_style_falls_back_to_full(self):
        """A typo in .env must not silently degrade route understanding."""
        assert select_intent_prompt("nonsense") is INTENT_SYSTEM_PROMPT

    def test_the_style_is_case_and_space_insensitive(self):
        assert select_intent_prompt("  Compact ") is COMPACT_INTENT_SYSTEM_PROMPT

    def test_messages_use_the_selected_prompt(self):
        msgs = build_intent_messages("circle the port", GA, prompt_style="compact")
        assert msgs[0].content is COMPACT_INTENT_SYSTEM_PROMPT

    def test_messages_default_to_the_configured_style(self):
        from adsb_simulation_agent.config import settings

        msgs = build_intent_messages("circle the port", GA)
        assert msgs[0].content is select_intent_prompt(settings.prompt_style)


class TestCompactPromptStillParses:
    """The compact prompt must elicit output the parser accepts."""

    def test_a_compact_style_reply_parses_to_multiple_legs(self):
        raw = '{"legs":[{"pattern":"transit"},{"pattern":"orbit","radius_nm":2}]}'
        plan = parse_plan_json(raw, GA)
        assert len(plan.legs) == 2
