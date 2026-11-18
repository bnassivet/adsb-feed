"""Does the model server reuse a cached prompt prefix, and what breaks it?

    uv run python eval/cache_experiment.py
    uv run python eval/cache_experiment.py --model google/gemma-4-12b-qat --trials 5

Shrinking the agent's prompt per turn did not make turns faster (see README).
The suspected reason: a local server keeps the state of the previous prompt and
only processes what differs from it, so a long but STABLE prefix is nearly free
while a shorter prefix that changes every turn is processed in full.

Each trial sends a **primer** request, then the **test** request, and times the
test: time to first token (prompt processing) and total. The primer puts the
server's cache in a known state; what varies is how much of the test prompt
matches the primer from the start.

  cold            nothing matches (a nonce at the very start of the prompt)
  identical       the same request again
  new-question    same tools, same system prompt; only the user message differs
  state-changed   today's layout: one UI-state value changes in the system prompt
  tools-changed   a different 10-tool subset, as a per-turn tool ranker produces
  state-last      proposed layout: UI state moved out of the system prompt into
                  the final user message, and changed

Requests go straight to the OpenAI-compatible server (LM Studio), streaming, so
the first token can be timed. The system prompt and tools are the agent's own.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import uuid
from types import SimpleNamespace

import httpx
from common import load_tool_surface, setup_mlflow

from adsb_agent.graph import _to_openai_tools
from adsb_agent.server_tools import SERVER_TOOL_NAMES
from langchain_core.messages import HumanMessage

from adsb_agent.system_prompt import attach_context, render_system_prompt

QUESTIONS = [
    "how many aircraft per hour on the last 12 hours?",
    "what is the highest aircraft right now?",
    "switch to night mode",
    "how was the traffic today?",
    "what is the wind at FL350 over the receiver?",
    "show the history tracks for the last 6 hours",
    "how many active tracks?",
    "describe the trajectory of the selected track",
]


def ui_state(track_count: int) -> list[SimpleNamespace]:
    """Ambient context like the desktop sends (made-up values)."""
    entries = [
        ("Active mode (live or analysis)", "live"),
        (
            "Selected aircraft (hex idents) and the most recently selected one",
            '{"selected":[],"lastSelected":null}',
        ),
        (
            "Active aircraft filters (callsign, altitude range, speed range)",
            '{"callsign":"","altitudeMin":0,"altitudeMax":50000,"speedMin":0,"speedMax":600}',
        ),
        ("Map theme and sidebar state", '{"mapTheme":"dark","sidebarOpen":true}'),
        (
            "Visible map layers",
            '{"positions":true,"labels":true,"rangeLines":false,"history":false,"density":true}',
        ),
        ("History layer time window", '{"retentionHours":48,"fromHoursAgo":48,"toHoursAgo":0}'),
        ("Live aircraft track count", json.dumps({"trackCount": track_count})),
        ("Database storage availability", "available"),
        ("Receiver (antenna) location as lat/lng", "48.0, -2.0"),
    ]
    return [SimpleNamespace(description=d, value=v) for d, v in entries]


class Bench:
    def __init__(self, base_url: str, model: str, max_tokens: int):
        self.url = f"{base_url.rstrip('/')}/chat/completions"
        self.model = model
        self.max_tokens = max_tokens
        self.client = httpx.Client(timeout=300.0)

    def send(self, system: str, user: str | list[dict], tools: list[dict]) -> dict:
        """``user`` is one user message, or the whole conversation after the system prompt."""
        turns = [{"role": "user", "content": user}] if isinstance(user, str) else user
        body = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": self.max_tokens,
            "reasoning_effort": "none",
            "stream": True,
            "stream_options": {"include_usage": True},
            "messages": [{"role": "system", "content": system}, *turns],
            "tools": tools,
        }
        started = time.perf_counter()
        first = None
        usage: dict = {}
        with self.client.stream(
            "POST", self.url, json=body, headers={"Authorization": "Bearer lm-studio"}
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                chunk = json.loads(line[6:])
                if chunk.get("usage"):
                    usage = chunk["usage"]
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    if first is None and (delta.get("content") or delta.get("tool_calls")):
                        first = time.perf_counter() - started
        total = time.perf_counter() - started
        return {
            "ttft_s": first if first is not None else total,
            "total_s": total,
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", default="http://localhost:1234/v1")
    parser.add_argument("--model", default="google/gemma-4-12b-qat")
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--max-tokens", type=int, default=48)
    parser.add_argument("--cases", nargs="+", help="run only these cases")
    args = parser.parse_args()

    surface = load_tool_surface()
    client_tools = [t for t in surface if t.name not in SERVER_TOOL_NAMES]
    all_tools = _to_openai_tools(surface)
    bench = Bench(args.base_url, args.model, args.max_tokens)

    def today(track_count: int) -> str:
        """The agent's current layout: UI state inside the system prompt."""
        return render_system_prompt(client_tools, ui_state(track_count))

    static_system = render_system_prompt(client_tools, None)

    def state_last(track_count: int, question: str) -> str:
        """Proposed layout: UI state travels with the user message instead."""
        return attach_context([HumanMessage(content=question)], ui_state(track_count))[0].content

    def subset(seed: int) -> tuple[str, list[dict]]:
        """A 10-tool selection and the matching (shorter) system prompt."""
        picked = [t for i, t in enumerate(surface) if (i * 7 + seed) % 4 == 0][:10]
        return (
            render_system_prompt(client_tools, ui_state(12), bound_tools=picked),
            _to_openai_tools(picked),
        )

    def cases(i: int):
        q1, q2 = QUESTIONS[i % len(QUESTIONS)], QUESTIONS[(i + 3) % len(QUESTIONS)]
        s1a, t1 = subset(i)
        s1b, t2 = subset(i + 1)
        # name: (primer (system, user, tools), test (system, user, tools))
        return {
            "cold": (
                (today(12), q1, all_tools),
                (f"[{uuid.uuid4()}]\n" + today(12), q2, all_tools),
            ),
            "identical": ((today(12), q1, all_tools), (today(12), q1, all_tools)),
            "new-question": ((today(12), q1, all_tools), (today(12), q2, all_tools)),
            "state-changed": ((today(12), q1, all_tools), (today(13 + i), q2, all_tools)),
            "tools-changed": ((s1a, q1, t1), (s1b, q2, t2)),
            "state-last": (
                (static_system, state_last(12, q1), all_tools),
                (static_system, state_last(13 + i, q2), all_tools),
            ),
            # The second turn of a conversation. The first request no longer
            # carries its state (only the latest one does), so the prompts
            # part ways there -- after the system prompt and the tools.
            "second-turn": (
                (static_system, state_last(12, q1), all_tools),
                (
                    static_system,
                    [
                        {"role": "user", "content": q1},
                        {"role": "assistant", "content": "Done."},
                        {"role": "user", "content": state_last(13 + i, q2)},
                    ],
                    all_tools,
                ),
            ),
        }

    print(f"model {args.model} at {args.base_url}; warming up (loads the model if needed)...")
    bench.send(today(12), QUESTIONS[0], all_tools)

    results: dict[str, list[dict]] = {}
    for i in range(args.trials):
        for name, (primer, test) in cases(i).items():
            if args.cases and name not in args.cases:
                continue
            bench.send(*primer)
            results.setdefault(name, []).append(bench.send(*test))
        print(f"  trial {i + 1}/{args.trials} done")

    print(
        f"\n{'case':<15} {'prompt tokens':>14} {'cached tokens':>14} "
        f"{'first token, median (min-max)':>32} {'total, median':>14}"
    )
    summary = {}
    for name, runs in results.items():
        ttft = [r["ttft_s"] for r in runs]
        total = [r["total_s"] for r in runs]
        cached = [r["cached_tokens"] for r in runs if r["cached_tokens"] is not None]
        summary[name] = statistics.median(ttft)
        print(
            f"{name:<15} {statistics.median(r['prompt_tokens'] for r in runs):>14.0f} "
            f"{(f'{statistics.median(cached):.0f}' if cached else 'n/a'):>14} "
            f"{statistics.median(ttft):>17.2f} s ({min(ttft):.2f}-{max(ttft):.2f}) "
            f"{statistics.median(total):>12.2f} s"
        )

    setup_mlflow()
    import mlflow

    with mlflow.start_run(run_name=f"cache-{args.model.replace('/', '_')}"):
        mlflow.log_params(
            {
                "stage": "F-cache",
                "model": args.model,
                "trials": args.trials,
                "base_url": args.base_url,
                "max_tokens": args.max_tokens,
            }
        )
        mlflow.log_metrics({f"ttft_s_{k.replace('-', '_')}": v for k, v in summary.items()})


if __name__ == "__main__":
    main()
