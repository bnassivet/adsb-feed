"""The desktop executor: can a small model run direct UI commands and decline the rest?

    uv run python eval/fastpath_agent/eval_executor.py --model google/gemma-4-e2b
    uv run python eval/fastpath_agent/eval_executor.py --model liquid/lfm2.5-1.2b

The second half of the desktop/agent mechanism (the gate is ``eval_route.py``).
The small model is given ONLY the direct UI tools plus one more,
``handOffToAgent``, and sees every request of the dataset once. No tool is
executed; the first reply's tool calls are read.

What each outcome means:

  for a request the desktop should handle (route = desktop)
    done        made exactly the expected call(s), with the expected argument values
    wrong_args  right tool, but a wrong value, an extra argument or an extra call
                                                   -> the user sees a wrong action
    bad_args    right tool, with arguments its schema rejects
    wrong       called a different UI tool         -> the user sees a wrong action
    handoff     declined                           -> safe: the agent handles it
    nothing     no tool call (text or empty reply) -> forwarded to the agent, like handoff
    error       the model refused, failed or timed out -> forwarded to the agent

  for a request that belongs to the agent (route = agent)
    handoff     declined                           -> correct
    nothing     no tool call                       -> forwarded to the agent: correct
    acted       called a UI tool                   -> HARM: a wrong action, no answer

Printed twice: for the executor alone on every request (how good is its own
judgement), and for the full pipeline, where only requests the embedding gate
passes reach it (``eval_route.py``'s cross-fitted gate).

Argument values are checked against ``expectations.expected_calls`` (dataset v5
onwards; see ``call_matching.py`` for the rules). A record without expected calls
falls back to the schema check alone.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx

if __package__ in (None, ""):  # run as a file: eval/ holds the shared modules
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import DATASET_VERSION, EVAL_DIR, load_tool_surface, overrides_tag, setup_mlflow
from eval_ranker import data_params, load_records, needed_groups, sample_records

# The service's own hand-off tool, prompt and argument check: what is evaluated
# here is what runs.
from adsb_agent.fast_path import HANDOFF, HANDOFF_TOOL, SYSTEM_PROMPT, args_valid
from fastpath_agent.call_matching import calls_match
from fastpath_agent.eval_route import SCOPES, cross_fitted, embed_scores

JSON_PICK_PROMPT = (
    "You control the display of an aircraft-tracking map application. "
    "Pick the ONE tool that carries out the user's message. If the message is not a "
    "direct display command that one of these tools carries out (a question, a request "
    "for information, simulation, scenarios, events, several steps), pick handOffToAgent."
    "\n\nTools:\n{tools}"
)
JSON_ARGS_PROMPT = (
    "Fill in the arguments of the tool `{name}` for the user's message. "
    "Set ONLY what the user asked for; leave every other argument out.\n\n"
    "{name}: {description}"
)


def outcome(
    route: str, expectations: dict, calls: list[dict], schemas: dict, error: str | None = None
) -> str:
    names = [c["name"] for c in calls]
    if error:
        return "error"
    if not names:
        return "nothing"
    if HANDOFF in names:
        return "handoff"
    if route == "agent":
        return "acted"
    needed = {t for g in needed_groups(expectations) for t in g}
    hit = next((c for c in calls if c["name"] in needed), None)
    if hit is None:
        return "wrong"
    if not args_valid(hit["args"], schemas.get(hit["name"])):
        return "bad_args"
    expected_calls = expectations.get("expected_calls")
    if expected_calls is None or len(expected_calls) == 0:
        return "done"  # no argument labels (dataset before v5): schema check only
    return "done" if calls_match(calls, expected_calls) else "wrong_args"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", required=True, help="model id on the OpenAI-compatible server")
    parser.add_argument("--base-url", default="http://localhost:1234/v1")
    parser.add_argument(
        "--reasoning-effort",
        default="none",
        help="'none' turns reasoning off (a thinking model otherwise spends its whole "
        "token budget deliberating and returns nothing); 'default' sends nothing",
    )
    parser.add_argument(
        "--scope",
        choices=sorted(SCOPES),
        default="direct",
        help="which tools the model holds and which requests count as its own: "
        "direct (15 one-step display tools) or ui (all 25 UI action tools)",
    )
    parser.add_argument("--max-tokens", type=int, default=400)
    parser.add_argument("--data", choices=["labels", "dataset"], default="dataset")
    parser.add_argument("--dataset-version", type=int, default=DATASET_VERSION)
    parser.add_argument(
        "--tool-choice",
        choices=["default", "auto", "required"],
        default="default",
        help="'required' forces a tool call, for a model that otherwise replies in text",
    )
    parser.add_argument(
        "--call-style",
        choices=["tools", "json"],
        default="tools",
        help="tools: native tool calls; json: two schema-constrained replies (pick the "
        "tool, then fill its arguments), for a model that has structured output only",
    )
    parser.add_argument(
        "--history-style",
        choices=["turns", "alternate"],
        default="turns",
        help="'alternate' puts a short assistant reply after each earlier request, "
        "for chat templates that require user/assistant alternation",
    )
    parser.add_argument("--timeout", type=float, default=60.0, help="seconds per model request")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--sample", type=int, help="a reproducible random subset of N records")
    args = parser.parse_args()

    os.environ.setdefault("MLFLOW_GENAI_EVAL_MAX_WORKERS", "1")  # one local model, honest latency
    setup_mlflow()
    import mlflow
    from mlflow.genai.scorers import scorer

    surface = load_tool_surface()
    desktop_tools, label, _ = SCOPES[args.scope]
    direct = [t for t in surface if t.name in desktop_tools]
    schemas = {t.name: t.parameters for t in direct}
    tools = [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters or {"type": "object", "properties": {}},
            },
        }
        for t in direct
    ] + [HANDOFF_TOOL]

    all_records = load_records(args.data, None, args.dataset_version)
    # The gate is fitted on the whole dataset even for a --limit run.
    gate_scores, _ = embed_scores(all_records, "with-history", desktop_tools)
    truth = [r["expectations"][label] == "desktop" for r in all_records]
    record_keys = [json.dumps(r["inputs"], sort_keys=True, default=list) for r in all_records]
    gate, _ = cross_fitted([gate_scores], truth, 0.95, keys=record_keys)
    passes = dict(zip(record_keys, gate, strict=True))
    records = all_records[: args.limit] if args.limit else all_records
    records = sample_records(records, args.sample)
    data = data_params(args.data, args.dataset_version)

    client = httpx.Client(timeout=args.timeout)
    rows: list[dict] = []

    def post(body: dict) -> dict:
        resp = client.post(
            f"{args.base_url.rstrip('/')}/chat/completions",
            json=body,
            headers={"Authorization": "Bearer lm-studio"},
        )
        resp.raise_for_status()
        return resp.json()

    def structured(system: str, turns: list[dict], name: str, schema: dict) -> tuple[dict, int]:
        """One reply constrained to a JSON schema; returns (parsed, prompt tokens)."""
        payload = post(
            {
                "model": args.model,
                "temperature": 0,
                "max_tokens": args.max_tokens,
                "stream": False,
                "messages": [{"role": "system", "content": system}, *turns],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": name, "schema": schema},
                },
            }
        )
        text = payload["choices"][0]["message"].get("content") or "{}"
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = {}
        return parsed, (payload.get("usage") or {}).get("prompt_tokens", 0)

    def predict_json(question: str, history: list[str]) -> dict:
        """For a model with structured output but no tool calls: pick, then fill.

        Two constrained replies: the tool name from an enum, then that tool's
        own parameter schema. One tool per request, so a command needing two
        calls cannot be expressed.
        """
        turns = [{"role": "user", "content": h} for h in history]
        turns.append({"role": "user", "content": question})
        listing = "\n".join(
            f"- {t['function']['name']}: {t['function']['description']}" for t in tools
        )
        started = time.perf_counter()
        pick, tokens = structured(
            JSON_PICK_PROMPT.format(tools=listing),
            turns,
            "pick",
            {
                "type": "object",
                "properties": {
                    "tool": {"type": "string", "enum": [t["function"]["name"] for t in tools]}
                },
                "required": ["tool"],
            },
        )
        name = pick.get("tool")
        calls = []
        if name:
            spec = next(t["function"] for t in tools if t["function"]["name"] == name)
            call_args: dict = {}
            if name != HANDOFF and (spec["parameters"].get("properties") or {}):
                call_args, more = structured(
                    JSON_ARGS_PROMPT.format(name=name, description=spec["description"]),
                    turns,
                    "arguments",
                    spec["parameters"],
                )
                tokens += more
            calls.append({"name": name, "args": call_args})
        return {
            "calls": calls,
            "text": "",
            "finish_reason": "stop",
            "input_tokens": tokens,
            "latency_s": round(time.perf_counter() - started, 2),
        }

    def predict(question: str, history=None) -> dict:
        """One request, never raising: a model failure is an outcome, not a gap.

        A refusal (Apple's model answers some harmless commands with "safety
        guardrails were triggered") or a hang must count against the model as a
        request it did not handle. Raising would drop the record, and MLflow
        would average over the survivors.
        """
        history = list(history or [])
        started = time.perf_counter()
        try:
            if args.call_style == "json":
                return predict_json(question, history)
            return predict_tools(question, history)
        except httpx.HTTPError as e:
            detail = ""
            if isinstance(e, httpx.HTTPStatusError):
                detail = e.response.text[:200]
            return {
                "calls": [],
                "text": "",
                "error": f"{type(e).__name__}: {detail or e}".strip(": "),
                "finish_reason": "error",
                "input_tokens": 0,
                "latency_s": round(time.perf_counter() - started, 2),
            }

    def predict_tools(question: str, history: list[str]) -> dict:
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for h in history:
            messages.append({"role": "user", "content": h})
            if args.history_style == "alternate":
                # Mistral's chat template rejects two user messages in a row
                # (HTTP 500 from the server, for every record with history).
                messages.append({"role": "assistant", "content": "Done."})
        messages.append({"role": "user", "content": question})
        body = {
            "model": args.model,
            "temperature": 0,
            "max_tokens": args.max_tokens,
            "messages": messages,
            "tools": tools,
            # Said explicitly: some servers stream unless told not to, and the
            # MLflow gateway then rejects the reply (502, text/event-stream).
            "stream": False,
        }
        if args.tool_choice != "default":
            body["tool_choice"] = args.tool_choice
        if args.reasoning_effort != "default":
            body["reasoning_effort"] = args.reasoning_effort
        started = time.perf_counter()
        resp = client.post(
            f"{args.base_url.rstrip('/')}/chat/completions",
            json=body,
            headers={"Authorization": "Bearer lm-studio"},
        )
        resp.raise_for_status()
        latency = time.perf_counter() - started
        payload = resp.json()
        message = payload["choices"][0]["message"]
        calls = []
        for tc in message.get("tool_calls") or []:
            try:
                parsed = json.loads(tc["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                parsed = {"_unparseable": tc["function"].get("arguments")}
            calls.append({"name": tc["function"]["name"], "args": parsed})
        return {
            "calls": calls,
            "text": (message.get("content") or "")[:300],
            "finish_reason": payload["choices"][0].get("finish_reason"),
            "input_tokens": (payload.get("usage") or {}).get("prompt_tokens", 0),
            "latency_s": round(latency, 2),
        }

    @scorer(name="outcome")
    def outcome_scorer(inputs, outputs, expectations) -> str:
        result = outcome(
            expectations[label], expectations, outputs["calls"], schemas, outputs.get("error")
        )
        rows.append(
            {
                "question": inputs["question"],
                "history": list(inputs.get("history") or []),
                "route": expectations[label],
                "outcome": result,
                "error": outputs.get("error"),
                "gate_passes": passes[
                    json.dumps(
                        {
                            "question": inputs["question"],
                            "history": list(inputs.get("history") or []),
                        },
                        sort_keys=True,
                    )
                ],
                **outputs,
            }
        )
        return result

    @scorer
    def latency_s(outputs) -> float:
        return outputs["latency_s"]

    safe_name = f"{args.scope}-" + args.model.replace("/", "_") + overrides_tag()
    if args.tool_choice != "default":
        safe_name += f"-tool_{args.tool_choice}"
    if args.call_style != "tools":
        safe_name += f"-{args.call_style}"
    with mlflow.start_run(run_name=f"executor-{safe_name}"):
        mlflow.log_params(
            {
                "stage": "E-executor",
                "model": args.model,
                "scope": args.scope,
                "reasoning_effort": args.reasoning_effort,
                "tool_choice": args.tool_choice,
                "call_style": args.call_style,
                "base_url": args.base_url,
                "tools": len(tools),
                "records": len(records),
                **data,
            }
        )
        mlflow.genai.evaluate(data=records, predict_fn=predict, scorers=[outcome_scorer, latency_s])

        def tally(subset: list[dict]) -> dict[str, collections.Counter]:
            counts = {"desktop": collections.Counter(), "agent": collections.Counter()}
            for row in subset:
                counts[row["route"]][row["outcome"]] += 1
            return counts

        def show(title: str, subset: list[dict]) -> dict[str, float]:
            counts = tally(subset)
            d, a = counts["desktop"], counts["agent"]
            nd, na = sum(d.values()), sum(a.values())
            print(f"\n{title}")
            print(
                f"  desktop requests ({nd}): done {d['done']}, wrong_args {d['wrong_args']}, "
                f"bad_args {d['bad_args']}, wrong {d['wrong']}, handoff {d['handoff']}, "
                f"nothing {d['nothing']}, error {d['error']}"
            )
            print(
                f"  agent requests   ({na}): handoff {a['handoff']}, acted {a['acted']}, "
                f"nothing {a['nothing']}, error {a['error']}"
            )
            # A reply with no tool call is forwarded to the agent, like a hand-off,
            # so it is not harm: only an action actually taken can be wrong.
            harm = d["wrong"] + d["wrong_args"] + d["bad_args"] + a["acted"]
            return {
                "done": d["done"],
                "harm": harm,
                "desktop_done_rate": d["done"] / nd if nd else 0.0,
                "agent_declined_rate": a["handoff"] / na if na else 0.0,
            }

        alone = show("EXECUTOR ALONE (sees every request)", rows)
        gated = show(
            "WITH THE EMBEDDING GATE (sees only what the gate passes)",
            [r for r in rows if r["gate_passes"]],
        )
        total = len(rows)
        desktop_total = sum(r["route"] == "desktop" for r in rows)
        print(
            f"\n  pipeline, out of {total} requests: {gated['done']} handled on the desktop "
            f"({gated['done'] / desktop_total:.0%} of the {desktop_total} direct commands), "
            f"{gated['harm']} WRONG ACTIONS ({gated['harm'] / total:.1%} of all requests), "
            f"the rest forwarded to the agent"
        )
        latencies = [r["latency_s"] for r in rows]
        tokens = [r["input_tokens"] for r in rows]
        print(
            f"  latency median {statistics.median(latencies):.2f} s "
            f"(p90 {statistics.quantiles(latencies, n=10)[8]:.2f} s), "
            f"input tokens median {statistics.median(tokens):.0f}"
        )
        mlflow.log_metrics(
            {
                "alone_desktop_done_rate": alone["desktop_done_rate"],
                "alone_agent_declined_rate": alone["agent_declined_rate"],
                "alone_harm": alone["harm"],
                "pipeline_done": gated["done"],
                "pipeline_harm": gated["harm"],
                "pipeline_desktop_handled_rate": gated["done"] / desktop_total,
                "pipeline_harm_rate": gated["harm"] / total,
                "latency_s_p50": statistics.median(latencies),
            }
        )

    out_dir = EVAL_DIR / "results"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"executor-{safe_name}.jsonl"
    out_path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    print(f"  per-record results: {out_path}")


if __name__ == "__main__":
    main()
