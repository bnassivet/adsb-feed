"""`reasoning_kwargs` — asking a reasoning model to stop thinking and answer.

Reasoning tokens are charged against the same budget as the answer, so a model
that deliberates at length returns `finish_reason='length'` with EMPTY content.
That looks exactly like a hang: the caller waits out its whole timeout and gets
nothing. This is the knob that prevents it, and it defaults to off.
"""

from __future__ import annotations

import pytest

from adsb_agent.config import settings
from adsb_agent.reasoning import reasoning_kwargs


class TestOffValues:
    # Reasoning is a toggle on some models rather than a dial: gemma-4-12b-qat
    # only honours "none", ignoring "minimal"/"low" entirely. So every plain
    # word for "off" maps onto the one value that actually works.
    @pytest.mark.parametrize(
        "word", ["off", "false", "no", "disabled", "none", "0", "OFF", "  off  "]
    )
    def test_maps_every_off_word_to_none(self, word):
        assert reasoning_kwargs(word, None) == {"reasoning_effort": "none"}


class TestOnValues:
    @pytest.mark.parametrize("word", ["on", "true", "yes", "enabled", "1", "ON"])
    def test_sends_nothing_for_on(self, word):
        """"on" is the model's own default; naming it risks a rejected value."""
        assert reasoning_kwargs(word, None) == {}


class TestGradedLevels:
    @pytest.mark.parametrize("word", ["minimal", "low", "medium", "high"])
    def test_passes_a_graded_level_through(self, word):
        assert reasoning_kwargs(word, None) == {"reasoning_effort": word}

    def test_lowercases_a_graded_level(self):
        assert reasoning_kwargs("HIGH", None) == {"reasoning_effort": "high"}


class TestUnset:
    def test_sends_nothing_when_unset(self):
        """A null field on every request is one some endpoints reject."""
        assert reasoning_kwargs(None, None) == {}

    def test_sends_nothing_for_an_empty_string(self):
        assert reasoning_kwargs("   ", None) == {}


class TestMaxTokens:
    def test_caps_reasoning_tokens_via_extra_body(self):
        assert reasoning_kwargs(None, 256) == {"extra_body": {"reasoning": {"max_tokens": 256}}}

    def test_combines_with_an_effort_setting(self):
        assert reasoning_kwargs("off", 256) == {
            "reasoning_effort": "none",
            "extra_body": {"reasoning": {"max_tokens": 256}},
        }

    @pytest.mark.parametrize("value", [0, -1])
    def test_ignores_a_non_positive_cap(self, value):
        assert reasoning_kwargs(None, value) == {}


class TestDefault:
    # The reported failure: description generation timed out because the model
    # spent its whole budget reasoning and returned nothing.
    def test_reasoning_is_off_by_default(self):
        assert settings.reasoning_effort in {"off", "none", "false", "no", "disabled", "0"}

    def test_the_default_produces_a_real_request_field(self):
        kwargs = reasoning_kwargs(settings.reasoning_effort, settings.reasoning_max_tokens)
        assert kwargs["reasoning_effort"] == "none"
