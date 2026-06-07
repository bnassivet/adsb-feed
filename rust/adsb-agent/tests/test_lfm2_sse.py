"""SSE parsing for the LFM2.5-Audio backend.

Regression: the parser only accepted ``data: `` (with a space). LiquidAI's
llama-liquid-audio-server emits ``data:`` without a space, so every event was
dropped and the transcript came back empty despite a healthy 200 stream.
"""

from __future__ import annotations

from adsb_agent.voice.lfm2_audio import _content_from_chunk, _strip_sse_data_prefix


def test_strip_handles_spaced_and_unspaced():
    assert _strip_sse_data_prefix("data: {}") == "{}"
    assert _strip_sse_data_prefix("data:{}") == "{}"


def test_strip_preserves_inner_whitespace_after_single_space():
    # Only ONE leading space is part of the SSE framing.
    assert _strip_sse_data_prefix("data:  x") == " x"


def test_strip_returns_none_for_non_data_lines():
    assert _strip_sse_data_prefix("event: message") is None
    assert _strip_sse_data_prefix(": comment") is None
    assert _strip_sse_data_prefix("") is None


def test_content_from_streaming_delta():
    chunk = {"choices": [{"delta": {"content": "hello"}}]}
    assert _content_from_chunk(chunk) == "hello"


def test_content_from_nonstreaming_message():
    chunk = {"choices": [{"message": {"content": "world"}}]}
    assert _content_from_chunk(chunk) == "world"


def test_content_empty_or_missing_returns_none():
    assert _content_from_chunk({"choices": [{"delta": {}}]}) is None
    assert _content_from_chunk({"choices": [{"delta": {"content": ""}}]}) is None
    assert _content_from_chunk({"choices": []}) is None
    assert _content_from_chunk({}) is None


def test_end_to_end_unspaced_stream_yields_text():
    """Simulate the exact server output that previously produced ''."""
    lines = [
        'data:{"choices":[{"delta":{"content":"show "}}]}',
        'data:{"choices":[{"delta":{"content":"me flights"}}]}',
        "data:[DONE]",
    ]
    parts = []
    for line in lines:
        raw = _strip_sse_data_prefix(line)
        if raw is None or raw == "[DONE]":
            continue
        import json

        parts.append(_content_from_chunk(json.loads(raw)) or "")
    assert "".join(parts).strip() == "show me flights"
